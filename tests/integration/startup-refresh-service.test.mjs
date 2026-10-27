import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";

test("startup rules continuation never inherits the prior AI mode or calls its model factory", async (t) => {
  let models = 0;
  const f = await collectionFixture(t, {
    modelFactory: () => {
      models++;
      return { available: false };
    },
  });
  const ref = await f.service.prepare({
    scope: f.scope,
    options: { mode: "ai" },
  });
  await f.repository.mutateWorkspace((w) => {
    const p = w.runs[ref.activityId].collectionProgress;
    p.manualPaused = false;
    p.refreshReady = true;
  });
  const before = await f.ledger.snapshot(ref);
  const result = await f.service.resume({
    ref,
    requestId: "startup-rules",
    automatic: true,
    mode: "rules",
  });
  await f.service.wait(ref);
  const root = await f.service.get(ref),
    w = await f.repository.read();
  assert.equal(root.collectionMode, "rules");
  assert.equal(w.runs[result.runId].mode, "rules");
  assert.equal(models, 0);
  const after = await f.ledger.snapshot(ref);
  assert.equal(after.usedModelRequests, before.usedModelRequests);
  assert.equal(after.costUpperBoundCny, before.costUpperBoundCny);
});

test("user pause committed while an automatic update plans is rechecked before creating a slice", async (t) => {
  let f,
    ref,
    pauseInPlanner = false;
  f = await collectionFixture(t, {
    planner: async (_input, plan) => {
      if (pauseInPlanner) {
        pauseInPlanner = false;
        await f.service.pause(ref);
      }
      return plan;
    },
  });
  ref = await f.service.prepare({ scope: f.scope, options: { mode: "rules" } });
  await f.repository.mutateWorkspace((w) => {
    const p = w.runs[ref.activityId].collectionProgress;
    p.manualPaused = false;
    p.refreshReady = true;
  });
  const before = await f.ledger.snapshot(ref);
  pauseInPlanner = true;
  const result = await f.service.resume({
    ref,
    requestId: "startup-pause-race",
    automatic: true,
    mode: "rules",
  });
  await f.service.wait(ref);
  const root = await f.service.get(ref),
    w = await f.repository.read();
  assert.equal(result.skipped, true);
  assert.equal(root.collectionProgress.status, "paused");
  assert.equal(root.collectionProgress.manualPaused, true);
  assert.equal(root.collectionProgress.activeSliceRunId, null);
  assert.equal(
    Object.values(w.runs).filter((r) => r.collectionRole === "collection_slice")
      .length,
    0,
  );
  const after = await f.ledger.snapshot(ref);
  assert.equal(after.usedRequests, before.usedRequests);
  assert.equal(after.costUpperBoundCny, before.costUpperBoundCny);
});
