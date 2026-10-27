import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { articleCacheIdentity } from "../../src/llm/prompt-registry.mjs";
import { articleParts, articlePartKey, queueContentDraft } from "../../src/sources/content-queue.mjs";
import { prepareArticleRecovery, applyArticleRecovery, articlePartWindow } from "../../src/application/collection-article-recovery.mjs";
import { collectionPartId, collectionToken, collectionLease, leaseSelector, rowSelector } from "../../src/application/collection-row-access.mjs";
import { rowKey } from "../../src/infrastructure/storage/sqlite-records.mjs";
import { jobFactHash } from "../../src/domain/job-facts.mjs";
import { contentHash } from "../../src/infrastructure/storage/content-hash.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";

const identity = articleCacheIdentity({ modelConfig: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" } });
const units = [{ unitId: "unit", sourceId: "synthetic", siteId: "s" }];
const notice = (description = "消防岗位：本科消防工程专业，负责消防设施检查维护和工程项目的隐患排查，招聘要求请以该公告完整正文为准。") => job({
  sourceId: "synthetic", siteId: "s", identityScope: "s", sourceRecordId: "notice", kind: "recruitment_notice",
  title: "消防招聘公告", url: "https://example.org/notice", description, bodyStatus: "complete", intent: "employer_recruitment",
});
async function parts(f, c, collection) {
  return (await f.repository.queryRows({ collection, ownerPackageId: f.scope.packageId,
    where: { parentId: c.ref.activityId, path: "collectionProgress." + (collection === "articleCache" ? "articleCache" : "pendingArticles") },
    limit: 200, total: false }, { scope: f.scope })).rows;
}
async function cachePending(f, c, { legacy = false } = {}) {
  const pending = await parts(f, c, "contentArticles"), descriptors = pending.map(row => ({
    collection: "articleCache", id: collectionPartId(c.ref.activityId, "collectionProgress.articleCache", JSON.parse(row.id).at(-1)),
    ownerPackageId: f.scope.packageId, parent: { collection: "runs", id: c.ref.activityId, path: "collectionProgress.articleCache" },
    targetRevisionId: f.scope.targetRevisionId, runId: c.ref.activityId,
    value: { ...row.value.cacheIdentity, unitId: row.value.unitId, partIndex: row.value.partIndex, partCount: row.value.partCount,
      ...(legacy ? {} : { record: row.value.record }), promptVersion: "old", jobIds: [] },
  }));
  await f.repository.transaction({ select: [rowSelector("contentArticles", f.scope, pending.map(row => row.id)),
    rowSelector("articleCache", f.scope, descriptors.map(row => row.id))] }, tx => {
    for (const row of pending) tx.deleteRow({ collection: "contentArticles", id: row.id });
    for (const row of descriptors) tx.putRow(row);
  }, { scope: f.scope, operationLease: c.lease });
  return descriptors;
}
async function prepare(f, c, extra = {}) {
  return prepareArticleRecovery(f.repository, { ref: c.ref, identity, units, ...extra });
}
async function publish(f, c, plan, { fail = false, token = c.token } = {}) {
  return f.repository.transaction({ select: [...plan.select, leaseSelector(c.lease)] }, tx => {
    const root = tx.getRow({ collection: "runs", id: c.ref.activityId });
    collectionLease(tx.view, f.scope, c.lease);
    collectionToken(root.collectionProgress, token);
    applyArticleRecovery(tx, plan);
    root.collectionProgress.articleRecovery = plan.marker;
    root.collectionProgress.revision++;
    tx.putRow({ collection: "runs", id: root.runId, value: root });
    if (fail) throw Error("synthetic rollback after all repair writes");
  }, { scope: f.scope, operationLease: c.lease });
}

test("recovery publishes current verified body and retains old cache on CAS, rollback and cancellation", async t => {
  const f = await collectionFixture(t), c = await f.openCommit(), old = notice();
  await c.commit({ records: [old], pageKey: "notice-page", done: true, nextCursor: null });
  const cached = await cachePending(f, c),
    [jobId] = (await f.repository.queryRows({ collection: "activityJobIds", ownerPackageId: f.scope.packageId,
      where: { parentId: c.ref.activityId, path: "collectionProgress.newJobIds" }, limit: 1, total: false }, { scope: f.scope })).rows.map(row => row.value);
  const fresh = notice(old.description + " 最新正文新增安全工程岗位，要求拥有消防项目经验。");
  await f.jobs.ingestRecords({ scope: f.scope, runId: c.token.sliceRunId, records: [fresh], observedAt: "2026-10-09T00:01:00.000Z", operationLease: c.lease });
  let plan = await prepare(f, c);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].value.record.description, fresh.description);
  assert.equal(plan.rows[0].value.recoverySourceFact.jobId, jobId);
  assert.deepEqual(plan.deletes.map(row => row.id), cached.map(row => row.id));
  await assert.rejects(publish(f, c, plan, { fail: true }), /synthetic rollback/);
  assert.equal((await parts(f, c, "articleCache")).length, 1);
  assert.equal((await parts(f, c, "contentArticles")).length, 0);
  await assert.rejects(publish(f, c, plan, { token: { ...c.token, epoch: c.token.epoch + 1 } }), { code: "collection_stale_epoch" });
  await f.repository.transaction({ select: [rowSelector("articleCache", f.scope, [cached[0].id])] }, tx => {
    const value = tx.getRow(cached[0]); value.completedAt = "changed-after-prepare";
    tx.putRow({ collection: "articleCache", id: cached[0].id, value });
  }, { scope: f.scope, operationLease: c.lease });
  await assert.rejects(publish(f, c, plan), { code: "collection_queue_conflict" });
  assert.equal((await parts(f, c, "articleCache")).length, 1);
  plan = await prepare(f, c);
  await publish(f, c, plan);
  assert.equal((await parts(f, c, "articleCache")).length, 0);
  assert.equal((await parts(f, c, "contentArticles"))[0].value.record.description, fresh.description);
});

