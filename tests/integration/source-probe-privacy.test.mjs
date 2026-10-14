import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createBossProvider } from "../../src/sources/adapters/boss.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";

for (const code of [
  "boss_ajax_unavailable",
  "boss_transport_failed",
  "collection_browser_timeout",
])
  test(`owned Boss probe links ${code} to a private-content-free diagnostic`, async (t) => {
    const provider = createBossProvider(),
      f = await collectionFixture(t, { providers: [provider] });
    const c = await f.openCommit();
    await c.lease.release();
    await f.service.pause(c.ref);
    await f.repository.mutateWorkspace((w) => {
      w.packages[f.scope.packageId].collectionSettings = {
        sourceOverrides: {},
        sessionRefs: { boss: "synthetic-session" },
        refreshEnabled: false,
      };
    });
    const diagnostics = createDiagnosticsLog({
      dataDir: f.dataDir,
      clock: f.clock,
    });
    const service = createSourceService({
      repository: f.repository,
      operationGate: f.operationGate,
      clock: f.clock,
      registry: createSourceRegistry([provider]),
      diagnostics,
      catalog: [{ siteId: "boss", providerId: "boss" }],
      activityContext: (ref, action) =>
        f.service.withDiagnosticContext(
          { ref, requestId: "probe-diagnostic" },
          (ctx) =>
            action({
              ...ctx,
              readService: {
                readBoss: async () => {
                  if (code === "collection_browser_timeout")
                    throw Object.assign(Error(canary), { code, phase: "load" });
                  return { status: 0, code, message: canary };
                },
              },
            }),
        ),
    });
    const result = await service.probeScopedSource({
      scope: f.scope,
      sourceId: "boss",
      ref: c.ref,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.issues[0].code, code);
    assert.match(result.issues[0].diagnosticId, /^d-[a-f0-9-]{36}$/);
    const w = await f.repository.read();
    const saved =
      w.packages[f.scope.packageId].collectionSettings.sourceVerification[
        "boss/boss"
      ];
    assert.equal(saved.issues[0].diagnosticId, result.issues[0].diagnosticId);
    assert.equal(
      w.packages[f.otherScope.packageId].collectionSettings
        ?.sourceVerification?.["boss/boss"],
      undefined,
    );
    assert.equal(w.sourceHealth["boss/boss"], undefined);
    assert.equal(w.runs[c.ref.activityId].collectionProgress.status, "paused");
    const log = await diagnostics.list();
    const entry = log.entries.find(
      (e) => e.diagnosticId === result.issues[0].diagnosticId,
    );
    assert.equal(entry.operation, "source.probe");
    assert.equal(entry.error.code, code);
    if (code === "collection_browser_timeout")
      assert.equal(entry.phase, "load");
    assert.equal(JSON.stringify([result, saved, log]).includes(canary), false);
    assert.equal(f.networkCalls, 0);
  });

const canary = "synthetic private upstream body and query";
const issues = () => [
  {
    code: "parse_error",
    sourceId: canary,
    siteId: canary,
    message: canary,
    retryable: false,
    raw: { body: canary, apiKey: canary },
  },
  { code: canary, message: canary, diagnosticId: canary },
];
function assertSafe(result) {
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(result.issues[0].code, "parse_error");
  assert.equal(result.issues[0].sourceId, "synthetic");
  assert.equal(result.issues[0].siteId, "synthetic-1");
  assert.equal(result.issues[0].retryable, false);
  assert.equal(result.issues[1].code, "source_probe_failed");
  for (const issue of result.issues) {
    assert.ok(
      Object.keys(issue).every((key) =>
        ["code", "sourceId", "siteId", "retryable", "diagnosticId"].includes(
          key,
        ),
      ),
    );
  }
}

test("the global source probe HTTP response only exposes safe issue metadata", async (t) => {
  const provider = fakeProvider();
  provider.probe = async () => ({
    status: "parse_error",
    sampleCount: 0,
    issues: issues(),
  });
  const f = await apiFixture(t, {
    providers: [provider],
    dependencies: { startScheduler: false },
  });
  const probe = await f.call("/api/v2/sources/synthetic/probe", {
    siteId: "synthetic-1",
  });
  assert.equal(probe.response.status, 200);
  assert.equal(probe.data.status, "parse_error");
  assertSafe(probe.data);
  assert.match(probe.data.issues[0].diagnosticId, /^d-[a-f0-9-]{36}$/);
  const ctx = await f.ctx.ready;
  assert.equal(
    JSON.stringify(await ctx.repository.read()).includes(canary),
    false,
  );
  assert.equal(
    JSON.stringify(await ctx.diagnostics.list()).includes(canary),
    false,
  );
});

test("version scoped probes apply the same safe issue projection", async (t) => {
  const f = await packageBusinessFixture(t);
  const { a } = await f.twoTargets();
  const provider = fakeProvider();
  provider.collect = async () => ({ records: [], issues: issues() });
  const service = createSourceService({
    repository: f.repository,
    operationGate: f.operationGate,
    registry: createSourceRegistry([provider]),
    catalog: [
      {
        siteId: "synthetic-1",
        providerId: "synthetic",
        name: "合成来源",
        origin: "https://jobs.example.org",
      },
    ],
    clock: f.clock,
    requestFactory: () => async () => {
      throw Error("Unexpected network");
    },
  });
  const result = await service.probeScopedSource({
    scope: { packageId: a.packageId, targetRevisionId: a.revisionId },
    sourceId: "synthetic",
    siteId: "synthetic-1",
  });
  assertSafe(result);
  assert.equal(result.status, "parse_error");
  assert.equal(result.issues.at(-1).code, "list_unverified");
  assert.equal(
    JSON.stringify(await f.repository.read()).includes(canary),
    false,
  );
});
