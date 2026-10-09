import test from "node:test";
import assert from "node:assert/strict";
import {
  createCollectionRoot,
  assertCollectionRun,
  normalizeCollectionRun,
} from "../../src/domain/collection.mjs";

const packageId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const scope = { packageId, targetRevisionId: "t@1" };
const target = {
  revisionId: "t@1",
  ownerPackageId: packageId,
  profileSnapshot: { revisionId: "p@1", ownerPackageId: packageId },
};
function fixture() {
  const root = createCollectionRoot({
    runId: "root-1",
    scope,
    targetSnapshot: target,
    profileSnapshot: target.profileSnapshot,
    plan: {
      hashes: {
        planHash: "plan1",
        catalogHash: "catalog1",
        queryHash: "query1",
        parserVersion: "v1",
      },
      units: [
        {
          unitId: "u1",
          sourceId: "synthetic",
          siteId: "s1",
          queryIndex: 0,
          cursor: null,
        },
      ],
    },
    limits: { maxRequests: 4, maxCostCny: 10 },
    now: "2026-10-09T00:00:00.000Z",
  });
  const workspace = {
    packages: {
      [packageId]: { packageId, kind: "target", versionId: "t@1" },
      [otherId]: { packageId: otherId, kind: "target", versionId: "t@2" },
    },
    runs: { [root.runId]: root },
  };
  return { root, workspace };
}
test("root_state_is_separate_from_legacy_run_status", () => {
  const { root, workspace } = fixture();
  assert.equal(root.status, "completed");
  assert.equal(root.collectionProgress.status, "paused");
  assert.doesNotThrow(() => assertCollectionRun(root, workspace));
});
test("reject_cross_package_child_and_invalid_cursor", () => {
  const { root, workspace } = fixture();
  const child = {
    runId: "slice-1",
    collectionRole: "collection_slice",
    collectionActivityId: root.runId,
    ownerPackageId: otherId,
    targetSnapshot: { revisionId: "t@2", ownerPackageId: otherId },
  };
  assert.throws(
    () => assertCollectionRun(child, workspace),
    /collection_scope/,
  );
  root.collectionProgress.units.u1.cursor = { offset: Infinity };
  assert.throws(
    () => assertCollectionRun(root, workspace),
    /collection_progress/,
  );
});
test("old_runs_remain_terminal_and_restore_never_autostarts", () => {
  assert.deepEqual(
    normalizeCollectionRun(
      { runId: "old", status: "partial" },
      { restored: true },
    ),
    { runId: "old", status: "partial" },
  );
  const { root } = fixture();
  root.collectionProgress.status = "collecting";
  root.collectionProgress.activeSliceRunId = "slice-1";
  const restored = normalizeCollectionRun(root, { restored: true });
  assert.equal(restored.collectionProgress.status, "paused");
  assert.equal(restored.collectionProgress.epoch, 1);
  assert.equal(restored.collectionProgress.activeSliceRunId, null);
  assert.equal(root.collectionProgress.status, "collecting");
  root.collectionProgress.status = "cancelled";
  assert.equal(
    normalizeCollectionRun(root, { restored: true }).collectionProgress.status,
    "cancelled",
  );
  root.collectionProgress.status = "completed";
  assert.equal(
    normalizeCollectionRun(root, { restored: true }).collectionProgress.status,
    "completed",
  );
});
test("forbid_cross_target_snapshots_and_credentials_in_cursors", () => {
  const { root, workspace } = fixture();
  root.targetSnapshot.revisionId = "different@1";
  assert.throws(() => assertCollectionRun(root, workspace), /collection_scope/);
  root.targetSnapshot.revisionId = "t@1";
  root.collectionProgress.units.u1.cursor = {
    access_token: "synthetic-secret",
  };
  assert.throws(
    () => assertCollectionRun(root, workspace),
    /collection_progress/,
  );
});