test("already-owned notice absent from root newJobIds is recovered from slice jobIds after restart", async t => {
  const f = await collectionFixture(t), original = notice();
  await f.ingest(f.scope, [original]);
  const c = await f.openCommit();
  await c.commit({ records: [original], pageKey: "notice-page", done: true, nextCursor: null });
  assert.equal((await f.repository.queryRows({ collection: "activityJobIds", ownerPackageId: f.scope.packageId,
    where: { parentId: c.ref.activityId, path: "collectionProgress.newJobIds" }, total: false })).rows.length, 0);
  await cachePending(f, c, { legacy: true });
  const plan = await prepare(f, c);
  assert.equal(plan.rows.length, 1);
  await publish(f, c, plan);
  await c.lease.release();
  await f.reopen();
  assert.equal((await parts(f, c, "articleCache")).length, 0);
  assert.equal((await parts(f, c, "contentArticles")).length, 1);
});

test("typed source fact guard rejects a changed notice atomically without erasing history", async t => {
  const f = await collectionFixture(t), c = await f.openCommit();
  await c.commit({ records: [notice()], pageKey: "notice-page", done: true, nextCursor: null });
  await cachePending(f, c);
  const plan = await prepare(f, c), guard = plan.rows[0].value.recoverySourceFact;
  await publish(f, c, plan);
  await f.jobs.ingestRecords({ scope: f.scope, runId: c.token.sliceRunId, records: [notice("最新正文：工程岗位招收本科消防工程专业，负责最新设备检查维护及现场管理，岗位要求以此新公告为准。")],
    observedAt: "2026-10-09T00:02:00.000Z", operationLease: c.lease });
  const before = await f.repository.aggregateRows({ collection: "observations", ownerPackageId: f.scope.packageId, operation: "count" }, { scope: f.scope });
  await assert.rejects(f.jobs.ingestRecords({ scope: f.scope, runId: c.token.sliceRunId, records: [job({ title: "迟到旧正文岗位" })],
    operationLease: c.lease, collectionGuard: { ref: c.ref, token: c.token }, sourceFactGuard: guard }), { code: "collection_source_fact_changed" });
  assert.deepEqual(await f.repository.aggregateRows({ collection: "observations", ownerPackageId: f.scope.packageId, operation: "count" }, { scope: f.scope }), before);
  assert.equal((await parts(f, c, "contentArticles")).length, 1);
});

