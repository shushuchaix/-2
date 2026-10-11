import test from "node:test";
import assert from "node:assert/strict";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createSourceBudget } from "../../src/infrastructure/http/budget.mjs";
import { probeCapabilities } from "../../tools/probe-sources-v2.mjs";
import officialAnnouncements from "../../src/sources/adapters/official-announcements.mjs";

for (const [code, status] of [
  ["source_budget_exhausted", "budget_exhausted"],
  ["request_timeout", "unavailable"],
  ["parse_error", "parse_error"],
]) {
  test(`scoped and CLI probes retain ${code} instead of claiming an empty source`, async (t) => {
    const f = await packageBusinessFixture(t),
      { a } = await f.twoTargets();
    const provider = fakeProvider();
    provider.collect = async () => ({
      records: [],
      issues: [{ code, message: "private upstream body" }],
    });
    const site = {
      siteId: "synthetic-1",
      providerId: "synthetic",
      name: "合成",
      origin: "https://example.org",
    };
    const service = createSourceService({
      repository: f.repository,
      registry: createSourceRegistry([provider]),
      catalog: [site],
      clock: f.clock,
      operationGate: f.operationGate,
      requestFactory: () => async () => {
        throw Error("No network");
      },
    });
    const result = await service.probeScopedSource({
      scope: { packageId: a.packageId, targetRevisionId: a.revisionId },
      sourceId: "synthetic",
      siteId: site.siteId,
    });
    assert.equal(result.status, status);
    const saved = (await f.repository.read()).sourceHealth[
      "synthetic/synthetic-1"
    ];
    assert.equal(saved.status, status);
    assert.equal(saved.issues[0].code, code);
    assert.equal(JSON.stringify(saved).includes("private"), false);
    const cli = await probeCapabilities(provider, site, {
      budget: createSourceBudget(),
      request: async () => {
        throw Error("No network");
      },
      clock: f.clock,
    });
    assert.equal(cli.status, status);
  });
}

test("default provider probes associate their result with the actual first directory site", async (t) => {
  const f = await packageBusinessFixture(t),
    provider = fakeProvider();
  provider.probe = async (ctx) => ({
    status: "ready",
    sampleCount: 1,
    issues: [],
    passedSite: ctx.sites[0]?.siteId,
  });
  const service = createSourceService({
    repository: f.repository,
    registry: createSourceRegistry([provider]),
    catalog: [{ siteId: "synthetic-1", providerId: "synthetic" }],
    clock: f.clock,
    requestFactory: () => async () => {
      throw Error("No network");
    },
  });
  const result = await service.probe("synthetic");
  assert.equal(result.siteId, "synthetic-1");
  const w = await f.repository.read();
  assert.equal(w.sourceHealth["synthetic/synthetic-1"].status, "ready");
  assert.equal(w.sourceHealth["synthetic/synthetic"], undefined);
});
test("a thrown scoped network error is persisted as a failed check", async (t) => {
  const f = await packageBusinessFixture(t),
    { a } = await f.twoTargets(),
    provider = fakeProvider();
  provider.collect = async () => {
    throw Object.assign(Error("private body"), { code: "request_timeout" });
  };
  const service = createSourceService({
    repository: f.repository,
    operationGate: f.operationGate,
    registry: createSourceRegistry([provider]),
    catalog: [{ siteId: "synthetic-1", providerId: "synthetic" }],
    clock: f.clock,
    requestFactory: () => async () => {
      throw Error("No network");
    },
  });
  const result = await service.probeScopedSource({
    scope: { packageId: a.packageId, targetRevisionId: a.revisionId },
    sourceId: "synthetic",
    siteId: "synthetic-1",
  });
  assert.equal(result.status, "unavailable");
  assert.equal(
    (await f.repository.read()).sourceHealth["synthetic/synthetic-1"].issues[0]
      .code,
    "request_timeout",
  );
  assert.equal(JSON.stringify(result).includes("private"), false);
});
test("a thrown global probe error persists safe failure metadata before returning the error", async (t) => {
  const f = await packageBusinessFixture(t),
    provider = fakeProvider();
  provider.probe = async () => {
    throw Object.assign(Error("private body"), { code: "request_timeout" });
  };
  const service = createSourceService({
    repository: f.repository,
    registry: createSourceRegistry([provider]),
    catalog: [{ siteId: "synthetic-1", providerId: "synthetic" }],
    clock: f.clock,
    requestFactory: () => async () => {
      throw Error("No network");
    },
  });
  await assert.rejects(service.probe("synthetic"), { code: "request_timeout" });
  const saved = (await f.repository.read()).sourceHealth[
    "synthetic/synthetic-1"
  ];
  assert.equal(saved.status, "unavailable");
  assert.equal(saved.issues[0].code, "request_timeout");
  assert.equal(JSON.stringify(saved).includes("private"), false);
});
test("missing official announcement templates are a configuration gap and use no requests", async () => {
  let requests = 0;
  const result = await probeCapabilities(
    officialAnnouncements,
    {
      providerId: "official-announcements",
      siteId: "candidate",
      origin: "https://example.org",
    },
    {
      budget: createSourceBudget(),
      request: async () => {
        requests++;
        throw Error("Unexpected network");
      },
    },
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.issues[0].code, "template_not_configured");
  assert.equal(requests, 0);
});
test("social probes require a target version and cannot create shared account history", async (t) => {
  const f = await packageBusinessFixture(t),
    provider = fakeProvider({ id: "wechat" });
  const service = createSourceService({
    repository: f.repository,
    registry: createSourceRegistry([provider]),
    catalog: [{ siteId: "wechat", providerId: "wechat" }],
    clock: f.clock,
    requestFactory: () => async () => {
      throw Error("No network");
    },
  });
  await assert.rejects(service.probe("wechat"), {
    code: "source_scope_required",
  });
  assert.deepEqual((await f.repository.read()).sourceHealth, {});
});
