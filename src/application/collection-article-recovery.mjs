import { packageError } from "../domain/packages.mjs";
import { jobFactHash } from "../domain/job-facts.mjs";
import { classifyRecruitmentIntent } from "../sources/social-intent.mjs";
import { articlePartKey, contentKey } from "../sources/content-queue.mjs";
import { contentHash } from "../infrastructure/storage/content-hash.mjs";
import { rowKey } from "../infrastructure/storage/sqlite-records.mjs";
import { collectionPartId, collectionRoot, rowSelector } from "./collection-row-access.mjs";
import { collectionWriteSelectors } from "./collection-page-commit.mjs";

const changed = () => packageError("collection_source_fact_changed", "公告正文已变化，请按最新正文继续提取。");
const matches = (value, identity) => !!value && Object.keys(identity).every(key => value[key] === identity[key]);
const pathFor = collection => "collectionProgress." + (collection === "contentArticles" ? "pendingArticles" : "articleCache");
export function sourceFactSelectors(scope, guard) {
  if (guard === undefined) return [];
  if (!guard || Object.keys(guard).sort().join(",") !== "currentObservationId,factContentHash,jobId" ||
    [guard.jobId, guard.currentObservationId, guard.factContentHash].some(value => typeof value !== "string" || !value || value.length > 4096)) throw changed();
  return [rowSelector("targetMembers", scope, [rowKey(scope.targetRevisionId, guard.jobId)]),
    rowSelector("observations", scope, [guard.currentObservationId])];
}
/** The typed guard is checked again inside the job write's SQL transaction. */
export function assertSourceFactGuard(view, scope, guard) {
  sourceFactSelectors(scope, guard);
  const memberId = rowKey(scope.targetRevisionId, guard.jobId),
    member = view.rows.targetMembers?.[memberId], observation = view.rows.observations?.[guard.currentObservationId],
    fields = observation?.fields || observation?.record;
  if (!member || member.currentObservationId !== guard.currentObservationId ||
    member.factContentHash !== guard.factContentHash ||
    !member.factRefs?.some(ref => ref.observationId === guard.currentObservationId) ||
    observation?.ownerPackageId !== scope.packageId || observation.jobId !== guard.jobId ||
    (observation.targetRevisionId && observation.targetRevisionId !== scope.targetRevisionId) ||
    view.indexes.targetMembers?.[memberId]?.ownerPackageId !== scope.packageId ||
    view.indexes.targetMembers[memberId].targetRevisionId !== scope.targetRevisionId ||
    !fields || jobFactHash(fields) !== guard.factContentHash) throw changed();
  return fields;
}

/** Same newline boundaries and 300-character overlap as articleParts, without
 * retaining every chunk of a large body. Only the requested window is emitted. */
export function articlePartWindow(text, from = 0, limit = 200, size = 6000) {
  const parts = [];
  let index = 0;
  for (let start = 0; start < text.length; index++) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + size / 2) end = newline;
    }
    if (index >= from && parts.length < limit) parts.push({ partIndex: index, description: text.slice(start, end) });
    if (end >= text.length) { index++; break; }
    start = end - 300;
  }
  return { parts, partCount: index, hasMore: from + parts.length < index };
}

/** Prepare exactly one cache/pending window and at most one root/slice job page.
 * Publication, cache removal and cursor advancement are applied atomically. */
