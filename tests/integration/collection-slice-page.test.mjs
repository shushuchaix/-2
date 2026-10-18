import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createSqliteCollectionQueries } from "../../src/infrastructure/storage/sqlite-collection-queries.mjs";

function seedSlices(db, scope, rootId, ids) {
  const row = db.prepare(`INSERT INTO rows(collection,id,owner_id,record_id,value,target_revision_id,kind)
    VALUES('runs',?,?,?,?,?,'collection_slice')`);
  const ref = db.prepare("INSERT INTO row_refs VALUES('runs',?,'collectionActivityId','runs',?,?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids) {
      row.run(id, scope.packageId, randomUUID(), JSON.stringify({ runId: id,
        collectionRole: "collection_slice", collectionActivityId: rootId,
        privateBody: "synthetic body must not be returned" }), scope.targetRevisionId);
      ref.run(id, rootId, scope.packageId);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

test("activity slice page follows owned references with a restartable identity cursor", async (t) => {
  const f = await collectionFixture(t), c = await f.openCommit();
  const db = new DatabaseSync(path.join(f.dataDir, "workspace.sqlite"));
  const ids = Array.from({ length: 205 }, (_, i) => "linked-" + String(i).padStart(4, "0"));
  seedSlices(db, f.scope, c.ref.activityId, ids);
  // Foreign-key ownership prevents a cross-owner reference; a mismatched
  // historical target is additionally excluded by the fixed query.
  seedSlices(db, { ...f.scope, targetRevisionId: f.otherScope.targetRevisionId }, c.ref.activityId, ["wrong-target"]);
  db.close();
  const first = await f.repository.queryCollectionSlicePage({ ...c.ref, limit: 200 });
  assert.equal(first.sliceRunIds.length, 200);
  assert.deepEqual(first.sliceRunIds, ids.slice(0, 200));
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, ids[199]);
  assert.deepEqual(Object.keys(first).sort(), ["hasMore", "nextCursor", "sliceRunIds"]);
  const tail = await f.repository.withWriteFence(fence =>
    fence.queryCollectionSlicePage({ ...c.ref, afterId: first.nextCursor, limit: 200 }),
  { scope: f.scope, operationLease: c.lease });
  assert.deepEqual(tail.sliceRunIds, [...ids.slice(200), c.token.sliceRunId].sort());
  assert.equal(tail.hasMore, false);
  assert.equal(tail.nextCursor, null);
  await c.lease.release();
  await f.reopen();
  assert.deepEqual(await f.repository.queryCollectionSlicePage({ ...c.ref, afterId: first.nextCursor }), tail);
  for (const input of [
    { ...c.ref, activityId: "missing-root" },
    { ...c.ref, scope: f.otherScope },
  ]) await assert.rejects(f.repository.queryCollectionSlicePage(input), { code: "collection_scope" });
  await assert.rejects(f.repository.queryCollectionSlicePage({ ...c.ref,
    scope: { ...f.scope, targetRevisionId: f.otherScope.targetRevisionId } }), { code: "package_scope_mismatch" });
  for (const input of [{ ...c.ref, limit: 201 }, { ...c.ref, afterId: 2 }, { activityId: c.ref.activityId }])
    await assert.rejects(f.repository.queryCollectionSlicePage(input), { code: "sqlite_selection_invalid" });
});

test("activity slice page read volume stays fixed after 1000 unrelated slices", async (t) => {
  const f = await collectionFixture(t), c = await f.openCommit();
  const input = { ...c.ref, limit: 1 };
  f.repository.metrics({ reset: true });
  const before = await f.repository.queryCollectionSlicePage(input), baseline = f.repository.metrics();
  const db = new DatabaseSync(path.join(f.dataDir, "workspace.sqlite"));
  seedSlices(db, f.scope, c.ref.activityId, []);
  const siblingId = "sibling-" + randomUUID();
  const original = db.prepare("SELECT * FROM rows WHERE collection='runs' AND id=?").get(c.ref.activityId);
  db.prepare(`INSERT INTO rows(collection,id,owner_id,record_id,value,target_revision_id,kind)
    VALUES('runs',?,?,?,?,?,'collection_root')`).run(siblingId, f.scope.packageId, randomUUID(),
      original.value.replaceAll(c.ref.activityId, siblingId), f.scope.targetRevisionId);
  seedSlices(db, f.scope, siblingId, Array.from({ length: 1000 }, (_, i) => "unrelated-" + i));
  let linkedSql;
  const queries = createSqliteCollectionQueries({ db, statement: sql => {
    if (sql.startsWith("SELECT refs.id AS runId")) linkedSql = sql;
    return db.prepare(sql);
  } });
  queries.queryCollectionSlicePage(input);
  const plan = db.prepare("EXPLAIN QUERY PLAN " + linkedSql)
    .all(c.ref.activityId, f.scope.packageId, "", f.scope.targetRevisionId, 2).map(row => row.detail);
  assert.ok(plan.some(detail => detail.includes("SEARCH refs USING INDEX row_refs_target_fk")), plan.join("\n"));
  assert.ok(!plan.some(detail => /SCAN (refs|r)\b/.test(detail)), plan.join("\n"));
  t.diagnostic("Fixed slice lookup query plan: " + JSON.stringify(plan));
  db.close();
  f.repository.metrics({ reset: true });
  assert.deepEqual(await f.repository.queryCollectionSlicePage(input), before);
  const after = f.repository.metrics();
  assert.equal(after.rowsRead, baseline.rowsRead);
  assert.equal(after.decodedRows, baseline.decodedRows);
  assert.equal(after.decodedBytes, baseline.decodedBytes);
  assert.equal(after.rowsWritten, 0);
  assert.equal(after.maintenanceReads, 0);
});

test("activity slice page retains repository expiry authorization", async t => {
  const f = await collectionFixture(t), c = await f.openCommit();
  await f.service.pause(c.ref);
  await c.lease.release();
  await f.trash.archive({ packageId: f.scope.packageId });
  f.clock.advance(72 * 3600000);
  await assert.rejects(f.repository.queryCollectionSlicePage(c.ref), { code: "package_expired" });
});