test("unguarded current-identity pending is verified against the latest fact even without stale cache", async t => {
  const f = await collectionFixture(t), c = await f.openCommit();
  await c.commit({ records: [notice()], pageKey: "notice-page", done: true, nextCursor: null });
  const oldPending = (await parts(f, c, "contentArticles"))[0];
  assert.equal(oldPending.value.recoverySourceFact, undefined);
  const fresh = notice("当前正文：本科消防工程专业，最新工程岗位负责园区设备管理与消防隐患排查，资格要求以当前正文为准。");
  await f.jobs.ingestRecords({ scope: f.scope, runId: c.token.sliceRunId, records: [fresh],
    observedAt: "2026-10-09T00:03:00.000Z", operationLease: c.lease });
  const plan = await prepare(f, c);
  assert.equal(plan.rows[0].value.record.description, fresh.description);
  assert.ok(plan.rows[0].value.recoverySourceFact);
  assert.ok(plan.deletes.some(row => row.id === oldPending.id));
});

test("done repair detects a later same-identity cached source fact change", async t => {
  const f = await collectionFixture(t), c = await f.openCommit();
  await c.commit({ records: [notice()], pageKey: "notice-page", done: true, nextCursor: null });
  const first = await prepare(f, c);
  await publish(f, c, first);
  const [pending] = await parts(f, c, "contentArticles"), cacheId = collectionPartId(c.ref.activityId, "collectionProgress.articleCache", JSON.parse(pending.id).at(-1));
  await f.repository.transaction({ select: [rowSelector("contentArticles", f.scope, [pending.id]), rowSelector("articleCache", f.scope, [cacheId])] }, tx => {
    tx.deleteRow({ collection: "contentArticles", id: pending.id });
    tx.putRow({ collection: "articleCache", id: cacheId, ownerPackageId: f.scope.packageId,
      parent: { collection: "runs", id: c.ref.activityId, path: "collectionProgress.articleCache" }, targetRevisionId: f.scope.targetRevisionId,
      value: { ...pending.value.cacheIdentity, record: pending.value.record, recoverySourceFact: pending.value.recoverySourceFact } });
  }, { scope: f.scope, operationLease: c.lease });
  const fresh = notice(notice().description + " 当前新增工程设备岗位及资格条件。");
  await f.jobs.ingestRecords({ scope: f.scope, runId: c.token.sliceRunId, records: [fresh],
    observedAt: "2026-10-09T00:04:00.000Z", operationLease: c.lease });
  const plan = await prepare(f, c);
  assert.equal(plan.rows.find(row => row.collection === "contentArticles").value.record.description, fresh.description);
  assert.ok(plan.deletes.some(row => row.id === cacheId));
});

test("part windows preserve newline overlap, full body hash and keys with 1024 chunks", () => {
  const body = ("a".repeat(3500) + "\n" + "消防工程岗位".repeat(1000) + "\n").repeat(620),
    all = articleParts(body), window = articlePartWindow(body, 1, 10);
  assert.ok(all.length > 1024);
  assert.equal(window.partCount, all.length);
  assert.deepEqual(window.parts.map(part => part.description), all.slice(1, 11));
  assert.deepEqual(window.parts.map(part => part.partIndex), Array.from({ length: 10 }, (_, i) => i + 1));
  assert.equal(window.hasMore, true);
  const tail = articlePartWindow(body, all.length - 2, 10);
  assert.deepEqual(tail.parts.map(part => part.description), all.slice(-2));
  assert.equal(tail.hasMore, false);
  const small = notice(body.slice(0, 19000)), progress = {};
  queueContentDraft(progress, "unit", [small], 0, identity);
  const smallWindow = articlePartWindow(small.description, 0, 10), fullHash = contentHash(small.description);
  assert.deepEqual([...new Set(smallWindow.parts.map(({ description }) => articlePartKey({ record: { ...small, description }, cacheIdentity: { ...identity, bodyHash: fullHash } })))],
    Object.keys(progress.pendingArticles));
});

