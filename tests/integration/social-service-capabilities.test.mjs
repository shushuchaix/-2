import test from "node:test";
import assert from "node:assert/strict";
import {
  probeReadService,
  enableReadService,
  createWeiboCapabilityRunner,
} from "../../src/infrastructure/collection/service-capabilities.mjs";
import weiboOfficial from "../../src/sources/adapters/weibo-official.mjs";
import wechatAuthorized from "../../src/sources/adapters/wechat-authorized.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { normalizeCollectionWorkspace } from "../../src/domain/collection.mjs";
const scope = { packageId: "p-a", targetRevisionId: "a@1" };
test("unconfigured service performs zero requests and never disables public web readers", async () => {
  let calls = 0;
  const runner = createWeiboCapabilityRunner({
    request: async () => {
      calls++;
    },
  });
  const result = await probeReadService({ scope, platform: "weibo", runner });
  assert.equal(calls, 0);
  assert.equal(result.configured, false);
  assert.equal(weiboOfficial.defaultConfig.enabled, false);
  assert.equal(wechatAuthorized.defaultConfig.enabled, false);
});
test("doctor exit success is not account readiness; only reviewed read commands survive", async () => {
  const result = await probeReadService({
    scope,
    platform: "weibo",
    credentialRef: "owned",
    runner: {
      run: async ({ operation }) =>
        operation === "doctor"
          ? { ready: false }
          : {
              commands: [
                { group: "statuses", action: "destroy", access: "allowed" },
              ],
            },
    },
  });
  assert.deepEqual(result.availableReadCommands, []);
  assert.equal(result.bodyCapability, false);
  assert.equal(result.automaticCalls, 0);
});
test("actual account metadata is whitelisted and unknown quota never authorizes automatic calls", async () => {
  const urls = [];
  const runner = createWeiboCapabilityRunner({
    credentialStore: {
      resolve: async () => ({
        ownerPackageId: "p-a",
        platform: "weibo",
        accessToken: "private-test-token",
      }),
    },
    request: async (url, options) => {
      urls.push(url);
      assert.equal(options.headers.Authorization, "Bearer private-test-token");
      assert.equal(options.method, "GET");
      const data = url.includes("whoami")
        ? {
            user: {
              developer_identity: { is_verified: true },
              privateName: "private-user",
            },
            service_status: { kind: "trial_active" },
          }
        : url.includes("?")
          ? {
              commands: [
                {
                  group: "search",
                  action: "statuses/limited",
                  access: "allowed",
                },
                { group: "statuses", action: "destroy", access: "allowed" },
              ],
            }
          : {
              command: {
                group: "search",
                action: "statuses/limited",
                price_type: "per_record",
                pricing: { configured: true, unit_price: 0 },
              },
            };
      return { status: 200, text: JSON.stringify(data) };
    },
  });
  const result = await probeReadService({
    scope,
    platform: "weibo",
    credentialRef: "owned",
    runner,
  });
  assert.equal(urls.length, 3);
  assert.deepEqual(result.availableReadCommands, ["search/statuses/limited"]);
  assert.equal(result.quota.status, "unknown");
  assert.equal(result.bodyCapability, false);
  assert.equal(result.automaticCalls, 0);
  assert.equal(JSON.stringify(result).includes("private-"), false);
  await assert.rejects(
    () =>
      enableReadService({
        scope,
        serviceId: "weibo-official",
        confirmedCapability: result,
        paidServiceAcknowledged: true,
      }),
    { code: "service_quota_unknown" },
  );
});
test("credential ownership and public command whitelist reject external account or write operation before sending", async () => {
  let calls = 0;
  const runner = createWeiboCapabilityRunner({
    credentialStore: {
      resolve: async () => ({
        ownerPackageId: "p-b",
        platform: "weibo",
        accessToken: "secret",
      }),
    },
    request: async () => {
      calls++;
    },
  });
  await assert.rejects(
    () => runner.run({ scope, credentialRef: "other", operation: "doctor" }),
    { code: "service_credential_scope" },
  );
  await assert.rejects(
    () =>
      runner.run({
        scope,
        credentialRef: "other",
        operation: "show_read_command",
        commandId: "statuses/destroy",
      }),
    { code: "service_command_forbidden" },
  );
  assert.equal(calls, 0);
});
test("own wechat publication permission does not prove an unrelated public account can be read", async () => {
  const result = await probeReadService({
    scope,
    platform: "wechat",
    credentialRef: "own",
    runner: {
      run: async () => ({
        ready: true,
        authorizedAccounts: ["own-account"],
        requestedAccount: "other-account",
        bodyVerified: true,
      }),
    },
  });
  assert.equal(result.bodyCapability, false);
  assert.equal(result.automaticCalls, 0);
});
test("optional capability proof is private, cannot enable a service, and is revoked by restore", async (t) => {
  const f = await packageBusinessFixture(t),
    { a, b } = await f.twoTargets(),
    owned = { packageId: a.packageId, targetRevisionId: a.revisionId },
    other = { packageId: b.packageId, targetRevisionId: b.revisionId };
  const service = createSourceService({
    repository: f.repository,
    operationGate: f.operationGate,
    registry: createSourceRegistry([weiboOfficial, wechatAuthorized]),
    requestFactory: () => async () => {
      throw Error("No network permitted");
    },
  });
  const proof = await service.probeOptionalReadService({
    scope: owned,
    serviceId: "weibo-official",
  });
  assert.equal(proof.configured, false);
  assert.equal(
    (await service.listScopedSources({ scope: other }))[0].serviceCapability,
    null,
  );
  await assert.rejects(
    () =>
      service.enableOptionalReadService({
        scope: owned,
        serviceId: "weibo-official",
        proofId: "forged",
      }),
    { code: "service_capability_expired" },
  );
  await assert.rejects(
    () =>
      service.enableOptionalReadService({
        scope: owned,
        serviceId: "weibo-official",
        proofId: proof.proofId,
      }),
    { code: "service_quota_unknown" },
  );
  await assert.rejects(
    () =>
      service.saveScopedConfig({
        scope: owned,
        sourceId: "weibo-official",
        config: { enabled: true },
      }),
    { code: "invalid_input" },
  );
  const w = await f.repository.read();
  assert.equal(w.settings.sourceOverrides["weibo-official"], undefined);
  normalizeCollectionWorkspace(w, { clearSessions: true });
  assert.deepEqual(
    w.packages[owned.packageId].collectionSettings.serviceCapabilities,
    {},
  );
});
