import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createApplicationContext } from "../../src/application/context.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";

async function fixture(t, transport) {
  const f = await collectionFixture(t);
  const [jobId] = await f.ingest(f.scope, [
    job({
      detailStatus: "complete",
      deadlineAt: "2029-01-01",
      applyUrl: "https://jobs.example.com/apply",
    }),
  ]);
  let requests = 0;
  const context = await createApplicationContext({
    cfg: {
      deepseek: {
        apiKey: "",
        model: "deepseek-flash",
        baseUrl: "https://api.deepseek.com",
      },
      limits: { persist: false, perIpCooldownMs: 0 },
    },
    dataDir: f.dataDir,
    dependencies: {
      repository: f.repository,
      registry: createSourceRegistry([]),
      catalog: [],
      startScheduler: false,
      collectionPlanner: async () => ({
        units: [],
        hashes: {},
        limits: { maxRequests: 2, maxDetails: 1, maxCostCny: 1 },
      }),
      requestFactory:
        ({ budget, signal }) =>
        async () => {
          signal.throwIfAborted();
          const reservation = await budget.claimRequest("application");
          requests++;
          const response = transport
            ? await transport(signal)
            : { status: 200, text: "<form><button>提交申请</button></form>" };
          signal.throwIfAborted();
          await budget.settleRequest(reservation, { bytes: 0 });
          return response;
        },
    },
  });
  context.collectionRefresh.stop();
  t.after(() => context.close());
  const prepared = await context.collectionService.prepare({
    scope: f.scope,
    options: { mode: "rules", requestId: "verification-prepare" },
  });
  return {
    ...f,
    context,
    jobId,
    ref: { scope: f.scope, activityId: prepared.activityId },
    requests: () => requests,
  };
}

test("paused job verification uses the original ledger and returns the root to paused", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 2; n++) {
    const result = await f.context.jobVerificationService.verifyJob({
      scope: f.scope,
      ref: f.ref,
      jobId: f.jobId,
    });
    assert.equal(result.recruitmentEvidence.applicationStatus, "available");
  }
  const root = await f.context.collectionService.get(f.ref);
  assert.equal(root.collectionProgress.status, "paused");
  assert.equal(root.collectionUsage.usedRequests, 2);
  assert.equal(root.collectionUsage.knownPhysicalRequests, 2);
  assert.equal(
    Object.keys(root.collectionProgress.diagnosticRequests).length,
    2,
  );
  await assert.rejects(
    () =>
      f.context.jobVerificationService.verifyJob({
        scope: f.otherScope,
        ref: f.ref,
        jobId: f.jobId,
      }),
    { code: "package_scope_mismatch" },
  );
  await f.context.collectionService.cancel(f.ref);
  await assert.rejects(
    () =>
      f.context.jobVerificationService.verifyJob({
        scope: f.scope,
        ref: f.ref,
        jobId: f.jobId,
      }),
    { code: "collection_terminal" },
  );
  assert.equal(f.requests(), 2);
});

test("cancelling paused verification rejects the late result and retains its uncertain reservation", async (t) => {
  let started, release;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async () => {
    started();
    await pending;
    return { status: 200, text: "<form><button>提交申请</button></form>" };
  });
  const before = Object.keys((await f.repository.read()).observations).length;
  const verification = f.context.jobVerificationService.verifyJob({
    scope: f.scope,
    ref: f.ref,
    jobId: f.jobId,
  });
  const settled = verification.then(
    () => ({ ok: true }),
    (error) => ({ error }),
  );
  await Promise.race([
    ready,
    settled.then(({ error }) => {
      if (error) throw error;
    }),
  ]);
  const cancellation = f.context.collectionService.cancel(f.ref);
  release();
  const [outcome] = await Promise.all([settled, cancellation]);
  assert.equal(outcome.error?.code, "collection_stale_epoch");
  assert.equal(
    Object.keys((await f.repository.read()).observations).length,
    before,
  );
  const root = await f.context.collectionService.get(f.ref);
  assert.equal(root.collectionProgress.status, "cancelled");
  assert.equal(root.collectionUsage.usedRequests, 1);
  assert.equal(root.collectionUsage.unknownRequestUpperBound, 1);
});