function memoryRecovery(record, { slices = [] } = {}) {
  const scope = { packageId: randomUUID(), targetRevisionId: randomUUID() }, ref = { scope, activityId: "root" },
    values = new Map(), add = (collection, id, value, indexes = {}) => values.set(collection + "\0" + id,
      { id, value, indexes: { ownerPackageId: scope.packageId, targetRevisionId: scope.targetRevisionId, ...indexes } });
  add("runs", "root", { runId: "root", ownerPackageId: scope.packageId, collectionRole: "collection_root", collectionProgress: {} });
  add("jobs", "j", { jobId: "j", ownerPackageId: scope.packageId });
  add("targetMembers", rowKey(scope.targetRevisionId, "j"), { currentObservationId: "o", factContentHash: jobFactHash(record), factRefs: [{ observationId: "o" }] });
  add("observations", "o", { observationId: "o", ownerPackageId: scope.packageId, targetRevisionId: scope.targetRevisionId, jobId: "j", fields: record });
  const parentId = slices.at(-1) || "root", path = slices.length ? "jobIds" : "collectionProgress.newJobIds";
  add("activityJobIds", collectionPartId(parentId, path, "0"), "j", { parentId, path });
  const cacheId = collectionPartId("root", "collectionProgress.articleCache", "old");
  add("articleCache", cacheId, { bodyHash: contentHash(record.description), promptVersion: "old" }, { parentId: "root", path: "collectionProgress.articleCache" });
  let sliceQueries = 0, rowQueries = 0;
  const port = {
    async readView({ select }) {
      const rows = {}, indexes = {};
      for (const selector of select) for (const id of selector.ids) {
        const row = values.get(selector.collection + "\0" + id);
        if (row) { (rows[selector.collection] ||= {})[id] = row.value; (indexes[selector.collection] ||= {})[id] = row.indexes; }
      }
      return { rows, indexes };
    },
    async queryRows(selector) {
      rowQueries++;
      const rows = [...values.entries()].filter(([key, row]) => key.startsWith(selector.collection + "\0") &&
        row.indexes.parentId === selector.where.parentId && row.indexes.path === selector.where.path && (!selector.afterId || row.id > selector.afterId))
        .map(([, row]) => row).sort((a, b) => a.id.localeCompare(b.id));
      return { rows: rows.slice(0, selector.limit), hasMore: rows.length > selector.limit,
        nextCursor: rows.length > selector.limit ? rows[selector.limit - 1].id : null };
    },
    async queryCollectionSlicePage({ afterId, limit }) {
      sliceQueries++;
      const remaining = slices.filter(id => id > afterId);
      return { sliceRunIds: remaining.slice(0, limit), hasMore: remaining.length > limit, nextCursor: remaining.length > limit ? remaining[limit - 1] : null };
    },
    async readJobHead() { return { head: 1 }; },
  };
  const persist = plan => {
    applyArticleRecovery({ getRow: ({ collection, id }) => values.get(collection + "\0" + id)?.value || null,
      putRow: row => add(row.collection, row.id, row.value, { parentId: row.parent?.id, path: row.parent?.path }),
      deleteRow: row => values.delete(row.collection + "\0" + row.id) }, plan);
    values.get("runs\0root").value.collectionProgress.articleRecovery = structuredClone(plan.marker);
  };
  return { port, ref, persist, values, cacheId, counts: () => ({ sliceQueries, rowQueries }) };
}