export async function prepareArticleRecovery(port, { ref, identity, units, signal, pageSize = 200, writeLimit = 200 }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200 ||
    !Number.isInteger(writeLimit) || writeLimit < 1 || writeLimit > 200) throw packageError("collection_queue_conflict", "正文恢复窗口无效。");
  signal?.throwIfAborted();
  const expected = new Map(), snapshots = { rows: {}, indexes: {} }, scope = ref.scope;
  const remember = (collection, id, value, indexes) => {
    expected.set(collection + "\0" + id, { collection, id, ownerPackageId: scope.packageId, hash: value == null ? null : contentHash(value) });
    (snapshots.rows[collection] ||= {})[id] = value;
    (snapshots.indexes[collection] ||= {})[id] = indexes;
  };
  const read = async selectors => {
    if (!selectors.length) return;
    signal?.throwIfAborted();
    const view = await port.readView({ select: selectors }, { scope });
    for (const selector of selectors) for (const id of selector.ids)
      remember(selector.collection, id, view.rows[selector.collection]?.[id], view.indexes[selector.collection]?.[id]);
  };
  const page = async (collection, parentId, path, afterId) => {
    signal?.throwIfAborted();
    const result = await port.queryRows({ collection, ownerPackageId: scope.packageId,
      where: { parentId, path }, limit: pageSize, total: false, ...(afterId ? { afterId } : {}) }, { scope });
    for (const row of result.rows) remember(collection, row.id, row.value, row.indexes);
    if (result.hasMore && !result.nextCursor) throw packageError("collection_queue_conflict", "正文恢复未取得后续游标。");
    return result;
  };
  await read([rowSelector("runs", scope, [ref.activityId])]);
  const root = collectionRoot(snapshots, ref), identityHash = contentHash(identity), previous = root.collectionProgress.articleRecovery;
  let marker = previous?.identityHash === identityHash && !["done"].includes(previous.phase)
    ? structuredClone(previous) : { identityHash, phase: "scan", cacheAfterId: null, pendingAfterId: null };
  const rows = new Map(), deletes = new Map(), preferredArticleIds = [], preferredPendingIds = [];
  const result = () => ({ select: collectionWriteSelectors([...expected.values(), ...rows.values()]),
    expected: [...expected.values()], rows: [...rows.values()], deletes: [...deletes.values()], marker,
    preferredArticleIds: [...new Set([...preferredArticleIds, ...preferredPendingIds])].slice(0, 10),
    incomplete: !["done", "blocked"].includes(marker.phase), needsRepair: marker.phase === "blocked",
    changed: contentHash(previous || null) !== contentHash(marker) || rows.size > 0 || deletes.size > 0 });
  if (marker.phase === "blocked") {
    const head = await port.readJobHead({ ownerPackageId: scope.packageId }, { scope });
    await read([rowSelector("articleCache", scope, marker.cacheIds || []), rowSelector("contentArticles", scope, marker.pendingIds || [])]);
    const queueHash = contentHash([...(marker.cacheIds || []).map(id => snapshots.rows.articleCache?.[id] || null),
      ...(marker.pendingIds || []).map(id => snapshots.rows.contentArticles?.[id] || null)]);
    if (head.head === marker.blockedFactHead && queueHash === marker.blockedQueueHash &&
      contentHash(units.map(({ unitId, sourceId, siteId }) => ({ unitId, sourceId, siteId }))) === marker.blockedUnitHash) return result();
    marker = { identityHash, phase: "scan", cacheAfterId: null, pendingAfterId: null };
  }
  if (marker.phase === "scan") {
    const cached = await page("articleCache", ref.activityId, pathFor("articleCache"), marker.cacheAfterId),
      pending = await page("contentArticles", ref.activityId, pathFor("contentArticles"), marker.pendingAfterId);
    const guarded = [...pending.rows, ...cached.rows].filter(row => row.value.recoverySourceFact);
    await read(collectionWriteSelectors(guarded.flatMap(row => sourceFactSelectors(scope, row.value.recoverySourceFact))
      .flatMap(selector => selector.ids.map(id => ({ collection: selector.collection, id, ownerPackageId: scope.packageId })))));
    const staleBasis = value => {
      if (!value.recoverySourceFact) return true;
      try { assertSourceFactGuard(snapshots, scope, value.recoverySourceFact); return false; }
      catch (error) { if (error.code !== "collection_source_fact_changed") throw error; return true; }
    };
    marker.cacheIds = cached.rows.filter(row => !matches(row.value, identity) || staleBasis(row.value)).map(row => row.id);
    marker.verifyPending = marker.verifyPending || marker.cacheIds.length > 0;
    marker.pendingIds = pending.rows.filter(row => {
      if (marker.verifyPending) return true;
      if (!matches(row.value.cacheIdentity, identity)) return true;
      if (!row.value.recoverySourceFact) return true;
      try { assertSourceFactGuard(snapshots, scope, row.value.recoverySourceFact); return false; }
      catch (error) { if (error.code !== "collection_source_fact_changed") throw error; return true; }
    }).map(row => row.id);
    marker.nextCacheAfterId = cached.hasMore ? cached.nextCursor : null;
    marker.nextPendingAfterId = pending.hasMore ? pending.nextCursor : null;
    marker.cacheHasMore = cached.hasMore;
    marker.pendingHasMore = pending.hasMore;
    if (!marker.cacheIds.length && !marker.pendingIds.length) {
      marker = cached.hasMore || pending.hasMore
        ? { identityHash, phase: "scan", cacheAfterId: marker.nextCacheAfterId, pendingAfterId: marker.nextPendingAfterId,
          verifyPending: marker.verifyPending && pending.hasMore }
        : { identityHash, phase: "done" };
      return result();
    }
    marker.phase = "root";
    marker.jobsAfterId = null;
    marker.sliceAfterId = null;
  } else {
    await read([rowSelector("articleCache", scope, marker.cacheIds || []), rowSelector("contentArticles", scope, marker.pendingIds || [])]);
    marker.cacheIds = (marker.cacheIds || []).filter(id => snapshots.rows.articleCache?.[id]);
    marker.pendingIds = (marker.pendingIds || []).filter(id => snapshots.rows.contentArticles?.[id]);
  }
  const finishWindow = () => {
    marker = marker.cacheHasMore || marker.pendingHasMore
      ? { identityHash, phase: "scan", cacheAfterId: marker.nextCacheAfterId, pendingAfterId: marker.nextPendingAfterId,
        verifyPending: marker.verifyPending && marker.pendingHasMore }
      : { identityHash, phase: "done" };
  };
  if (!marker.cacheIds.length && !marker.pendingIds.length) { finishWindow(); return result(); }
  let jobPage = marker.phase === "root" || marker.sliceId
    ? await page("activityJobIds", marker.phase === "root" ? ref.activityId : marker.sliceId,
      marker.phase === "root" ? "collectionProgress.newJobIds" : "jobIds", marker.jobsAfterId)
    : { rows: [], hasMore: false };
  if (marker.phase === "root" && !jobPage.rows.length) {
    marker.phase = "slices";
    marker.jobsAfterId = null;
  }
  if (marker.phase === "slices" && !marker.sliceId) {
    const slices = await port.queryCollectionSlicePage({ ...ref, afterId: marker.sliceAfterId || "", limit: 1 }, { scope });
    marker.sliceId = slices.sliceRunIds[0] || null;
    if (!marker.sliceId) {
      marker.phase = "blocked";
      marker.reasonCode = "article_cache_needs_repair";
      marker.blockedFactHead = (await port.readJobHead({ ownerPackageId: scope.packageId }, { scope })).head;
      marker.blockedQueueHash = contentHash([...marker.cacheIds.map(id => snapshots.rows.articleCache?.[id] || null),
        ...marker.pendingIds.map(id => snapshots.rows.contentArticles?.[id] || null)]);
      marker.blockedUnitHash = contentHash(units.map(({ unitId, sourceId, siteId }) => ({ unitId, sourceId, siteId })));
      return result();
    }
    jobPage = await page("activityJobIds", marker.sliceId, "jobIds", marker.jobsAfterId);
  }
  const jobIds = [...new Set(jobPage.rows.map(row => row.value).filter(id => typeof id === "string"))];
  await read([rowSelector("jobs", scope, jobIds), rowSelector("targetMembers", scope, jobIds.map(id => rowKey(scope.targetRevisionId, id)))]);
  const observationIds = [...new Set(jobIds.map(id => snapshots.rows.targetMembers?.[rowKey(scope.targetRevisionId, id)]?.currentObservationId).filter(Boolean))];
  await read([rowSelector("observations", scope, observationIds)]);
  let remaining = writeLimit, exhausted = false;
  for (const jobRow of jobPage.rows) {
    signal?.throwIfAborted();
    const jobId = jobRow.value, member = snapshots.rows.targetMembers?.[rowKey(scope.targetRevisionId, jobId)];
    const guard = { jobId, currentObservationId: member?.currentObservationId, factContentHash: member?.factContentHash };
    let record;
    try { record = assertSourceFactGuard(snapshots, scope, guard); } catch (error) {
      if (error.code !== "collection_source_fact_changed") throw error;
    }
    const unit = record && units.find(unit => unit.sourceId === record.sourceId && unit.siteId === record.siteId);
    const intent = record?.intent || (record && classifyRecruitmentIntent({ text: record.title + "\n" + record.description }).intent);
    if (!record || !snapshots.rows.jobs?.[jobId] || !unit || record.kind !== "recruitment_notice" ||
      !record.description || (record.bodyStatus && record.bodyStatus !== "complete") || intent !== "employer_recruitment") {
      marker.jobsAfterId = jobRow.id;
      continue;
    }
    const bodyHash = contentHash(record.description), key = contentKey(record),
      from = marker.part?.jobId === jobId && marker.part.bodyHash === bodyHash ? marker.part.index : 0,
      window = articlePartWindow(record.description, from, remaining),
      matchedCaches = marker.cacheIds.filter(id => {
        const value = snapshots.rows.articleCache[id];
        return value.record ? contentKey(value.record) === key : value.bodyHash === bodyHash;
      }), matchedPending = marker.pendingIds.filter(id => contentKey(snapshots.rows.contentArticles[id].record) === key);
    const desired = window.parts.map(({ partIndex, description }) => {
      const cacheIdentity = { ...identity, bodyHash }, value = { unitId: unit.unitId, partIndex,
        partCount: window.partCount, bodyHash, cacheIdentity, record: structuredClone({ ...record, description }),
        status: "pending", attempts: 0, recoverySourceFact: guard };
      return { key: articlePartKey(value), value };
    });
    await read([rowSelector("contentArticles", scope, desired.map(item => collectionPartId(ref.activityId, pathFor("contentArticles"), item.key))),
      rowSelector("articleCache", scope, desired.map(item => collectionPartId(ref.activityId, pathFor("articleCache"), item.key)))]);
    const retainedCacheIds = new Set();
    for (const item of desired) {
      const id = collectionPartId(ref.activityId, pathFor("contentArticles"), item.key),
        cacheId = collectionPartId(ref.activityId, pathFor("articleCache"), item.key),
        existing = snapshots.rows.contentArticles?.[id], cached = snapshots.rows.articleCache?.[cacheId];
      if (matches(cached, item.value.cacheIdentity)) {
        retainedCacheIds.add(cacheId);
        if (contentHash(cached.recoverySourceFact || null) !== contentHash(guard)) rows.set("articleCache\0" + cacheId, {
          collection: "articleCache", id: cacheId, ownerPackageId: scope.packageId,
          parent: { collection: "runs", id: ref.activityId, path: pathFor("articleCache") },
          runId: ref.activityId, targetRevisionId: scope.targetRevisionId,
          value: { ...cached, record: item.value.record, recoverySourceFact: guard },
        });
      }
      if (!matches(cached, item.value.cacheIdentity) &&
        (!existing || !matches(existing.cacheIdentity, item.value.cacheIdentity) ||
          contentHash(existing.recoverySourceFact || null) !== contentHash(guard))) {
        rows.set("contentArticles\0" + id, { collection: "contentArticles", id, ownerPackageId: scope.packageId,
          parent: { collection: "runs", id: ref.activityId, path: pathFor("contentArticles") },
          runId: ref.activityId, targetRevisionId: scope.targetRevisionId,
          value: existing ? { ...existing, ...item.value, status: existing.status || "pending", attempts: existing.attempts || 0 } : item.value });
      }
      if (matchedCaches.length) preferredArticleIds.push(id);
      else if (matchedPending.length) preferredPendingIds.push(id);
    }
    remaining -= desired.length;
    if (window.hasMore) {
      marker.part = { jobId, bodyHash, index: from + desired.length };
      exhausted = true;
      break;
    }
    delete marker.part;
    for (const id of matchedCaches) {
      const cached = snapshots.rows.articleCache[id];
      // A prior bounded window may already have promoted this current cache.
      // Recheck its persisted proof, rather than retaining an unbounded ID list.
      const retainedEarlier = matches(cached, { ...identity, bodyHash }) && cached.record &&
        contentHash(cached.recoverySourceFact || null) === contentHash(guard) &&
        id === collectionPartId(ref.activityId, pathFor("articleCache"), articlePartKey({
          record: cached.record, cacheIdentity: { ...identity, bodyHash },
        }));
      if (!retainedCacheIds.has(id) && !retainedEarlier)
        deletes.set("articleCache\0" + id, { collection: "articleCache", id });
    }
    for (const id of matchedPending) {
      const old = snapshots.rows.contentArticles[id], canonicalKey = old.bodyHash === bodyHash
        ? articlePartKey({ ...old, cacheIdentity: { ...identity, bodyHash } }) : null;
      if (!canonicalKey || id !== collectionPartId(ref.activityId, pathFor("contentArticles"), canonicalKey))
        deletes.set("contentArticles\0" + id, { collection: "contentArticles", id });
    }
    marker.cacheIds = marker.cacheIds.filter(id => !matchedCaches.includes(id));
    marker.pendingIds = marker.pendingIds.filter(id => !matchedPending.includes(id));
    marker.jobsAfterId = jobRow.id;
    if (!marker.cacheIds.length && !marker.pendingIds.length) { finishWindow(); break; }
    if (remaining === 0) { exhausted = true; break; }
  }
  if (["root", "slices"].includes(marker.phase) && !exhausted && !jobPage.hasMore) {
    if (marker.phase === "root") marker.phase = "slices";
    else { marker.sliceAfterId = marker.sliceId; marker.sliceId = null; }
    marker.jobsAfterId = null;
  }
  signal?.throwIfAborted();
  return result();
}

export function applyArticleRecovery(tx, plan) {
  for (const expected of plan.expected) {
    const value = tx.getRow({ collection: expected.collection, id: expected.id });
    if ((value == null ? null : contentHash(value)) !== expected.hash)
      throw packageError("collection_queue_conflict", "正文恢复准备期间内容已变化，请继续原进度。");
  }
  for (const row of plan.rows) tx.putRow(row);
  for (const row of plan.deletes) tx.deleteRow(row);
}
