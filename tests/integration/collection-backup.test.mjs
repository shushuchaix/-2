import test from "node:test";
import assert from "node:assert/strict";
import { packageFixture } from "../helpers/package-fixture.mjs";
import { createCollectionRoot } from "../../src/domain/collection.mjs";
import { filterBackup } from "../../src/infrastructure/storage/backup-filter.mjs";
import { assertWorkspace } from "../../src/domain/contracts.mjs";
import { createBackup } from "../../src/infrastructure/storage/backup.mjs";
import fs from "node:fs/promises";

test("backup_restores_owned_progress_paused_without_session_refs_or_budget_reset", async (t) => {
  const f = await packageFixture(t),
    { a } = await f.twoTargets();
  const scope = { packageId: a.packageId, targetRevisionId: a.revisionId };
  await f.repository.mutateWorkspace((w) => {
    const root = createCollectionRoot({
      runId: "collection-root",
      scope,
      targetSnapshot: a,
      profileSnapshot: a.profileSnapshot,
      plan: { units: [] },
      limits: { maxRequests: 400, maxCostCny: 10 },
      now: f.clock.now(),
    });
    root.collectionProgress.status = "collecting";
    root.collectionProgress.ledger.reservations.r1 = {
      kind: "model",
      status: "reserved",
      costUpperBoundCny: 0.7,
    };
    w.runs[root.runId] = root;
    w.packages[a.packageId].collectionSettings = {
      sourceOverrides: {},
      sessionRefs: { wechat: "session-test" },
      refreshEnabled: true,
    };
  });
  const before = await f.repository.read();
  const filtered = filterBackup({
    workspace: before,
    control: await f.control.read(),
    now: f.clock.now(),
  });
  assert.equal(
    filtered.workspace.runs["collection-root"].collectionProgress.status,
    "paused",
  );
  assert.equal(
    filtered.workspace.runs["collection-root"].collectionProgress.ledger
      .reservations.r1.costUpperBoundCny,
    0.7,
  );
  assert.deepEqual(
    filtered.workspace.packages[a.packageId].collectionSettings.sessionRefs,
    {},
  );
  assert.equal(
    filtered.workspace.packages[a.packageId].collectionSettings.refreshEnabled,
    false,
  );
  assert.equal(
    before.runs["collection-root"].collectionProgress.status,
    "collecting",
  );
  assert.doesNotThrow(() => assertWorkspace(filtered.workspace));
  const backup = await createBackup({ repository: f.repository });
  const archive = JSON.parse(await fs.readFile(backup.path, "utf8"));
  assert.deepEqual(
    archive.workspace.packages[a.packageId].collectionSettings.sessionRefs,
    {},
  );
  assert.equal(
    archive.workspace.runs["collection-root"].collectionProgress.status,
    "paused",
  );
  await f.reopen();
  assert.equal(
    (await f.repository.read()).runs["collection-root"].collectionProgress
      .ledger.reservations.r1.costUpperBoundCny,
    0.7,
  );
});
test("workspace_rejects_cross_package_activity_reference", async (t) => {
  const f = await packageFixture(t),
    { a, b } = await f.twoTargets();
  const w = await f.repository.read();
  const scope = { packageId: a.packageId, targetRevisionId: a.revisionId };
  const root = createCollectionRoot({
    runId: "collection-root",
    scope,
    targetSnapshot: a,
    profileSnapshot: a.profileSnapshot,
    plan: { units: [] },
    limits: { maxRequests: 1 },
    now: f.clock.now(),
  });
  w.runs[root.runId] = root;
  const child = {
    ...structuredClone(root),
    runId: "collection-child",
    recordId: "33333333-3333-4333-8333-333333333333",
    collectionRole: "collection_slice",
    collectionActivityId: root.runId,
    ownerPackageId: b.packageId,
    targetSnapshot: b,
  };
  delete child.collectionProgress;
  w.runs[child.runId] = child;
  assert.throws(() => assertWorkspace(w), /collection_scope/);
});