test("1024-part notice queues at most 200 parts per durable repair step and deletes cache only after coverage", async () => {
  const record = notice(Array.from({ length: 1024 }, (_, i) => String(i).padStart(4, "0") + "x".repeat(5696)).join("") + "tail".repeat(75)),
    bodyHash = contentHash(record.description), memory = memoryRecovery(record), keys = new Set();
  const existing = { unitId: "unit", partIndex: 0, partCount: 1024, bodyHash,
    record: { ...record, description: record.description.slice(0, 6000) }, cacheIdentity: { ...identity, bodyHash }, status: "pending", attempts: 2 },
    existingId = collectionPartId("root", "collectionProgress.pendingArticles", articlePartKey(existing));
  memory.values.set("contentArticles\0" + existingId, { id: existingId, value: existing,
    indexes: { ownerPackageId: memory.ref.scope.packageId, parentId: "root", path: "collectionProgress.pendingArticles" } });
  for (let step = 0; step < 6; step++) {
    const plan = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units });
    assert.ok(plan.rows.length <= 200);
    assert.ok(plan.preferredArticleIds.length <= 10);
    assert.ok(plan.rows.every(row => row.value.bodyHash === bodyHash));
    for (const row of plan.rows) keys.add(row.id);
    if (step < 5) {
      assert.equal(plan.deletes.length, 0);
      assert.equal(plan.marker.part.index, (step + 1) * 200);
    } else { assert.equal(plan.deletes.length, 1); assert.equal(plan.marker.phase, "done"); }
    memory.persist(plan);
    assert.equal(memory.values.has("articleCache\0" + memory.cacheId), step < 5);
  }
  assert.equal(keys.size, 1024);
  assert.equal(memory.values.get("contentArticles\0" + existingId).value.attempts, 2);
  assert.equal(memory.counts().sliceQueries, 0);
});

test("repair cursor crosses 205 linked slices with a fixed window and survives a copied persisted marker", async () => {
  const slices = Array.from({ length: 205 }, (_, i) => "slice-" + String(i).padStart(4, "0")), memory = memoryRecovery(notice(), { slices });
  for (let step = 0; step < slices.length; step++) {
    const before = memory.counts();
    const plan = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units });
    assert.equal(memory.counts().sliceQueries - before.sliceQueries, 1);
    assert.ok(memory.counts().rowQueries - before.rowQueries <= (step ? 1 : 4));
    if (step < 204) {
      assert.equal(plan.rows.length, 0);
      assert.equal(plan.marker.sliceAfterId, slices[step]);
      assert.equal(plan.incomplete, true);
      assert.equal(plan.deletes.length, 0);
    } else { assert.equal(plan.rows.length, 1); assert.equal(plan.deletes.length, 1); }
    memory.persist(plan);
    if (step === 100) {
      const root = memory.values.get("runs\0root");
      root.value = JSON.parse(JSON.stringify(root.value));
    }
  }
  assert.equal(memory.counts().sliceQueries, 205);
  assert.equal(memory.values.has("articleCache\0" + memory.cacheId), false);
});

test("blocked missing-unit repair stays quiet and resumes on a unit change without a job-head change", async () => {
  const memory = memoryRecovery(notice());
  memory.persist(await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units: [] }));
  const blocked = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units: [] });
  assert.equal(blocked.needsRepair, true);
  memory.persist(blocked);
  const quiet = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units: [] });
  assert.equal(quiet.changed, false);
  assert.equal(quiet.needsRepair, true);
  const recovered = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units });
  assert.equal(recovered.rows.length, 1);
  assert.equal(recovered.marker.phase, "done");
});

test("a destination queue change rejects repair before cache removal", async () => {
  const memory = memoryRecovery(notice()), plan = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units }), row = plan.rows[0];
  memory.values.set("contentArticles\0" + row.id, { id: row.id, value: { ...row.value, attempts: 7 }, indexes: {} });
  assert.throws(() => memory.persist(plan), { code: "collection_queue_conflict" });
  assert.equal(memory.values.has("articleCache\0" + memory.cacheId), true);
  assert.equal(memory.values.get("runs\0root").value.collectionProgress.articleRecovery, undefined);
});

