import test from "node:test";
import assert from "node:assert/strict";
import { discoverSourceCandidates } from "../../src/sources/discovery.mjs";
import { assessSourceProbe } from "../../src/sources/source-quality.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
test("discovery_is_bounded_and_only_follows_public_official_or_linked_known_ats", async () => {
  const calls = [],
    request = async (url) => {
      calls.push(url);
      return {
        status: 200,
        text:
          '<a href="/jobs/next' +
          calls.length +
          '">人才招聘</a><a href="https://school.91job.org.cn/sub-station/home/10290">就业平台</a><a href="http://127.0.0.1/private">招聘</a><a href="https://unrelated.example.org/careers">人才招聘</a>',
      };
    };
  const candidates = await discoverSourceCandidates({
    seed: { url: "https://official.example.org/", name: "合成官方" },
    request,
    maxDepth: 2,
    maxUrls: 5,
  });
  assert.ok(calls.length <= 5);
  assert.ok(
    candidates.every(
      (c) => c.depth <= 2 && c.status === "candidate" && c.verifiedAt === null,
    ),
  );
  assert.ok(
    !calls.some(
      (url) => url.includes("127.0.0.1") || url.includes("unrelated"),
    ),
  );
  assert.ok(
    candidates.some(
      (c) => c.providerId === "university-91job" && c.tenantId === "10290",
    ),
  );
});
test("probe_distinguishes_capabilities_and_never_promotes_empty_search_or_blocked_pages", () => {
  const site = { siteId: "s", providerId: "p" };
  const empty = assessSourceProbe({
    site,
    listSample: { status: 200, records: [] },
    detailSample: [],
    now: Date.now(),
  });
  assert.equal(empty.capabilities.body, "unverified");
  const search = assessSourceProbe({
    site,
    listSample: {
      status: 200,
      records: [
        {
          title: "线索",
          kind: "recruitment_notice",
          detailStatus: "discovery_only",
        },
      ],
    },
    detailSample: [],
    now: Date.now(),
  });
  assert.equal(search.verification, "candidate");
  const blocked = assessSourceProbe({
    site,
    listSample: { status: 403, records: [] },
    detailSample: [],
    now: Date.now(),
  });
  assert.equal(blocked.verification, "restricted");
});
test("source_settings_are_owned_and_private_account_options_cannot_enter_global_settings", async (t) => {
  const f = await packageBusinessFixture(t),
    { a, b } = await f.twoTargets(),
    scope = { packageId: a.packageId, targetRevisionId: a.revisionId },
    other = { packageId: b.packageId, targetRevisionId: b.revisionId };
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({ records: [], hasMore: false }),
  });
  provider.configSchema = { enabled: "boolean", accountIds: "array" };
  const service = createSourceService({
    repository: f.repository,
    operationGate: f.operationGate,
    registry: createSourceRegistry([provider]),
    requestFactory: () => async () => {
      throw Error("No network");
    },
  });
  await service.saveScopedConfig({
    scope,
    sourceId: "synthetic",
    config: { enabled: true, accountIds: ["public-account"] },
  });
  assert.deepEqual(
    (await service.listScopedSources({ scope }))[0].config.accountIds,
    ["public-account"],
  );
  assert.equal(
    (await service.listScopedSources({ scope: other }))[0].config.accountIds,
    undefined,
  );
  assert.equal(
    (await f.repository.read()).settings.sourceOverrides.synthetic,
    undefined,
  );
  await assert.rejects(
    service.saveSourceConfig({
      sourceId: "synthetic",
      config: { accountIds: ["public-account"] },
    }),
    (e) => e.code === "invalid_input" && /全局/.test(e.fieldErrors.config),
  );
  await assert.rejects(
    service.saveScopedConfig({
      scope,
      sourceId: "synthetic",
      config: { authorization: "secret" },
    }),
    (e) =>
      e.code === "invalid_input" && /凭据/.test(e.fieldErrors.authorization),
  );
});
