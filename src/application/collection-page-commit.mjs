import { packageError } from "../domain/packages.mjs";
import { contentHash } from "../infrastructure/storage/content-hash.mjs";
import {
  collectionPartId,
  collectionRoot,
  collectionToken,
  collectionLease,
  leaseSelector,
  rowSelector,
} from "./collection-row-access.mjs";
import { queueContentDraft, contentKey } from "../sources/content-queue.mjs";
import { articleCacheIdentity } from "../llm/prompt-registry.mjs";
import { sourceRefreshDelay } from "../sources/source-quality.mjs";
import {
  deriveCollectionSourceHealth,
  isUnattemptedSourceResult,
} from "./collection-source-health.mjs";
import { mergeSourceHealth } from "./source-health.mjs";
import {
  isVersionPrivateSource,
  safeSourceIssues,
} from "../sources/source-status.mjs";

const queues = [
  ["pendingBodies", "contentBodies"],
  ["pendingArticles", "contentArticles"],
  ["articleCache", "articleCache"],
  ["pendingOfficialLinks", "contentLinks"],
  ["officialLinkCache", "officialLinkCache"],
];
export function collectionWriteSelectors(records) {
  const groups = new Map();
  for (const record of records) {
    const key = JSON.stringify([
      record.collection,
      record.ownerPackageId || null,
    ]);
    if (!groups.has(key))
      groups.set(key, {
        collection: record.collection,
        ...(record.ownerPackageId
          ? { ownerPackageId: record.ownerPackageId }
          : {}),
        ids: [],
      });
    groups.get(key).ids.push(record.id);
  }
  const selectors = [];
  for (const group of groups.values()) {
    const ids = [...new Set(group.ids)];
    for (let offset = 0; offset < ids.length; offset += 1000)
      selectors.push({ ...group, ids: ids.slice(offset, offset + 1000) });
  }
  return selectors;
}
const arrayDefinitions = [
  ["activityJobIds", "collectionProgress.newJobIds", "root"],
  ["activityJobIds", "jobIds", "slice"],
  ["runEvaluationIds", "evaluationIds", "slice"],
  ["runIssues", "issues", "slice"],
];
function nextOrdinal(view, collection, parentId, path) {
  return Object.values(view.indexes[collection] || {})
    .filter((index) => index.parentId === parentId && index.path === path)
    .reduce((max, index) => Math.max(max, index.ordinal + 1), 0);
}
export async function prepareCollectionArrayAppends(
  repository,
  { ref, token, newJobIds = [], jobIds = [], evaluationIds = [], issues = [] },
) {
  const scope = ref.scope,
    select = arrayDefinitions.map(([collection, path, parent]) => ({
      collection,
      ownerPackageId: scope.packageId,
      where: {
        parentId: parent === "root" ? ref.activityId : token.sliceRunId,
        path,
      },
      orderBy: "ordinal",
      direction: "desc",
      limit: 1,
      total: false,
    }));
  for (let offset = 0; offset < jobIds.length; offset += 100)
    select.push({
      collection: "activityJobIds",
      ownerPackageId: scope.packageId,
      where: {
        parentId: token.sliceRunId,
        path: "jobIds",
        jobId: { in: jobIds.slice(offset, offset + 100) },
      },
      limit: 200,
      total: false,
    });
  for (let offset = 0; offset < evaluationIds.length; offset += 100)
    select.push({
      collection: "runEvaluationIds",
      ownerPackageId: scope.packageId,
      where: {
        parentId: token.sliceRunId,
        path: "evaluationIds",
        resourceKey: { in: evaluationIds.slice(offset, offset + 100) },
      },
      limit: 200,
      total: false,
    });
  const view = await repository.readView({ select }, { scope }),
    parts = arrayDefinitions.map(([collection, path, parent]) => ({
      collection,
      path,
      parentId: parent === "root" ? ref.activityId : token.sliceRunId,
      nextOrdinal: nextOrdinal(
        view,
        collection,
        parent === "root" ? ref.activityId : token.sliceRunId,
        path,
      ),
    }));
  const existingJobs = new Set(
    Object.entries(view.rows.activityJobIds || {})
      .filter(
        ([id]) =>
          view.indexes.activityJobIds[id].parentId === token.sliceRunId &&
          view.indexes.activityJobIds[id].path === "jobIds",
      )
      .map(([, value]) => value),
  );
  const existingEvaluations = new Set(
    Object.values(view.rows.runEvaluationIds || {}),
  );
  const values = [
    [...new Set(newJobIds)],
    [...new Set(jobIds)].filter((id) => !existingJobs.has(id)),
    [...new Set(evaluationIds)].filter((id) => !existingEvaluations.has(id)),
    issues,
  ];
  const records = parts.flatMap((part, index) =>
    values[index].map((value, offset) => ({
      collection: part.collection,
      id: collectionPartId(part.parentId, part.path, part.nextOrdinal + offset),
      ownerPackageId: scope.packageId,
      parent: { collection: "runs", id: part.parentId, path: part.path },
      runId: part.parentId,
      targetRevisionId: scope.targetRevisionId,
      ordinal: part.nextOrdinal + offset,
      value,
      ...(part.collection === "activityJobIds" ? { jobId: value } : {}),
    })),
  );
  return { parts, records, select };
}
export function assertCollectionArrayAppends(tx, append) {
  for (const part of append.parts)
    if (
      nextOrdinal(tx.view, part.collection, part.parentId, part.path) !==
      part.nextOrdinal
    )
      throw packageError(
        "collection_queue_conflict",
        "活动追加序列已变化，请重新准备。",
        409,
      );
}
/** Fixed collection page command prepared outside the write fence. No functions or workspace view. */
function diagnosticReplay() {
  return packageError(
    "collection_diagnostic_replayed",
    "来源重查结果已提交，请读取原持久结果。",
    409,
  );
}
function assertDiagnosticAuthority(view, { ref, token, operationLease }) {
  const root = collectionRoot(view, ref);
  collectionToken(root.collectionProgress, token);
  collectionLease(view, ref.scope, operationLease);
  if (root.collectionProgress.operationId !== operationLease.operationId)
    throw packageError(
      "invalid_operation_lease",
      "来源重查结果不属于原活动租约。",
    );
  const child = view.rows.runs?.[token.sliceRunId];
  if (
    !child ||
    child.collectionActivityId !== ref.activityId ||
    view.indexes.runs?.[child.runId]?.targetRevisionId !==
      ref.scope.targetRevisionId
  )
    throw packageError("collection_scope", "来源重查子活动范围无效。");
  return { root, child };
}
async function prepareCollectionDiagnosticCommit(
  repository,
  {
    ref,
    token,
    scope = ref?.scope,
    unitId,
    observationKey,
    records: sourceRecords,
    issues = [],
    ingestResult,
    operationLease,
    now = repository.clock.now(),
    privateSource = false,
  },
) {
  if (
    !ref ||
    scope?.packageId !== ref.scope.packageId ||
    scope.targetRevisionId !== ref.scope.targetRevisionId ||
    !token ||
    !operationLease ||
    !Array.isArray(sourceRecords) ||
    sourceRecords.length > 1000 ||
    typeof observationKey !== "string" ||
    !/^[A-Za-z0-9_.-]{1,160}$/.test(observationKey)
  )
    throw packageError(
      "collection_diagnostic_invalid",
      "来源重查提交参数无效。",
      400,
    );
  const unitKey = collectionPartId(
      ref.activityId,
      "collectionProgress.units",
      unitId,
    ),
    markerId = collectionPartId(
      ref.activityId,
      "diagnostic",
      contentHash(observationKey),
    ),
    base = [
      rowSelector("runs", scope, [ref.activityId, token.sliceRunId]),
      rowSelector("activityUnits", scope, [unitKey]),
      rowSelector("sourceRotation", scope, [markerId]),
      rowSelector("activityMetrics", scope, [ref.activityId]),
      leaseSelector(operationLease),
    ];
  const view = await repository.readView({ select: base }, { scope }),
    { root, child } = assertDiagnosticAuthority(view, {
      ref,
      token,
      operationLease,
    }),
    unit = view.rows.activityUnits?.[unitKey];
  const previous = view.rows.sourceRotation?.[markerId];
  if (previous) {
    if (previous.unitId !== unitId)
      throw packageError(
        "collection_diagnostic_key_conflict",
        "来源重查标识已属于另一采集单元。",
      );
    throw diagnosticReplay();
  }
  collectionToken(root.collectionProgress, token, { revision: true });
  if (!unit) throw packageError("collection_unit_missing", "未找到采集单元。");
  if (
    sourceRecords.some(
      (record) =>
        record.sourceId !== unit.sourceId || record.siteId !== unit.siteId,
    )
  )
    throw packageError(
      "collection_diagnostic_source_mismatch",
      "来源重查结果与原采集单元不一致。",
    );
  const health = isUnattemptedSourceResult({ records: sourceRecords, issues })
      ? null
      : deriveCollectionSourceHealth({
          sourceId: unit.sourceId,
          siteId: unit.siteId,
          records: sourceRecords,
          issues,
          now,
        }),
    healthKey = unit.sourceId + "/" + unit.siteId,
    privateHealth =
      privateSource || isVersionPrivateSource({ id: unit.sourceId }),
    healthSelect = privateHealth
      ? { collection: "packages", ids: [scope.packageId] }
      : { collection: "sourceHealth", ids: [healthKey] };
  const append = await prepareCollectionArrayAppends(repository, {
      ref,
      token,
      newJobIds: ingestResult.newForTarget,
      jobIds: ingestResult.jobIds,
      issues: safeSourceIssues(issues, unit.sourceId, unit.siteId),
    }),
    at = new Date(now).toISOString(),
    result = {
      duplicate: false,
      revision: root.collectionProgress.revision + 1,
      sliceRunId: token.sliceRunId,
      ...ingestResult,
    };
  const records = [
    ...append.records,
    {
      collection: "runs",
      id: ref.activityId,
      ownerPackageId: scope.packageId,
      value: root,
    },
    {
      collection: "runs",
      id: token.sliceRunId,
      ownerPackageId: scope.packageId,
      value: child,
    },
    {
      collection: "activityMetrics",
      id: ref.activityId,
      ownerPackageId: scope.packageId,
      value: view.rows.activityMetrics[ref.activityId],
    },
    {
      collection: "sourceRotation",
      id: markerId,
      ownerPackageId: scope.packageId,
      runId: ref.activityId,
      targetRevisionId: scope.targetRevisionId,
      value: { unitId, result, observedAt: at },
    },
  ];
  if (health)
    records.push(
      privateHealth
        ? { collection: "packages", id: scope.packageId, value: {} }
        : { collection: "sourceHealth", id: healthKey, value: {} },
    );
  return {
    kind: "diagnostic",
    ref: structuredClone(ref),
    token: structuredClone(token),
    operationLease: {
      operationId: operationLease.operationId,
      token: operationLease.token,
    },
    unitId,
    unitKey,
    unitFingerprint: contentHash(unit),
    markerId,
    at,
    counts: {
      raw: sourceRecords.length,
      normalized: sourceRecords.length,
      newForTarget: ingestResult.newForTarget.length,
      notices: sourceRecords.filter((record) => record.kind !== "job").length,
      issues: issues.length,
    },
    append: { parts: append.parts },
    health: health
      ? { key: healthKey, result: health, now, private: privateHealth }
      : null,
    records,
    select: [...base, ...append.select, ...(health ? [healthSelect] : [])],
    result,
  };
}
function applyCollectionDiagnosticCommit(tx, prepared) {
  const { root, child } = assertDiagnosticAuthority(tx.view, prepared),
    p = root.collectionProgress;
  const previous = tx.getRow({
    collection: "sourceRotation",
    id: prepared.markerId,
  });
  if (previous) {
    if (previous.unitId !== prepared.unitId)
      throw packageError(
        "collection_diagnostic_key_conflict",
        "来源重查标识已属于另一采集单元。",
      );
    throw diagnosticReplay();
  }
  collectionToken(p, prepared.token, { revision: true });
  const unit = tx.getRow({ collection: "activityUnits", id: prepared.unitKey });
  if (!unit || contentHash(unit) !== prepared.unitFingerprint)
    throw packageError(
      "collection_progress_conflict",
      "来源重查单元已变化，请刷新。",
      409,
    );
  assertCollectionArrayAppends(tx, prepared.append);
  child.counts ||= {};
  for (const key of ["raw", "normalized", "newForTarget", "notices"])
    child.counts[key] = (child.counts[key] || 0) + prepared.counts[key];
  child.counts.deduplicated =
    (child.counts.deduplicated || 0) +
    prepared.records.filter(
      (row) => row.collection === "activityJobIds" && row.runId === child.runId,
    ).length;
  child.issueCount = (child.issueCount || 0) + prepared.counts.issues;
  p.metrics ||= {};
  p.metrics.newUnique =
    (p.metrics.newUnique || 0) + prepared.counts.newForTarget;
  p.revision++;
  p.updatedAt = prepared.at;
  const metrics = tx.getRow({
    collection: "activityMetrics",
    id: root.runId,
  }) || { version: 1 };
  Object.assign(metrics, p.metrics);
  prepared.result.revision = p.revision;
  for (const row of prepared.records) {
    if (row.collection === "runs")
      row.value = row.id === root.runId ? root : child;
    if (row.collection === "activityMetrics") row.value = metrics;
    if (row.collection === "sourceRotation") row.value.result = prepared.result;
    if (row.collection === "sourceHealth")
      row.value = mergeSourceHealth(
        tx.getRow({ collection: "sourceHealth", id: prepared.health.key }),
        prepared.health.result,
        prepared.health.now,
      );
    if (row.collection === "packages") {
      const pkg = tx.getRow({
        collection: "packages",
        id: prepared.ref.scope.packageId,
      });
      pkg.collectionSettings ||= {
        sourceOverrides: {},
        sessionRefs: {},
        refreshEnabled: false,
      };
      pkg.collectionSettings.sourceVerification ||= {};
      pkg.collectionSettings.sourceVerification[prepared.health.key] =
        mergeSourceHealth(
          pkg.collectionSettings.sourceVerification[prepared.health.key],
          prepared.health.result,
          prepared.health.now,
        );
      row.value = pkg;
    }
  }
  return prepared.result;
}
export async function prepareCollectionPageCommit(repository, input) {
  if (input?.kind === "diagnostic")
    return prepareCollectionDiagnosticCommit(repository, input);
  if (input?.kind !== undefined)
    throw packageError(
      "collection_page_invalid",
      "采集页面提交类型无效。",
      400,
    );
  return prepareCollectionListPageCommit(repository, input);
}
async function prepareCollectionListPageCommit(
  repository,
  {
    ref,
    token,
    unitId,
    page,
    scope = ref?.scope,
    ingestResult,
    modelConfig,
    now = repository.clock.now(),
    privateSource = false,
  },
) {
  if (
    !ref ||
    scope.packageId !== ref.scope.packageId ||
    scope.targetRevisionId !== ref.scope.targetRevisionId ||
    !token ||
    !page ||
    !Array.isArray(page.records) ||
    page.records.length > 1000
  )
    throw packageError("collection_page_invalid", "采集页面结果无效。", 400);
  const unitKey = collectionPartId(
    ref.activityId,
    "collectionProgress.units",
    unitId,
  );
  const base = [
    rowSelector("runs", scope, [ref.activityId, token.sliceRunId]),
    rowSelector("activityUnits", scope, [unitKey]),
    rowSelector("activityMetrics", scope, [ref.activityId]),
    { collection: "packages", ids: [scope.packageId] },
  ];
  const view = await repository.readView({ select: base }, { scope }),
    root = collectionRoot(view, ref),
    p = root.collectionProgress,
    unit = view.rows.activityUnits?.[unitKey],
    child = view.rows.runs?.[token.sliceRunId];
  collectionToken(p, token);
  if (!unit || !child || child.collectionActivityId !== ref.activityId)
    throw packageError("collection_unit_missing", "未找到采集单元。");
  if (unit.committedPageKeys.includes(page.pageKey))
    throw packageError(
      "collection_page_replayed",
      "页面已提交，请读取持久进度。",
      409,
    );
  const unitFingerprint = contentHash(unit),
    at = new Date(now).toISOString(),
    fresh = {};
  queueContentDraft(
    fresh,
    unitId,
    page.records,
    Number(now),
    articleCacheIdentity({ modelConfig }),
  );
  const queueSelect = [];
  for (const [path, collection] of queues) {
    const keys = Object.keys(fresh[path] || {});
    if (path === "pendingBodies") keys.push(...page.records.map(contentKey));
    if (path === "articleCache")
      keys.push(...Object.keys(fresh.pendingArticles || {}));
    if (path === "officialLinkCache")
      keys.push(...Object.keys(fresh.pendingOfficialLinks || {}));
    if (keys.length)
      queueSelect.push(
        rowSelector(
          collection,
          scope,
          [...new Set(keys)].map((key) =>
            collectionPartId(ref.activityId, "collectionProgress." + path, key),
          ),
        ),
      );
  }
  const healthKey = unit.sourceId + "/" + unit.siteId,
    privateHealth =
      privateSource || isVersionPrivateSource({ id: unit.sourceId }),
    healthSelect = privateHealth
      ? { collection: "packages", ids: [scope.packageId] }
      : { collection: "sourceHealth", ids: [healthKey] };
  const details = await repository.readView(
      { select: [...queueSelect, healthSelect] },
      { scope },
    ),
    progress = {};
  for (const [path, collection] of queues)
    progress[path] = Object.fromEntries(
      Object.entries(details.rows[collection] || {}).map(([id, value]) => [
        JSON.parse(id).at(-1),
        value,
      ]),
    );
  queueContentDraft(
    progress,
    unitId,
    page.records,
    Number(now),
    articleCacheIdentity({ modelConfig }),
  );
  const records = [];
  const part = (collection, runId, path, key, value, extra = {}) => ({
    collection,
    id: collectionPartId(runId, path, key),
    ownerPackageId: scope.packageId,
    parent: { collection: "runs", id: runId, path },
    runId,
    targetRevisionId: scope.targetRevisionId,
    value,
    ...extra,
  });
  for (const [path, collection] of queues) {
    const kept = new Set(
      Object.keys(progress[path] || {}).map((key) =>
        collectionPartId(ref.activityId, "collectionProgress." + path, key),
      ),
    );
    for (const selector of queueSelect.filter(
      (selector) => selector.collection === collection,
    ))
      for (const id of selector.ids)
        if (details.rows[collection]?.[id] && !kept.has(id))
          records.push({
            collection,
            id,
            ownerPackageId: scope.packageId,
            remove: true,
          });
    for (const [key, value] of Object.entries(progress[path] || {}))
      records.push(
        part(
          collection,
          ref.activityId,
          "collectionProgress." + path,
          key,
          value,
        ),
      );
  }
  const health = isUnattemptedSourceResult({
    records: page.records,
    issues: page.issues || [],
  })
    ? null
    : deriveCollectionSourceHealth({
        sourceId: unit.sourceId,
        siteId: unit.siteId,
        records: page.records,
        issues: page.issues || [],
        now,
      });
  if (health && page.notModified && page.conditionalResponse?.evidenceCheckedAt)
    health.evidenceCheckedAt = page.conditionalResponse.evidenceCheckedAt;
  if (health && !privateHealth)
    records.push({
      collection: "sourceHealth",
      id: healthKey,
      value: mergeSourceHealth(
        details.rows.sourceHealth?.[healthKey],
        health,
        now,
      ),
    });
  const append = await prepareCollectionArrayAppends(repository, {
    ref,
    token,
    newJobIds: ingestResult.newForTarget,
    jobIds: ingestResult.jobIds,
    issues: safeSourceIssues(page.issues || [], unit.sourceId, unit.siteId),
  });
  records.push(...append.records);
  unit.committedPageKeys.push(page.pageKey);
  unit.committedPages++;
  unit.roundPages = (unit.roundPages || 0) + 1;
  unit.cursor = page.done ? null : structuredClone(page.nextCursor);
  unit.status = page.done ? "completed" : "pending";
  unit.lastErrorCode = null;
  if (!page.done && unit.roundPages >= p.limits.maxPagesPerQuery) {
    unit.status = "page_limited";
    unit.lastErrorCode = "page_limit_reached";
  }
  unit.lastSuccessAt = at;
  unit.lastAttemptAt = at;
  unit.refreshDelayMs = sourceRefreshDelay({
    changes: ingestResult.newForTarget.length,
    total: page.records.length,
    previousMs: unit.refreshDelayMs,
  });
  unit.seenCursorHashes ||= [];
  if (page.cursorHash && !unit.seenCursorHashes.includes(page.cursorHash))
    unit.seenCursorHashes.push(page.cursorHash);
  if (
    page.done &&
    view.rows.packages[scope.packageId].collectionSettings?.refreshEnabled
  ) {
    unit.status = "pending";
    unit.nextDueAt = new Date(Number(now) + unit.refreshDelayMs).toISOString();
    unit.refreshRound = (unit.refreshRound || 0) + 1;
    unit.roundPages = 0;
    unit.seenCursorHashes = [];
  }
  unit.seenIds = [
    ...new Set([
      ...(unit.seenIds || []),
      ...page.records
        .filter(
          (record) =>
            !record.retryEligible &&
            (!record.bodyStatus || record.bodyStatus === "complete"),
        )
        .map(contentKey),
    ]),
  ].slice(-5000);
  records.push({
    collection: "activityUnits",
    id: unitKey,
    ownerPackageId: scope.packageId,
    value: unit,
  });
  // These placeholders are replaced from the actual transaction rows in apply.
  records.push(
    {
      collection: "runs",
      id: ref.activityId,
      ownerPackageId: scope.packageId,
      value: root,
    },
    {
      collection: "runs",
      id: token.sliceRunId,
      ownerPackageId: scope.packageId,
      value: child,
    },
    {
      collection: "activityMetrics",
      id: ref.activityId,
      ownerPackageId: scope.packageId,
      value: view.rows.activityMetrics[ref.activityId],
    },
  );
  if (health && privateHealth)
    records.push({
      collection: "packages",
      id: scope.packageId,
      value: view.rows.packages[scope.packageId],
    });
  const result = {
    duplicate: false,
    committedPages: unit.committedPages,
    revision: p.revision + 1,
    ...ingestResult,
  };
  return {
    ref: structuredClone(ref),
    token: structuredClone(token),
    unitId,
    unitKey,
    unitFingerprint,
    pageKey: page.pageKey,
    at,
    counts: {
      raw: page.raw ?? page.records.length,
      normalized: page.records.length,
      newForTarget: ingestResult.newForTarget.length,
      notices: page.records.filter((record) => record.kind !== "job").length,
      issues: (page.issues || []).length,
    },
    dependencies: queueSelect.flatMap((selector) =>
      selector.ids.map((id) => ({
        collection: selector.collection,
        id,
        hash:
          details.rows[selector.collection]?.[id] === undefined
            ? null
            : contentHash(details.rows[selector.collection][id]),
      })),
    ),
    health: health
      ? { key: healthKey, result: health, now, private: privateHealth }
      : null,
    append: { parts: append.parts },
    records,
    select: [...base, ...queueSelect, healthSelect, ...append.select],
    result,
  };
}
/** Validate current authority and merge only page deltas into fresh heads. */
export function applyCollectionPageCommit(tx, prepared) {
  if (prepared.kind === "diagnostic")
    return applyCollectionDiagnosticCommit(tx, prepared);
  const root = collectionRoot(tx.view, prepared.ref),
    p = root.collectionProgress;
  collectionToken(p, prepared.token);
  assertCollectionArrayAppends(tx, prepared.append);
  const unit = tx.getRow({ collection: "activityUnits", id: prepared.unitKey });
  if (!unit || contentHash(unit) !== prepared.unitFingerprint)
    throw packageError(
      "collection_progress_conflict",
      "页面游标已变化，请刷新。",
      409,
    );
  for (const dependency of prepared.dependencies) {
    const value = tx.getRow({
      collection: dependency.collection,
      id: dependency.id,
    });
    if ((value === null ? null : contentHash(value)) !== dependency.hash)
      throw packageError(
        "collection_queue_conflict",
        "内容任务已变化，请重新准备页面提交。",
        409,
      );
  }
  const child = tx.getRow({
    collection: "runs",
    id: prepared.token.sliceRunId,
  });
  if (!child || child.collectionActivityId !== root.runId)
    throw packageError("collection_scope", "采集子活动范围无效。");
  const pkg = tx.getRow({
    collection: "packages",
    id: prepared.ref.scope.packageId,
  });
  const nextUnit = prepared.records.find(
    (row) => row.collection === "activityUnits" && row.id === prepared.unitKey,
  ).value;
  if (
    nextUnit.status === "completed" &&
    pkg.collectionSettings?.refreshEnabled
  ) {
    nextUnit.status = "pending";
    nextUnit.nextDueAt = new Date(
      Date.parse(prepared.at) + nextUnit.refreshDelayMs,
    ).toISOString();
    nextUnit.refreshRound = (nextUnit.refreshRound || 0) + 1;
    nextUnit.roundPages = 0;
    nextUnit.seenCursorHashes = [];
  }
  const additions = prepared.records
    .filter(
      (row) => row.collection === "activityJobIds" && row.runId === child.runId,
    )
    .filter(
      (row) => !tx.getRow({ collection: "activityJobIds", id: row.id }),
    ).length;
  child.counts ||= {};
  for (const key of ["raw", "normalized", "newForTarget", "notices"])
    child.counts[key] = (child.counts[key] || 0) + prepared.counts[key];
  child.counts.deduplicated = (child.counts.deduplicated || 0) + additions;
  child.issueCount = (child.issueCount || 0) + prepared.counts.issues;
  p.metrics ||= {};
  p.metrics.committedPages = (p.metrics.committedPages || 0) + 1;
  p.metrics.newUnique =
    (p.metrics.newUnique || 0) + prepared.counts.newForTarget;
  p.revision++;
  p.updatedAt = prepared.at;
  const metrics = tx.getRow({
    collection: "activityMetrics",
    id: root.runId,
  }) || { version: 1 };
  Object.assign(metrics, p.metrics);
  for (const row of prepared.records) {
    if (row.collection === "runs" && row.id === root.runId) row.value = root;
    if (row.collection === "runs" && row.id === child.runId) row.value = child;
    if (row.collection === "activityMetrics" && row.id === root.runId)
      row.value = metrics;
    if (row.collection === "packages" && prepared.health?.private) {
      const pkg = tx.getRow({
        collection: "packages",
        id: prepared.ref.scope.packageId,
      });
      pkg.collectionSettings ||= {
        sourceOverrides: {},
        sessionRefs: {},
        refreshEnabled: false,
      };
      pkg.collectionSettings.sourceVerification ||= {};
      pkg.collectionSettings.sourceVerification[prepared.health.key] =
        mergeSourceHealth(
          pkg.collectionSettings.sourceVerification[prepared.health.key],
          prepared.health.result,
          prepared.health.now,
        );
      row.value = pkg;
    }
    if (
      row.collection === "sourceHealth" &&
      prepared.health &&
      !prepared.health.private
    )
      row.value = mergeSourceHealth(
        tx.getRow({ collection: "sourceHealth", id: prepared.health.key }),
        prepared.health.result,
        prepared.health.now,
      );
  }
  prepared.result.revision = p.revision;
  return prepared.result;
}