test("a valid current cache receives source guard metadata without queuing another model extraction", async () => {
  const record = notice(), memory = memoryRecovery(record), bodyHash = contentHash(record.description), cacheIdentity = { ...identity, bodyHash },
    id = collectionPartId("root", "collectionProgress.articleCache", articlePartKey({ record, cacheIdentity }));
  memory.values.delete("articleCache\0" + memory.cacheId);
  memory.values.set("articleCache\0" + id, { id, value: { ...cacheIdentity, record, unitId: "unit", partIndex: 0, partCount: 1 },
    indexes: { ownerPackageId: memory.ref.scope.packageId, parentId: "root", path: "collectionProgress.articleCache" } });
  const plan = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].collection, "articleCache");
  assert.ok(plan.rows[0].value.recoverySourceFact);
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.marker.phase, "done");
});

test("current cache promotion retains exact cache-or-pending coverage across part windows", async () => {
  const record = notice(Array.from({ length: 401 }, (_, i) => String(i).padStart(4, "0") + "x".repeat(5696)).join("") + "tail".repeat(75)),
    bodyHash = contentHash(record.description), cacheIdentity = { ...identity, bodyHash }, parts = articlePartWindow(record.description, 0, 500).parts;
  for (const cachedParts of [[0], [199], [200], [400], [0, 199, 200, 400]]) {
    const memory = memoryRecovery(record), originals = [];
    memory.values.delete("articleCache\0" + memory.cacheId);
    for (const partIndex of cachedParts) {
      const partRecord = { ...record, description: parts[partIndex].description }, key = articlePartKey({ record: partRecord, cacheIdentity }),
        id = collectionPartId("root", "collectionProgress.articleCache", key);
      originals.push({ key, id });
      memory.values.set("articleCache\0" + id, { id, value: { ...cacheIdentity, record: partRecord, unitId: "unit", partIndex, partCount: 401 },
        indexes: { ownerPackageId: memory.ref.scope.packageId, parentId: "root", path: "collectionProgress.articleCache" } });
    }
    for (let step = 0; step < 3; step++) {
      const plan = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units });
      assert.ok(plan.rows.length <= 200);
      assert.ok(plan.marker.cacheIds === undefined || plan.marker.cacheIds.length <= 200);
      assert.ok(plan.rows.filter(row => row.collection === "contentArticles").every(row => !originals.some(old => old.key === JSON.parse(row.id).at(-1))));
      memory.persist(plan);
      const root = memory.values.get("runs\0root"); root.value = JSON.parse(JSON.stringify(root.value));
    }
    for (const { description } of parts) {
      const key = articlePartKey({ record: { ...record, description }, cacheIdentity }),
        cached = memory.values.has("articleCache\0" + collectionPartId("root", "collectionProgress.articleCache", key)),
        pending = memory.values.has("contentArticles\0" + collectionPartId("root", "collectionProgress.pendingArticles", key));
      assert.equal(Number(cached) + Number(pending), 1, "exact coverage for cached parts " + cachedParts.join(","));
    }
    assert.ok(originals.every(old => memory.values.has("articleCache\0" + old.id)), "previously valid current caches remain completed");
  }
});

