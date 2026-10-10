import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";

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
  assert.equal(result.status, "empty");
  assert.equal(result.issues.at(-1).code, "list_unverified");
  assert.equal(
    JSON.stringify(await f.repository.read()).includes(canary),
    false,
  );
});
