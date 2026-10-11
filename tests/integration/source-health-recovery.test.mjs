import test from "node:test";
import assert from "node:assert/strict";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { job } from "../helpers/fixtures.mjs";

function recoveredWorkspace({
  failed = false,
  kind = "job_board",
  id = "synthetic",
} = {}) {
  const at = "2026-10-10T00:00:00Z",
    later = "2026-10-11T00:00:00Z";
  return {
    settings: { sourceOverrides: {} },
    packages: {
      owner: { state: "active", kind: "target", versionId: "target" },
    },
    sourceHealth: {
      [id + "/site"]: {
        sourceId: id,
        siteId: "site",
        status: "unavailable",
        checkedAt: "2026-10-08T00:00:00Z",
        issues: [{ code: "source_budget_exhausted", message: "private" }],
      },
    },
    runs: {
      root: {
        runId: "root",
        ownerPackageId: "owner",
        collectionRole: "collection_root",
        collectionProgress: {
          units: {
            one: {
              sourceId: id,
              siteId: "site",
              committedPages: 1,
              lastSuccessAt: at,
              lastAttemptAt: failed ? later : at,
              lastErrorCode: failed ? "request_timeout" : null,
            },
          },
        },
      },
      slice: {
        runId: "slice",
        ownerPackageId: "owner",
        collectionRole: "collection_slice",
        collectionActivityId: "root",
      },
    },
    observations: {
      one: {
        runId: "slice",
        sourceId: id,
        siteId: "site",
        targetRevisionId: "target",
        observedAt: at,
        fields: job({
          sourceId: id,
          siteId: "site",
          description:
            "负责消防设备维护和消防安全管理，定期进行设施检测，处理风险和隐患，要求本科及以上学历。",
          bodyStatus: "complete",
          detailStatus: "complete",
        }),
      },
    },
  };
}
function sourceService(w, id = "synthetic", category = "job_board") {
  const provider = fakeProvider({ id });
  provider.capabilities.category = category;
  return createSourceService({
    repository: {
      read: async () => w,
      clock: { now: () => Date.parse("2026-10-11T00:00:00Z") },
    },
    registry: createSourceRegistry([provider]),
    requestFactory: () => {
      throw Error("No network");
    },
  });
}
test("source listing reconstructs reading proof from prior guarded collection observations without changing data", async () => {
  const w = recoveredWorkspace(),
    before = JSON.stringify(w);
  const sources = await sourceService(w).listSources();
  assert.equal(sources[0].health[0].status, "ready");
  assert.equal(sources[0].health[0].checkedAt, "2026-10-10T00:00:00.000Z");
  assert.equal(sources[0].health[0].capabilities.body, "verified");
  assert.equal(JSON.stringify(sources).includes("private"), false);
  assert.equal(JSON.stringify(w), before);
});
test("a later failed unit remains failed while recovery retains the previous reading proof", async () => {
  const sources = await sourceService(
    recoveredWorkspace({ failed: true }),
  ).listSources();
  const health = sources[0].health[0];
  assert.equal(health.status, "unavailable");
  assert.equal(health.lastAttemptAt, "2026-10-11T00:00:00.000Z");
  assert.equal(health.lastSuccessAt, "2026-10-10T00:00:00.000Z");
  assert.equal(health.issues[0].code, "request_timeout");
});
test("global recovery does not expose another version's social or Boss history", async () => {
  for (const [id, category] of [
    ["boss", "job_board"],
    ["weibo", "social_discovery"],
  ]) {
    const sources = await sourceService(
      recoveredWorkspace({ id }),
      id,
      category,
    ).listSources();
    assert.deepEqual(sources[0].health, []);
  }
});
test("orphan observations and trashed target versions do not create recovered source proofs", async () => {
  for (const change of [
    (w) => {
      delete w.runs.slice;
    },
    (w) => {
      w.packages.owner.state = "trashed";
    },
  ]) {
    const w = recoveredWorkspace();
    change(w);
    const health = (await sourceService(w).listSources())[0].health[0];
    assert.equal(health.status, "budget_exhausted");
    assert.equal(health.lastSuccessAt, null);
  }
});

test("a pagination boundary does not turn saved body proof into a network failure", async () => {
  const w = recoveredWorkspace();
  w.runs.root.collectionProgress.units.one.lastErrorCode = "page_limit_reached";
  w.runs.root.collectionProgress.units.one.status = "page_limited";
  const health = (await sourceService(w).listSources())[0].health[0];
  assert.equal(health.status, "ready");
  assert.equal(health.backoffUntil, null);
});
test("recovery does not hide access challenges returned alongside old committed records", async () => {
  const w = recoveredWorkspace();
  w.runs.slice.issues = [
    { code: "captcha", sourceId: "synthetic", siteId: "site" },
  ];
  const health = (await sourceService(w).listSources())[0].health[0];
  assert.equal(health.status, "restricted");
  assert.equal(health.capabilities.body, "unverified");
});
test("a stored newer successful probe remains newer than recovered older body observations", async () => {
  const w = recoveredWorkspace();
  w.sourceHealth["synthetic/site"] = {
    sourceId: "synthetic",
    siteId: "site",
    status: "unavailable",
    checkedAt: "2026-10-12T00:00:00Z",
    lastSuccessAt: "2026-10-11T00:00:00Z",
    issues: [{ code: "request_timeout" }],
  };
  const h = (await sourceService(w).listSources())[0].health[0];
  assert.equal(h.status, "unavailable");
  assert.equal(h.lastSuccessAt, "2026-10-11T00:00:00.000Z");
});