test("a conflicting source site cannot gain a guard through an existing unit ID", async () => {
  const memory = memoryRecovery(notice()), conflictingUnits = [{ ...units[0], siteId: "another-site" }];
  const first = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units: conflictingUnits });
  assert.equal(first.rows.length, 0);
  memory.persist(first);
  const blocked = await prepareArticleRecovery(memory.port, { ref: memory.ref, identity, units: conflictingUnits });
  assert.equal(blocked.needsRepair, true);
  assert.equal(blocked.rows.length, 0);
  assert.equal(blocked.deletes.length, 0);
  assert.ok(memory.values.has("articleCache\0" + memory.cacheId));
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
for (const interruption of ["changed fact", "cancelled activity"]) test(`model response cannot publish after ${interruption}`, { timeout: 120000 }, async t => {
  const entered = deferred(), response = deferred();
  let recovery = false, blocked = false, calls = 0, lists = 0, lastText;
  const articles = Array.from({ length: 12 }, (_, i) => ({ ...notice(), siteId: "site-0", identityScope: "site-0",
    sourceRecordId: String(i), url: "https://example.org/notice/" + i }));
  const provider = createPagedProvider({ id: "synthetic", name: "synthetic", capabilities: {},
    listPage: async () => { lists++; return { records: articles, hasMore: false }; } });
  const f = await collectionFixture(t, { providers: [provider], modelFactory: () => ({ chatJson: async (_system, text) => {
    calls++; lastText = text;
    if (recovery && !blocked) { blocked = true; entered.resolve(); return response.promise; }
    return { isRecruiting: false, positions: [] };
  } }) });
  const started = await f.service.start({ scope: f.scope, options: { mode: "ai" } }), ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  assert.equal(calls, 10);
  const c = { ref }, cached = await parts(f, c, "articleCache");
  await f.repository.transaction({ select: [rowSelector("articleCache", f.scope, [cached[0].id])] }, tx => {
    const value = tx.getRow({ collection: "articleCache", id: cached[0].id }); value.promptVersion = "old";
    tx.putRow({ collection: "articleCache", id: cached[0].id, value });
  }, { scope: f.scope });
  recovery = true;
  await f.service.resume({ ref, requestId: "interrupted-repair" });
  await entered.promise;
  let cancellation;
  if (interruption === "changed fact") {
    const pending = (await parts(f, c, "contentArticles")).find(row => row.value.recoverySourceFact), guard = pending.value.recoverySourceFact,
      memberId = rowKey(f.scope.targetRevisionId, guard.jobId), observationId = "o-" + randomUUID(),
      lease = await f.operationGate.acquire("import", { scope: f.scope });
    try {
      await f.repository.transaction({ select: [rowSelector("targetMembers", f.scope, [memberId]),
        rowSelector("observations", f.scope, [guard.currentObservationId, observationId])] }, tx => {
        const observation = tx.getRow({ collection: "observations", id: guard.currentObservationId }),
          fresh = { ...(observation.fields || observation.record), description: pending.value.record.description + " 最新正文：新增工程岗位及设备维护条件。" },
          member = tx.getRow({ collection: "targetMembers", id: memberId });
        tx.putRow({ collection: "observations", id: observationId, ownerPackageId: f.scope.packageId, jobId: guard.jobId,
          targetRevisionId: f.scope.targetRevisionId, value: { ...observation, observationId, recordId: randomUUID(),
            observedAt: new Date(f.clock.now() + 60000).toISOString(), fields: fresh } });
        member.factRefs.push({ observationId }); member.currentObservationId = observationId; member.factContentHash = jobFactHash(fresh);
        tx.putRow({ collection: "targetMembers", id: memberId, value: member });
      }, { scope: f.scope, operationLease: lease });
    } finally { await lease.release(); }
  } else cancellation = f.service.cancel(ref);
  response.resolve({ isRecruiting: true, positions: [{ title: "消防岗位", requirementsExcerpt: "消防岗位：本科消防工程专业" }] });
  await cancellation;
  await f.service.wait(ref);
  const jobs = await f.repository.queryRows({ collection: "jobs", ownerPackageId: f.scope.packageId, limit: 100, total: false }, { scope: f.scope });
  assert.equal(jobs.rows.length, 12);
  assert.ok(jobs.rows.every(row => row.value.kind === "recruitment_notice"));
  assert.equal(lists, 1);
  assert.equal((await f.service.get(ref)).collectionUsage.maxCostCny, 10);
  if (interruption === "changed fact") {
    assert.ok((await parts(f, c, "contentArticles")).some(row => row.value.recoverySourceFact));
    await f.service.resume({ ref, requestId: "current-fact-repair" });
    await f.service.wait(ref);
    assert.match(lastText, /最新正文/);
    assert.equal((await parts(f, c, "contentArticles")).length, 0);
  } else assert.equal((await f.service.get(ref)).collectionProgress.status, "cancelled");
});
