import {
  collectionWriteSelectors,
  prepareCollectionArrayAppends,
  assertCollectionArrayAppends,
} from "./collection-page-commit.mjs";
import { randomUUID } from "node:crypto";
import { packageError } from "../domain/packages.mjs";
import { createCollectionRoot } from "../domain/collection.mjs";
import {
  emptyCollectionUsage,
  collectionUsageSnapshot,
  COLLECTION_PROJECTION_VERSION,
  changeCollectionUsage,
} from "../domain/collection-projections.mjs";
import { contentHash } from "../infrastructure/storage/content-hash.mjs";
import {
  SPLIT_PARTS,
  pathValue,
  deletePath,
  rowKey,
} from "../infrastructure/storage/sqlite-records.mjs";
import { createPackageJobService } from "./package-job-service.mjs";
import { collectionLimitsFor } from "../../public/js/validation-rules.js";
import {
  collectionPartId,
  rowSelector,
  collectionRoot,
  collectionLease,
  collectionToken,
  leaseSelector,
  putCollectionPart,
  readCollectionHead,
} from "./collection-row-access.mjs";
import { createActivityBudgets } from "./collection-ledger.mjs";
import { readProviderPage } from "../sources/collection-page.mjs";
import { sourceRefreshDelay } from "../sources/source-quality.mjs";
import { queueContentDraft, contentKey } from "../sources/content-queue.mjs";
import { articleCacheIdentity } from "../llm/prompt-registry.mjs";
import { createRecordEnrichment } from "./record-enrichment.mjs";
import { assessRecruitmentEvidence } from "../domain/recruitment-evidence.mjs";
import {
  deriveCollectionSourceHealth,
  isUnattemptedSourceResult,
} from "./collection-source-health.mjs";
import { mergeSourceHealth } from "./source-health.mjs";
import {
  safeSourceIssues,
  safeSourceDiagnosticRefs,
  isVersionPrivateSource,
} from "../sources/source-status.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
import { normalizeRecord } from "../domain/record.mjs";
import { expandArticles } from "../match/article.mjs";
import { cancellableSleep } from "../infrastructure/http/scheduler.mjs";
import { createConditionalCache } from "../infrastructure/http/conditional-cache.mjs";
import { assertSourceRecord } from "../domain/contracts.mjs";
import { persistConditionalPage } from "../infrastructure/http/collection-conditional-request.mjs";
import { hasLiveOwner } from "../infrastructure/storage/process-owner.mjs";
import { prepareArticleRecovery, applyArticleRecovery, sourceFactSelectors, assertSourceFactGuard } from "./collection-article-recovery.mjs";

const terminal = new Set(["completed", "cancelled"]);
const idValid = (id) =>
  typeof id === "string" && /^[A-Za-z0-9_.-]{1,160}$/.test(id);
const stale = () =>
  packageError("collection_stale_epoch", "活动已停止或进度已变化，请刷新。");
const riskCodes = new Set([
  "boss_account_risk",
  "boss_environment_risk",
  "boss_risk_blocked",
]);
const authCodes = new Set([
  ...riskCodes,
  "boss_auth_expired",
  "boss_login_required",
  "login_required",
  "challenge_required",
  "restricted",
  "captcha",
  "http_forbidden",
]);
const queues = [
  ["pendingBodies", "contentBodies"],
  ["pendingArticles", "contentArticles"],
  ["articleCache", "articleCache"],
  ["pendingOfficialLinks", "contentLinks"],
  ["officialLinkCache", "officialLinkCache"],
];

/** Split a newly created run only. This never exports or diffs a workspace. */
function newRunRows(run, scope) {
  const head = structuredClone(run),
    children = [],
    emptyParts = [];
  if (run.collectionRole === "collection_slice" && !head.jobIds)
    head.jobIds = [];
  for (const [path, collection, shape] of SPLIT_PARTS.runs) {
    const value = pathValue(head, path);
    if (value === undefined) continue;
    const entries =
      shape === "value" ? [["value", value]] : Object.entries(value || {});
    if (entries.length === 0) emptyParts.push(path);
    for (const [ordinal, [key, item]] of entries.entries())
      children.push({
        collection,
        id: collectionPartId(run.runId, path, key),
        ownerPackageId: scope.packageId,
        parent: { collection: "runs", id: run.runId, path },
        runId: run.runId,
        targetRevisionId: scope.targetRevisionId,
        ordinal,
        value: item,
      });
    deletePath(head, path);
  }
  return [
    {
      collection: "runs",
      id: run.runId,
      ownerPackageId: scope.packageId,
      targetRevisionId: scope.targetRevisionId,
      value: head,
      emptyParts,
    },
    ...children,
  ];
}
const selectorsFor = collectionWriteSelectors;
function writeNewRunRows(tx, rows) {
  for (const { emptyParts, ...row } of rows) tx.putRow(row);
  for (const row of rows)
    for (const path of row.emptyParts || [])
      tx.ensurePart({ collection: row.collection, id: row.id, path });
}
const tokenFor = (root) => ({
  epoch: root.collectionProgress.epoch,
  expectedRevision: root.collectionProgress.revision,
  sliceRunId: root.collectionProgress.activeSliceRunId,
});

export function createRowCollectionService({
  repository,
  operationGate,
  registry,
  requestFactory,
  ledger,
  clock = repository.clock,
  events,
  planner,
  readService,
  attachmentService,
  evaluationService,
  jobService,
  modelFactory,
  modelConfig,
  runGate,
  diagnostics,
  officialSites = [],
  ensureCollectionRuntime,
}) {
  const active = new Map(),
    drains = new Map();
  let stopping = false;
  const at = () => new Date(clock.now()).toISOString();
  const jobs = jobService || createPackageJobService({ repository, clock });
  const conditionalCache = createConditionalCache({ repository, clock });
  const enrich = createRecordEnrichment({
    clock,
    diagnostics,
    officialSites,
    getAttachmentService: () => attachmentService,
  });
  function assertStarting() {
    if (stopping)
      throw packageError(
        "collection_stopping",
        "采集服务正在关闭，请重新启动。",
        503,
      );
  }
  async function head(ref) {
    return readCollectionHead(repository, ref);
  }
  async function partPage(
    ref,
    collection,
    path,
    { limit = 200, afterId, where = {} } = {},
  ) {
    return repository.queryRows(
      {
        collection,
        ownerPackageId: ref.scope.packageId,
        where: { parentId: ref.activityId, path, ...where },
        limit,
        ...(afterId ? { afterId } : {}),
      },
      { scope: ref.scope },
    );
  }
  async function units(ref) {
    const result = [];
    let afterId;
    do {
      const page = await partPage(
        ref,
        "activityUnits",
        "collectionProgress.units",
        { afterId },
      );
      result.push(...page.rows);
      afterId = page.hasMore ? page.nextCursor : null;
    } while (afterId);
    return result.sort(
      (a, b) =>
        a.indexes.ordinal - b.indexes.ordinal || a.id.localeCompare(b.id),
    );
  }
  async function runSnapshots(ref) {
    const view = await repository.readView(
      {
        select: [
          rowSelector("runSnapshots", ref.scope, [
            collectionPartId(ref.activityId, "targetSnapshot", "value"),
            collectionPartId(ref.activityId, "profileSnapshot", "value"),
          ]),
        ],
      },
      { scope: ref.scope },
    );
    return {
      targetSnapshot:
        view.rows.runSnapshots?.[
          collectionPartId(ref.activityId, "targetSnapshot", "value")
        ],
      profileSnapshot:
        view.rows.runSnapshots?.[
          collectionPartId(ref.activityId, "profileSnapshot", "value")
        ],
    };
  }
  async function planFor(scope, root, options = {}) {
    const view = await repository.readView(
      {
        select: [
          { collection: "packages", ids: [scope.packageId] },
          rowSelector("targets", scope, [scope.targetRevisionId]),
          {
            collection: "profileCopies",
            ownerPackageId: scope.packageId,
            where: { parentId: scope.targetRevisionId },
            limit: 2,
          },
          { collection: "settings", limit: 200 },
          { collection: "sourceHealth", limit: 200 },
        ],
      },
      { scope },
    );
    const pkg = await repository.getRow(
        { collection: "packages", id: scope.packageId },
        { scope },
      ),
      saved = view.rows.targets?.[scope.targetRevisionId];
    if (!saved)
      throw packageError("version_not_found", "目标版本不存在。", 404);
    if (pkg.enabled === false || saved.enabled === false)
      throw packageError("version_disabled", "目标版本已停用，请先启用。");
    const target = {
      ...saved,
      profileSnapshot: Object.values(view.rows.profileCopies || {})[0],
      coverageMode:
        options.coverageMode ??
        root?.targetSnapshot?.coverageMode ??
        saved.coverageMode ??
        "standard",
    };
    collectionLimitsFor(target.coverageMode);
    const settings = Object.fromEntries(
        Object.entries(view.rows.settings || {}),
      ),
      packageSettings = pkg.collectionSettings || {};
    const plan = await planner({
      scope,
      target,
      targetSnapshot: target,
      profileRevision: target.profileSnapshot,
      ownedState: root?.collectionProgress || {},
      activity: root,
      options,
      mode: target.coverageMode,
      now: clock.now(),
      settings,
      sourceHealth: view.rows.sourceHealth || {},
      packageSettings,
    });
    const planned =
      plan.units ||
      (plan.queries || []).map((query, index) => ({
        unitId:
          "u-" +
          contentHash([
            query.siteId,
            query.keyword,
            query.city,
            query.kind || "job",
          ]).slice(0, 24),
        sourceId: query.sourceId,
        siteId: query.siteId,
        queryIndex: index,
        query,
        site: plan.sites.find((site) => site.siteId === query.siteId),
      }));
    if (planned.length > 1000)
      throw packageError("collection_plan_invalid", "采集计划单元超限。", 400);
    const limits = collectionLimitsFor(
      target.coverageMode,
      plan.limits || options.limits || {},
    );
    // Numeric workspace and target ceilings also govern the activity ledger.
    // Null keeps the request-only configuration; zero remains a real ceiling.
    for (const cap of [settings.budgets?.maxCostCny, target.budgets?.maxCostCny])
      if (typeof cap === "number" && Number.isFinite(cap))
        limits.maxCostCny = Math.min(limits.maxCostCny, cap);
    return {
      ...plan,
      units: planned,
      target,
      limits,
      hashes: plan.hashes || {
        planHash: contentHash(planned),
        catalogHash: contentHash(
          plan.sites || planned.map((unit) => unit.site),
        ),
        queryHash: contentHash(target.roles),
        parserVersion: "collection-v1",
      },
    };
  }
  async function mutate(
    ref,
    lease,
    token,
    extra,
    action,
    { current = true } = {},
  ) {
    return (
      await repository.transaction(
        {
          select: [
            rowSelector("runs", ref.scope, [
              ref.activityId,
              ...(token?.sliceRunId ? [token.sliceRunId] : []),
            ]),
            ...(lease ? [leaseSelector(lease)] : []),
            ...extra,
          ],
        },
        (tx) => {
          const root = collectionRoot(tx.view, ref);
          if (lease) collectionLease(tx.view, ref.scope, lease);
          if (current) collectionToken(root.collectionProgress, token);
          const result = action(
            tx,
            root,
            token?.sliceRunId
              ? tx.getRow({ collection: "runs", id: token.sliceRunId })
              : null,
          );
          tx.putRow({ collection: "runs", id: root.runId, value: root });
          return result;
        },
        { scope: ref.scope, ...(lease ? { operationLease: lease } : {}) },
      )
    ).result;
  }
  async function mutateWithIssues(
    ref,
    lease,
    token,
    issues,
    extra,
    action,
    options,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const append = await prepareCollectionArrayAppends(repository, {
        ref,
        token,
        issues,
      });
      try {
        return await mutate(
          ref,
          lease,
          token,
          [...extra, ...append.select, ...selectorsFor(append.records)],
          (tx, ...rest) => {
            assertCollectionArrayAppends(tx, append);
            for (const row of append.records) tx.putRow(row);
            return action(tx, ...rest);
          },
          options,
        );
      } catch (error) {
        if (error.code !== "collection_queue_conflict" || attempt === 2)
          throw error;
      }
    }
  }
  async function current(ref, task) {
    task.controller.signal.throwIfAborted();
    const { root } = await head(ref);
    collectionToken(root.collectionProgress, task.token);
    return root;
  }
  async function emit(ref, type, payload, runId) {
    await events?.publish?.(runId || ref.activityId, type, payload, ref.scope);
  }
  function safeContext(ref, task, context) {
    return {
      ...context,
      conditionalCache,
      enrichRecord: async (record) => {
        await current(ref, task);
        const result = await enrich(record, context);
        await current(ref, task);
        return result;
      },
    };
  }
  async function queuePlan(ref, unitId, records) {
    // Only queues affected by this bounded page are read and replaced.
    const fresh = {};
    queueContentDraft(
      fresh,
      unitId,
      records,
      Number(clock.now()),
      articleCacheIdentity({ modelConfig }),
    );
    const selectors = [];
    for (const [key, collection] of queues) {
      const ids = Object.keys(fresh[key] || {}).map((key) =>
        collectionPartId(ref.activityId, "collectionProgress." + key, key),
      );
      if (key === "pendingBodies")
        ids.push(
          ...records.map((record) =>
            collectionPartId(
              ref.activityId,
              "collectionProgress.pendingBodies",
              contentKey(record),
            ),
          ),
        );
      if (ids.length)
        selectors.push(rowSelector(collection, ref.scope, [...new Set(ids)]));
    }
    const view = selectors.length
      ? await repository.readView({ select: selectors }, { scope: ref.scope })
      : { rows: {} };
    const progress = {};
    for (const [key, collection] of queues)
      progress[key] = Object.fromEntries(
        Object.entries(view.rows[collection] || {}).map(([id, value]) => [
          JSON.parse(id).at(-1),
          value,
        ]),
      );
    queueContentDraft(
      progress,
      unitId,
      records,
      Number(clock.now()),
      articleCacheIdentity({ modelConfig }),
    );
    const descriptors = [];
    for (const [key, collection] of queues) {
      for (const [childKey, value] of Object.entries(progress[key] || {}))
        descriptors.push({
          collection,
          id: collectionPartId(
            ref.activityId,
            "collectionProgress." + key,
            childKey,
          ),
          ownerPackageId: ref.scope.packageId,
          parent: {
            collection: "runs",
            id: ref.activityId,
            path: "collectionProgress." + key,
          },
          runId: ref.activityId,
          targetRevisionId: ref.scope.targetRevisionId,
          value,
        });
    }
    return {
      selectors,
      view,
      descriptors,
      dependencies: selectors.flatMap((selector) =>
        selector.ids.map((id) => ({
          collection: selector.collection,
          id,
          hash:
            view.rows[selector.collection]?.[id] === undefined
              ? null
              : contentHash(view.rows[selector.collection][id]),
        })),
      ),
    };
  }
  function applyQueues(tx, plan) {
    for (const dependency of plan.dependencies) {
      const current = tx.getRow({
        collection: dependency.collection,
        id: dependency.id,
      });
      if ((current === null ? null : contentHash(current)) !== dependency.hash)
        throw packageError(
          "collection_queue_conflict",
          "内容任务已变化。",
          409,
        );
    }
    const remaining = new Set(
      plan.descriptors.map((row) => row.collection + "\0" + row.id),
    );
    for (const selector of plan.selectors)
      for (const id of selector.ids)
        if (
          tx.getRow({ collection: selector.collection, id }) &&
          !remaining.has(selector.collection + "\0" + id)
        )
          tx.deleteRow({ collection: selector.collection, id });
    for (const row of plan.descriptors) tx.putRow(row);
  }
  function healthPlan(ref, unit, records, issues) {
    const result = isUnattemptedSourceResult({ records, issues })
      ? null
      : deriveCollectionSourceHealth({
          sourceId: unit.sourceId,
          siteId: unit.siteId,
          records,
          issues,
          now: clock.now(),
        });
    const privateSource = isVersionPrivateSource(
      registry.get(unit.sourceId) || { id: unit.sourceId },
    );
    return {
      result,
      privateSource,
      key: unit.sourceId + "/" + unit.siteId,
      selector: privateSource
        ? { collection: "packages", ids: [ref.scope.packageId] }
        : {
            collection: "sourceHealth",
            ids: [unit.sourceId + "/" + unit.siteId],
          },
    };
  }
  function applyHealth(tx, ref, plan) {
    if (!plan.result) return;
    if (plan.privateSource) {
      const pkg = tx.getRow({
        collection: "packages",
        id: ref.scope.packageId,
      });
      pkg.collectionSettings ||= {
        sourceOverrides: {},
        sessionRefs: {},
        refreshEnabled: false,
      };
      pkg.collectionSettings.sourceVerification ||= {};
      pkg.collectionSettings.sourceVerification[plan.key] = mergeSourceHealth(
        pkg.collectionSettings.sourceVerification[plan.key],
        plan.result,
        clock.now(),
      );
      tx.putRow({ collection: "packages", id: pkg.packageId, value: pkg });
    } else
      tx.putRow({
        collection: "sourceHealth",
        id: plan.key,
        value: mergeSourceHealth(
          tx.getRow({ collection: "sourceHealth", id: plan.key }),
          plan.result,
          clock.now(),
        ),
      });
  }
  async function recordIds(ref, token, lease, result) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const append = await prepareCollectionArrayAppends(repository, {
        ref,
        token,
        newJobIds: result.newForTarget,
        jobIds: result.jobIds,
      });
      try {
        await mutate(
          ref,
          lease,
          token,
          [...append.select, ...selectorsFor(append.records)],
          (tx, r, child) => {
            assertCollectionArrayAppends(tx, append);
            for (const row of append.records) tx.putRow(row);
            r.collectionProgress.metrics.newUnique =
              (r.collectionProgress.metrics.newUnique || 0) +
              result.newForTarget.length;
            child.counts.deduplicated =
              (child.counts.deduplicated || 0) +
              append.records.filter((row) => row.runId === child.runId).length;
            tx.putRow({ collection: "runs", id: child.runId, value: child });
          },
        );
        return;
      } catch (error) {
        if (error.code !== "collection_queue_conflict" || attempt === 2)
          throw error;
      }
    }
  }
  const service = {
    async prepare({ scope, options = {} }) {
      assertStarting();
      if (
        !["rules", "ai", "auto"].includes(options.mode || "rules") ||
        (options.requestId !== undefined && !idValid(options.requestId))
      )
        throw packageError("validation_failed", "准备参数无效。", 400);
      const plan = await planFor(scope, null, options),
        lease = await operationGate.acquire("collect", { scope });
      const activityId = options.requestId
          ? "collection-" + contentHash([scope, options.requestId]).slice(0, 40)
          : "collection-" + randomUUID(),
        ref = { scope, activityId };
      const root = createCollectionRoot({
        runId: activityId,
        scope,
        targetSnapshot: plan.target,
        profileSnapshot: plan.target.profileSnapshot,
        plan,
        limits: plan.limits,
        now: clock.now(),
      });
      root.collectionMode = options.mode || "rules";
      Object.assign(root.collectionProgress, {
        uncovered: plan.uncovered || plan.skipped || [],
        refreshReady: false,
        manualPaused: true,
        draining: false,
        stopIntent: null,
        ...(options.requestId
          ? { preparationRequestId: options.requestId }
          : {}),
      });
      const descriptors = newRunRows(root, scope);
      descriptors.push(
        {
          collection: "budgetUsage",
          id: activityId,
          ownerPackageId: scope.packageId,
          runId: activityId,
          targetRevisionId: scope.targetRevisionId,
          value: emptyCollectionUsage(),
        },
        {
          collection: "activityMetrics",
          id: activityId,
          ownerPackageId: scope.packageId,
          runId: activityId,
          targetRevisionId: scope.targetRevisionId,
          value: {
            version: COLLECTION_PROJECTION_VERSION,
            plannedUnits: plan.units.length,
            plannedSites: new Set(
              plan.units.map((unit) =>
                JSON.stringify([unit.sourceId, unit.siteId]),
              ),
            ).size,
          },
        },
      );
      try {
        await repository.transaction(
          { select: [...selectorsFor(descriptors), leaseSelector(lease)] },
          (tx) => {
            assertStarting();
            collectionLease(tx.view, scope, lease);
            const previous = tx.getRow({ collection: "runs", id: activityId });
            if (previous) {
              if (
                previous.collectionMode !== root.collectionMode ||
                previous.collectionProgress.planHash !==
                  root.collectionProgress.planHash ||
                contentHash(previous.collectionProgress.limits) !==
                  contentHash(root.collectionProgress.limits)
              )
                throw packageError(
                  "collection_prepare_replayed",
                  "同一准备请求的参数已改变。",
                  409,
                );
              return;
            }
            writeNewRunRows(tx, descriptors);
          },
          { scope, operationLease: lease },
        );
      } finally {
        await lease.release();
      }
      return { activityId, scope };
    },
    async start({ scope, options = {}, credentials = {} }) {
      assertStarting();
      const prepared = await service.prepare({ scope, options });
      return service.resume({
        ref: prepared,
        requestId: options.requestId || randomUUID(),
        credentials,
      });
    },
    async get(ref) {
      const snapshot = await repository.queryCollectionSnapshot({
          scope: ref.scope,
          activityId: ref.activityId,
          limit: 1,
          asOf: clock.now(),
        }),
        root = snapshot.collections[0];
      if (!root)
        throw packageError("collection_scope", "采集活动不属于此目标版本。");
      root.targetSnapshot = { revisionId: ref.scope.targetRevisionId };
      const copies = await repository.queryIds(
        {
          collection: "profileCopies",
          ownerPackageId: ref.scope.packageId,
          where: { parentId: ref.scope.targetRevisionId },
          limit: 1,
        },
        { scope: ref.scope },
      );
      if (copies.ids[0]) root.profileSnapshot = { revisionId: copies.ids[0] };
      // Unit metadata and aggregate counts came from the same bounded SQL snapshot.
      return root;
    },
    async listSnapshot(input) {
      return repository.queryCollectionSnapshot({
        ...input,
        asOf: clock.now(),
      });
    },
    async list(input) {
      return (await service.listSnapshot(input)).collections;
    },
    async resume({
      ref,
      requestId = randomUUID(),
      replan = false,
      credentials = {},
      automatic = false,
      mode,
    }) {
      assertStarting();
      if (
        !idValid(requestId) ||
        typeof replan !== "boolean" ||
        typeof automatic !== "boolean" ||
        (automatic && mode !== undefined && mode !== "rules") ||
        (mode !== undefined && !["rules", "ai", "auto"].includes(mode))
      )
        throw packageError("validation_failed", "续采参数无效。", 400);
      let { root } = await head(ref),
        p = root.collectionProgress;
      if (p.draining || p.stopIntent)
        throw packageError(
          "collection_draining",
          "活动仍在排空，请稍后续采。",
          409,
        );
      if (terminal.has(p.status))
        throw packageError(
          "collection_terminal",
          "已结束或取消的活动不能续采。",
        );
      if (p.activeSliceRunId)
        return {
          activityId: ref.activityId,
          sliceRunId: p.activeSliceRunId,
          runId: p.activeSliceRunId,
          status: "queued",
          joined: true,
        };
      if (active.has(ref.activityId))
        return {
          activityId: ref.activityId,
          runId: active.get(ref.activityId).token.sliceRunId,
          sliceRunId: active.get(ref.activityId).token.sliceRunId,
          status: p.status,
          joined: true,
        };
      if (p.resumeRequests?.[requestId])
        return { ...p.resumeRequests[requestId], joined: true };
      if (
        automatic &&
        (!p.refreshReady ||
          p.manualPaused ||
          p.status !== "paused" ||
          p.replanRequired)
      )
        return { activityId: ref.activityId, status: p.status, skipped: true };
      const snapshots = await runSnapshots(ref);
      root = { ...root, ...snapshots };
      const plan = await planFor(ref.scope, root);
      if (
        ["catalogHash", "queryHash", "parserVersion"].some(
          (key) => p[key] !== plan.hashes[key],
        ) &&
        !replan
      ) {
        await mutate(
          ref,
          null,
          null,
          [],
          (_tx, r) => {
            if (
              !r.collectionProgress.activeSliceRunId &&
              !terminal.has(r.collectionProgress.status)
            ) {
              Object.assign(r.collectionProgress, {
                status: "paused",
                replanRequired: true,
                refreshReady: false,
              });
              r.collectionProgress.revision++;
            }
          },
          { current: false },
        );
        throw packageError(
          "collection_replan_required",
          "来源、查询或解析规则已变化，请确认重新规划；累计额度保留。",
        );
      }
      await ensureCollectionRuntime?.();
      assertStarting();
      const permit =
        credentials.permit || runGate?.acquire(credentials.ip || "local");
      if (permit && !permit.ok)
        throw Object.assign(
          packageError(
            "collection_queue_limited",
            permit.reason,
            permit.status,
          ),
          { retryAfterMs: permit.retryAfterMs },
        );
      let lease;
      try {
        lease = await operationGate.acquire("collect", { scope: ref.scope });
      } catch (error) {
        permit?.release?.();
        throw error;
      }
      const sliceRunId = "slice-" + randomUUID(),
        child = {
          runId: sliceRunId,
          recordId: randomUUID(),
          ownerPackageId: ref.scope.packageId,
          collectionRole: "collection_slice",
          collectionActivityId: ref.activityId,
          targetSnapshot: snapshots.targetSnapshot,
          profileRevisionId: snapshots.profileSnapshot.revisionId,
          mode: mode || root.collectionMode || "rules",
          status: "running",
          stage: "collecting",
          createdAt: at(),
          startedAt: at(),
          finishedAt: null,
          ownerPid: process.pid,
          lastSeq: 0,
          events: [],
          issues: [],
          usage: {},
          counts: {
            raw: 0,
            normalized: 0,
            deduplicated: 0,
            newForTarget: 0,
            notices: 0,
          },
          coverage: [],
          snapshotRef: null,
          evaluationIds: [],
        };
      const childRows = newRunRows(child, ref.scope),
        allUnits = await units(ref),
        unitRows = allUnits.map((row) => ({ ...row.value }));
      const replanned = replan
        ? newRunRows(
            createCollectionRoot({
              runId: ref.activityId,
              scope: ref.scope,
              targetSnapshot: plan.target,
              plan,
              limits: plan.limits,
              now: clock.now(),
            }),
            ref.scope,
          ).filter((row) => row.collection === "activityUnits")
        : [];
      let claim;
      try {
        claim = await mutate(
          ref,
          lease,
          null,
          [
            ...selectorsFor(childRows),
            rowSelector("activityUnits", ref.scope, [
              ...new Set([
                ...allUnits.map((row) => row.id),
                ...replanned.map((row) => row.id),
              ]),
            ]),
          ],
          (tx, r) => {
            assertStarting();
            const p = r.collectionProgress;
            if (p.draining || p.stopIntent)
              throw packageError("collection_draining", "活动仍在排空。", 409);
            if (terminal.has(p.status))
              throw packageError(
                "collection_terminal",
                "已结束或取消的活动不能续采。",
              );
            if (p.activeSliceRunId)
              return {
                activityId: ref.activityId,
                sliceRunId: p.activeSliceRunId,
                runId: p.activeSliceRunId,
                status: "queued",
                joined: true,
              };
            if (p.resumeRequests?.[requestId])
              return { ...p.resumeRequests[requestId], joined: true };
            if (
              automatic &&
              (!p.refreshReady ||
                p.manualPaused ||
                p.status !== "paused" ||
                p.replanRequired)
            )
              return {
                activityId: ref.activityId,
                status: p.status,
                skipped: true,
              };
            if (replan) {
              const keep = new Set(replanned.map((row) => row.id));
              for (const old of allUnits)
                if (!keep.has(old.id))
                  tx.deleteRow({ collection: "activityUnits", id: old.id });
              for (const row of replanned) {
                const previous = tx.getRow({
                  collection: "activityUnits",
                  id: row.id,
                });
                if (
                  previous &&
                  contentHash(previous.query || {}) ===
                    contentHash(row.value.query || {}) &&
                  p.parserVersion === plan.hashes.parserVersion
                )
                  row.value = {
                    ...previous,
                    ...row.value,
                    cursor: previous.cursor,
                    committedPages: previous.committedPages,
                    committedPageKeys: previous.committedPageKeys,
                    status: previous.status,
                  };
                tx.putRow(row);
              }
              Object.assign(p, plan.hashes, { replanRequired: false });
              p.epoch++;
            }
            if (!automatic) {
              p.manualPaused = false;
              p.refreshReady = true;
              for (const row of allUnits) {
                const value = tx.getRow({
                  collection: "activityUnits",
                  id: row.id,
                });
                if (
                  value?.status === "waiting_for_auth" &&
                  !value.riskBlocked
                ) {
                  value.status = "pending";
                  tx.putRow({ collection: "activityUnits", id: row.id, value });
                }
              }
            }
            if (mode) r.collectionMode = mode;
            else if (automatic) r.collectionMode = "rules";
            p.status = "collecting";
            p.activeSliceRunId = sliceRunId;
            p.revision++;
            p.updatedAt = at();
            p.draining = false;
            p.stopIntent = null;
            p.ownerPid = process.pid;
            p.operationId = lease.operationId;
            writeNewRunRows(tx, childRows);
            const response = {
              activityId: ref.activityId,
              sliceRunId,
              runId: sliceRunId,
              status: "queued",
            };
            p.resumeRequests ||= {};
            p.resumeRequests[requestId] = response;
            const keys = Object.keys(p.resumeRequests);
            if (keys.length > 200) delete p.resumeRequests[keys[0]];
            return { ...response, token: tokenFor(r) };
          },
          { current: false },
        );
      } catch (error) {
        await lease.release();
        permit?.release?.();
        throw error;
      }
      if (claim.joined || claim.skipped) {
        await lease.release();
        permit?.release?.();
        return claim;
      }
      const task = {
        ref,
        controller: new AbortController(),
        lease,
        token: claim.token,
        credentials,
        permit,
        automatic,
        pending: new Set(),
      };
      active.set(ref.activityId, task);
      task.promise = Promise.resolve()
        .then(() => execute(ref, task))
        .finally(async () => {
          try {
            await Promise.allSettled([...task.pending]);
            await task.stopFence;
            await finalizeStop(ref, task);
            await lease.release();
          } finally {
            permit?.release?.();
            if (active.get(ref.activityId) === task)
              active.delete(ref.activityId);
          }
        });
      task.promise.catch(() => {});
      const { token, ...response } = claim;
      return response;
    },
    async commitCollectionPage({ ref, token, unitId, page, operationLease }) {
      if (
        !idValid(page?.pageKey) ||
        !Array.isArray(page.records) ||
        page.records.length > 1000 ||
        typeof page.done !== "boolean"
      )
        throw packageError(
          "collection_page_invalid",
          "采集页面结果无效。",
          400,
        );
      page = { ...page, records: page.records.map(normalizeRecord) };
      const unitKey = collectionPartId(
        ref.activityId,
        "collectionProgress.units",
        unitId,
      );
      const view = await repository.readView(
        {
          select: [
            rowSelector("runs", ref.scope, [ref.activityId]),
            rowSelector("activityUnits", ref.scope, [unitKey]),
          ],
        },
        { scope: ref.scope },
      );
      const root = collectionRoot(view, ref),
        unit = view.rows.activityUnits?.[unitKey];
      collectionToken(root.collectionProgress, token);
      if (!unit)
        throw packageError("collection_unit_missing", "未找到采集单元。");
      if (unit.committedPageKeys.includes(page.pageKey))
        return {
          duplicate: true,
          committedPages: unit.committedPages,
          revision: root.collectionProgress.revision,
          jobIds: [],
          observationIds: [],
          newForTarget: [],
        };
      collectionToken(root.collectionProgress, token, { revision: true });
      const result = await jobs.ingestRecords({
        scope: ref.scope,
        runId: token.sliceRunId,
        records: page.records,
        observedAt: page.notModified
          ? page.conditionalResponse?.evidenceCheckedAt || at()
          : at(),
        provenanceOperationId: operationLease.operationId,
        operationLease,
        collectionGuard: { ref, token },
        signal: active.get(ref.activityId)?.controller.signal,
        collectionPageCommit: {
          ref,
          token,
          unitId,
          page,
          modelConfig,
          now: clock.now(),
          privateSource: isVersionPrivateSource(
            registry.get(unit.sourceId) || { id: unit.sourceId },
          ),
        },
      });
      if (!result.collectionPage)
        throw packageError(
          "collection_page_commit_unavailable",
          "采集页面事务未返回持久进度。",
          503,
        );
      return result.collectionPage;
    },
    async commitDiagnosticRecords({
      ref,
      token,
      unitId,
      records,
      observationKey,
      issues = [],
      operationLease,
    }) {
      if (
        !idValid(unitId) ||
        !idValid(observationKey) ||
        !Array.isArray(records) ||
        records.length > 1000 ||
        !Array.isArray(issues) ||
        issues.length > 1000 ||
        issues.some(
          (issue) =>
            !issue || typeof issue !== "object" || Array.isArray(issue),
        )
      )
        throw packageError(
          "collection_diagnostic_invalid",
          "来源重查结果无效。",
          400,
        );
      try {
        for (const record of records) assertSourceRecord(record);
        records = records.map(normalizeRecord);
      } catch {
        throw packageError(
          "collection_diagnostic_invalid",
          "来源重查结果无效。",
          400,
        );
      }
      const authority = await repository.readView(
        {
          select: [
            rowSelector("runs", ref.scope, [
              ref.activityId,
              token?.sliceRunId || "missing-slice",
            ]),
            leaseSelector(operationLease),
          ],
        },
        { scope: ref.scope },
      );
      const authoritativeRoot = collectionRoot(authority, ref);
      collectionLease(authority, ref.scope, operationLease);
      collectionToken(authoritativeRoot.collectionProgress, token);
      if (
        authoritativeRoot.collectionProgress.operationId !==
        operationLease.operationId
      )
        throw packageError(
          "invalid_operation_lease",
          "来源重查结果不属于原活动租约。",
        );
      const unit = await repository.getRow(
        {
          collection: "activityUnits",
          ownerPackageId: ref.scope.packageId,
          id: collectionPartId(
            ref.activityId,
            "collectionProgress.units",
            unitId,
          ),
        },
        { scope: ref.scope },
      );
      if (!unit)
        throw packageError("collection_unit_missing", "未找到采集单元。");
      if (
        records.some(
          (record) =>
            record.sourceId !== unit.sourceId || record.siteId !== unit.siteId,
        )
      )
        throw packageError(
          "collection_diagnostic_source_mismatch",
          "来源重查结果与原采集单元不一致。",
        );
      const id = rowKey(
          ref.activityId,
          "diagnostic",
          contentHash(observationKey),
        ),
        previous = await repository.getRow(
          {
            collection: "sourceRotation",
            id,
            ownerPackageId: ref.scope.packageId,
          },
          { scope: ref.scope },
        );
      if (previous) {
        if (previous.unitId !== unitId)
          throw packageError(
            "collection_diagnostic_key_conflict",
            "来源重查标识已属于另一采集单元。",
          );
        return { ...previous.result, duplicate: true };
      }
      const { root } = await head(ref);
      collectionToken(root.collectionProgress, token, { revision: true });
      try {
        const result = await jobs.ingestRecords({
          scope: ref.scope,
          runId: token.sliceRunId,
          records,
          observedAt: at(),
          provenanceOperationId: operationLease.operationId,
          operationLease,
          collectionGuard: { ref, token },
          signal: active.get(ref.activityId)?.controller.signal,
          collectionPageCommit: {
            kind: "diagnostic",
            ref,
            token,
            unitId,
            observationKey,
            records,
            issues,
            operationLease: {
              operationId: operationLease.operationId,
              token: operationLease.token,
            },
            now: clock.now(),
            privateSource: isVersionPrivateSource(
              registry.get(unit.sourceId) || { id: unit.sourceId },
            ),
          },
        });
        if (!result.collectionPage)
          throw packageError(
            "collection_page_commit_unavailable",
            "来源重查事务未返回持久进度。",
            503,
          );
        return result.collectionPage;
      } catch (error) {
        if (error.code !== "collection_diagnostic_replayed") throw error;
        const committed = await repository.getRow(
          {
            collection: "sourceRotation",
            id,
            ownerPackageId: ref.scope.packageId,
          },
          { scope: ref.scope },
        );
        if (!committed) throw error;
        if (committed.unitId !== unitId)
          throw packageError(
            "collection_diagnostic_key_conflict",
            "来源重查标识已属于另一采集单元。",
          );
        return { ...committed.result, duplicate: true };
      }
    },
    pause: (ref) => stopActivity(ref, "pause"),
    cancel: (ref) => stopActivity(ref, "cancel"),
    async wait(ref) {
      const task = active.get(ref.activityId);
      if (task) await task.promise;
      const drain = drains.get(ref.activityId);
      if (drain) await drain;
      return service.get(ref);
    },
    async adjustLimits({ ref, limits, expectedRevision }) {
      assertStarting();
      const lease = await operationGate.acquire("collect", {
        scope: ref.scope,
      });
      try {
        return await ledger.adjustLimits({
          ref,
          limits,
          expectedRevision,
          operationLease: lease,
        });
      } finally {
        await lease.release();
      }
    },
    async cancelPackageAndWait(packageId) {
      const pkg = await repository.getRow({
        collection: "packages",
        id: packageId,
      });
      if (!pkg || pkg.kind !== "target" || pkg.state !== "active") return;
      const scope = { packageId, targetRevisionId: pkg.versionId };
      let afterId;
      do {
        const page = await repository.queryRows(
          {
            collection: "runs",
            ownerPackageId: packageId,
            where: { kind: "collection_root" },
            limit: 200,
            ...(afterId ? { afterId } : {}),
          },
          { scope },
        );
        for (const row of page.rows)
          if (!terminal.has(row.value.collectionProgress.status)) {
            const ref = { scope, activityId: row.id };
            await service.pause(ref);
            await service.wait(ref);
          }
        afterId = page.hasMore ? page.nextCursor : null;
      } while (afterId);
    },
    async recover() {
      let packageCursor;
      do {
        const packages = await repository.queryRows({
          collection: "packages",
          where: { kind: "target", status: "active" },
          limit: 200,
          ...(packageCursor ? { afterId: packageCursor } : {}),
        });
        for (const { value: pkg } of packages.rows) {
          const scope = {
            packageId: pkg.packageId,
            targetRevisionId: pkg.versionId,
          };
          let afterId;
          do {
            const page = await repository.queryRows(
              {
                collection: "runs",
                ownerPackageId: pkg.packageId,
                where: { kind: "collection_root" },
                limit: 200,
                ...(afterId ? { afterId } : {}),
              },
              { scope },
            );
            for (const { value: root } of page.rows) {
              const p = root.collectionProgress;
              if (
                terminal.has(p.status) ||
                (!p.activeSliceRunId &&
                  !p.draining &&
                  !p.refreshReady &&
                  Object.keys(p.resumeRequests || {}).length === 0 &&
                  p.manualPaused)
              )
                continue;
              const child = p.activeSliceRunId
                ? await repository.getRow(
                    {
                      collection: "runs",
                      id: p.activeSliceRunId,
                      ownerPackageId: scope.packageId,
                    },
                    { scope },
                  )
                : null;
              if (
                p.activeSliceRunId &&
                hasLiveOwner({ ownerPid: p.ownerPid || child?.ownerPid }) &&
                !active.has(root.runId)
              )
                continue;
              const ref = { scope, activityId: root.runId },
                oldToken = { epoch: p.epoch, sliceRunId: p.activeSliceRunId };
              let cursor;
              do {
                const reserved = await repository.queryRows(
                  {
                    collection: "reservations",
                    ownerPackageId: scope.packageId,
                    where: { runId: root.runId, status: "reserved" },
                    limit: 200,
                    ...(cursor ? { afterId: cursor } : {}),
                  },
                  { scope },
                );
                if (reserved.rows.length)
                  await repository.transaction(
                    {
                      select: [
                        rowSelector(
                          "reservations",
                          scope,
                          reserved.rows.map((row) => row.id),
                        ),
                        rowSelector("budgetUsage", scope, [root.runId]),
                        rowSelector("runs", scope, [root.runId]),
                      ],
                    },
                    (tx) => {
                      const current = collectionRoot(tx.view, ref);
                      if (
                        current.collectionProgress.epoch !== oldToken.epoch ||
                        current.collectionProgress.activeSliceRunId !==
                          oldToken.sliceRunId
                      )
                        throw stale();
                      const usage = tx.getRow({
                        collection: "budgetUsage",
                        id: root.runId,
                      });
                      let changed = 0;
                      for (const row of reserved.rows) {
                        const r = tx.getRow({
                          collection: "reservations",
                          id: row.id,
                        });
                        if (r.status !== "reserved") continue;
                        const before = structuredClone(r);
                        r.status = "uncertain";
                        r.settledAt = at();
                        changeCollectionUsage(usage, before, r);
                        tx.putRow({
                          collection: "reservations",
                          id: row.id,
                          value: r,
                        });
                        changed++;
                      }
                      if (changed) {
                        current.collectionProgress.ledger.revision += changed;
                        tx.putRow({
                          collection: "budgetUsage",
                          id: root.runId,
                          value: usage,
                        });
                        tx.putRow({
                          collection: "runs",
                          id: root.runId,
                          value: current,
                        });
                      }
                    },
                    { scope, operationMaintenance: true },
                  );
                cursor = reserved.hasMore ? reserved.nextCursor : null;
              } while (cursor);
              await mutate(
                ref,
                null,
                oldToken,
                [],
                (tx, r, child) => {
                  const p = r.collectionProgress;
                  if (
                    p.epoch !== oldToken.epoch ||
                    p.activeSliceRunId !== oldToken.sliceRunId
                  )
                    throw stale();
                  p.status = p.stopIntent === "cancel" ? "cancelled" : "paused";
                  p.epoch++;
                  p.revision++;
                  p.activeSliceRunId = null;
                  p.manualPaused = true;
                  p.refreshReady = false;
                  p.draining = false;
                  p.stopIntent = null;
                  p.resumeRequests = {};
                  p.pauseReason = "restored";
                  delete p.drainingToken;
                  delete p.drainingLeaseId;
                  if (child) {
                    child.status = "interrupted";
                    child.finishedAt = at();
                    child.stage = "finished";
                    tx.putRow({
                      collection: "runs",
                      id: child.runId,
                      value: child,
                    });
                  }
                },
                { current: false },
              );
            }
            afterId = page.hasMore ? page.nextCursor : null;
          } while (afterId);
        }
        packageCursor = packages.hasMore ? packages.nextCursor : null;
      } while (packageCursor);
    },
    async stop() {
      if (stopping) {
        await Promise.allSettled(
          [...active.values()].map((task) => task.promise),
        );
        return;
      }
      stopping = true;
      for (const task of active.values()) {
        task.intent = task.intent === "cancel" ? "cancel" : "pause";
        task.controller.abort(stale());
      }
      await Promise.allSettled(
        [...active.values()].map(async (task) => {
          await stopActivity(task.ref, task.intent);
          await task.promise;
        }),
      );
    },
    setReadService(value) {
      readService = value;
    },
    setAttachmentService(value) {
      attachmentService = value;
    },
    async withActivityContext(ref, callback) {
      const task = active.get(ref.activityId);
      await head(ref);
      if (!task?.apiContext)
        throw packageError(
          "collection_probe_unavailable",
          "请在活动运行期间使用累计预算探针。",
        );
      await current(ref, task);
      const pending = Promise.resolve().then(() => callback(task.apiContext));
      task.pending.add(pending);
      try {
        return await pending;
      } finally {
        task.pending.delete(pending);
      }
    },
    async withDiagnosticContext({ ref, requestId }, callback) {
      assertStarting();
      if (!idValid(requestId))
        throw packageError("validation_failed", "诊断请求标识无效。", 400);
      const { root } = await head(ref);
      if (terminal.has(root.collectionProgress.status))
        throw packageError("collection_terminal", "已结束活动不能启动诊断。");
      if (root.collectionProgress.status === "collecting")
        return service.withActivityContext(ref, callback);
      const lease = await operationGate.acquire("collect", {
          scope: ref.scope,
        }),
        sliceRunId = "diagnostic-" + randomUUID(),
        snapshots = await runSnapshots(ref),
        rows = newRunRows(
          {
            runId: sliceRunId,
            recordId: randomUUID(),
            ownerPackageId: ref.scope.packageId,
            collectionRole: "collection_slice",
            collectionActivityId: ref.activityId,
            targetSnapshot: snapshots.targetSnapshot,
            profileRevisionId: snapshots.profileSnapshot.revisionId,
            diagnosticOnly: true,
            status: "running",
            stage: "diagnostic",
            mode: "rules",
            createdAt: at(),
            startedAt: at(),
            finishedAt: null,
            lastSeq: 0,
            events: [],
            issues: [],
            usage: {},
            counts: {
              raw: 0,
              normalized: 0,
              deduplicated: 0,
              newForTarget: 0,
              notices: 0,
            },
            evaluationIds: [],
          },
          ref.scope,
        );
      let claim;
      try {
        claim = await mutate(
          ref,
          lease,
          null,
          selectorsFor(rows),
          (tx, r) => {
            const p = r.collectionProgress;
            assertStarting();
            if (
              p.draining ||
              p.stopIntent ||
              p.activeSliceRunId ||
              active.has(ref.activityId)
            )
              throw packageError(
                "collection_probe_unavailable",
                "当前已有操作，请稍后重试。",
              );
            if (p.diagnosticRequests?.[requestId])
              throw packageError(
                "collection_diagnostic_replayed",
                "此诊断请求已执行，请刷新状态。",
              );
            const previous = {
              status: p.status,
              manualPaused: p.manualPaused,
              refreshReady: p.refreshReady,
            };
            p.status = "collecting";
            p.activeSliceRunId = sliceRunId;
            p.epoch++;
            p.revision++;
            p.ownerPid = process.pid;
            p.operationId = lease.operationId;
            p.diagnosticRequests ||= {};
            p.diagnosticRequests[requestId] = { sliceRunId, createdAt: at() };
            const keys = Object.keys(p.diagnosticRequests);
            if (keys.length > 200) delete p.diagnosticRequests[keys[0]];
            writeNewRunRows(tx, rows);
            return { previous, token: tokenFor(r) };
          },
          { current: false },
        );
      } catch (error) {
        await lease.release();
        throw error;
      }
      const task = {
        ref,
        lease,
        controller: new AbortController(),
        token: claim.token,
        pending: new Set(),
        credentials: {},
      };
      active.set(ref.activityId, task);
      let failed;
      task.promise = Promise.resolve()
        .then(async () => {
          const budgets = await createActivityBudgets({
            ledger,
            ref,
            token: task.token,
            operationLease: lease,
            modelConfig,
          });
          const request = requestFactory({
            budget: budgets.sources,
            signal: task.controller.signal,
            diagnosticContext: { runId: sliceRunId },
          });
          const bossUnits = await repository.queryRows(
            {
              collection: "activityUnits",
              ownerPackageId: ref.scope.packageId,
              where: { parentId: ref.activityId, sourceId: "boss" },
              limit: 1,
            },
            { scope: ref.scope },
          );
          task.apiContext = safeContext(ref, task, {
            ...snapshots,
            profileRevision: snapshots.profileSnapshot,
            bossUnit: bossUnits.rows[0]?.value || null,
            budget: budgets.sources,
            modelBudget: budgets.model,
            request,
            signal: task.controller.signal,
            operationLease: lease,
            collectionGuard: { ref, token: task.token },
            ref,
            token: task.token,
            readService,
            runId: sliceRunId,
          });
          const result = await callback(task.apiContext);
          await current(ref, task);
          return result;
        })
        .catch((error) => {
          failed = error;
          throw error;
        })
        .finally(async () => {
          try {
            await Promise.allSettled([...task.pending]);
            await task.stopFence;
            await closeUncertain(ref, task);
            const { root } = await head(ref);
            if (root.collectionProgress.draining) await finalizeStop(ref, task);
            else
              await mutateWithIssues(
                ref,
                lease,
                task.token,
                failed
                  ? [
                      {
                        code: safeSourceIssues([{ code: failed.code }])[0].code,
                        ...safeSourceDiagnosticRefs(failed),
                      },
                    ]
                  : [],
                [],
                (tx, r, child) => {
                  Object.assign(r.collectionProgress, claim.previous, {
                    activeSliceRunId: null,
                  });
                  r.collectionProgress.revision++;
                  child.status = failed ? "failed" : "completed";
                  child.issueCount = (child.issueCount || 0) + (failed ? 1 : 0);
                  child.finishedAt = at();
                  child.stage = "finished";
                  tx.putRow({
                    collection: "runs",
                    id: child.runId,
                    value: child,
                  });
                },
              );
          } finally {
            await lease.release();
            if (active.get(ref.activityId) === task)
              active.delete(ref.activityId);
          }
        });
      return task.promise;
    },
    async resolveBossRisk({ ref, token, operationLease }) {
      const rows = await units(ref),
        pending = await partPage(
          ref,
          "contentBodies",
          "collectionProgress.pendingBodies",
        );
      return mutate(
        ref,
        operationLease,
        token,
        [
          rowSelector(
            "activityUnits",
            ref.scope,
            rows.map((row) => row.id),
          ),
          rowSelector(
            "contentBodies",
            ref.scope,
            pending.rows.map((row) => row.id),
          ),
        ],
        (tx) => {
          for (const row of rows)
            if (row.value.sourceId === "boss") {
              const value = tx.getRow({
                collection: "activityUnits",
                id: row.id,
              });
              value.riskBlocked = false;
              tx.putRow({ collection: "activityUnits", id: row.id, value });
            }
          for (const row of pending.rows)
            if (row.value.record.sourceId === "boss") {
              const value = tx.getRow({
                collection: "contentBodies",
                id: row.id,
              });
              value.riskBlocked = false;
              tx.putRow({ collection: "contentBodies", id: row.id, value });
            }
        },
      );
    },
  };
  async function stopActivity(ref, action) {
    const task = active.get(ref.activityId);
    if (task) {
      task.intent =
        task.intent === "cancel" || action === "cancel" ? "cancel" : "pause";
      task.controller.abort(stale());
    }
    let fence = drains.get(ref.activityId);
    if (!fence || action === "cancel") {
      fence = (async () => {
        const { root } = await head(ref),
          p = root.collectionProgress;
        if (terminal.has(p.status)) return;
        const child = p.activeSliceRunId
          ? await repository.getRow(
              {
                collection: "runs",
                id: p.activeSliceRunId,
                ownerPackageId: ref.scope.packageId,
              },
              { scope: ref.scope },
            )
          : null;
        const windows = !task
          ? await repository.queryRows(
              {
                collection: "reservations",
                ownerPackageId: ref.scope.packageId,
                where: {
                  runId: ref.activityId,
                  kind: "browser",
                  status: "reserved",
                },
                limit: 1,
              },
              { scope: ref.scope },
            )
          : null;
        const inFlight =
          !!task ||
          hasLiveOwner({ ownerPid: p.ownerPid || child?.ownerPid }) ||
          !!windows?.rows.length;
        await mutate(
          ref,
          null,
          { epoch: p.epoch, sliceRunId: p.activeSliceRunId },
          [],
          (tx, r, child) => {
            const p = r.collectionProgress;
            if (terminal.has(p.status)) return;
            if (!p.draining) {
              p.drainingToken = {
                epoch: p.epoch,
                sliceRunId: p.activeSliceRunId,
              };
              p.drainingLeaseId =
                task?.lease.operationId ||
                p.operationId ||
                windows?.rows[0]?.value.operationId ||
                null;
              p.epoch++;
              p.draining = !!p.activeSliceRunId && inFlight;
              if (!task && windows?.rows.length)
                p.externallyManagedDrain = true;
            }
            p.stopIntent =
              p.stopIntent === "cancel" || action === "cancel"
                ? "cancel"
                : "pause";
            p.manualPaused = true;
            p.refreshReady = false;
            p.revision++;
            p.updatedAt = at();
            if (!p.draining) {
              p.status = p.stopIntent === "cancel" ? "cancelled" : "paused";
              p.stopIntent = null;
              p.activeSliceRunId = null;
              if (child) {
                child.status = "cancelled";
                child.finishedAt = at();
                child.stage = "finished";
                tx.putRow({
                  collection: "runs",
                  id: child.runId,
                  value: child,
                });
              }
            }
          },
          { current: false },
        );
      })();
      drains.set(ref.activityId, fence);
      if (task) task.stopFence = fence;
      fence
        .finally(() => {
          if (drains.get(ref.activityId) === fence)
            drains.delete(ref.activityId);
        })
        .catch(() => {});
    }
    await fence;
    const summary = await service.get(ref);
    return {
      ...summary,
      accepted: true,
      action,
      draining: !!summary.collectionProgress.draining,
    };
  }
  async function finalizeStop(ref, task) {
    const { root } = await head(ref),
      p = root.collectionProgress;
    if (!p.draining || p.drainingLeaseId !== task.lease.operationId) return;
    await mutate(
      ref,
      task.lease,
      task.token,
      [],
      (tx, r, child) => {
        const p = r.collectionProgress;
        if (!p.draining || p.drainingLeaseId !== task.lease.operationId) return;
        p.status = p.stopIntent === "cancel" ? "cancelled" : "paused";
        p.activeSliceRunId = null;
        p.draining = false;
        p.stopIntent = null;
        p.revision++;
        p.updatedAt = at();
        delete p.drainingLeaseId;
        delete p.drainingToken;
        if (child) {
          child.status = "cancelled";
          child.stage = "finished";
          child.finishedAt = at();
          tx.putRow({ collection: "runs", id: child.runId, value: child });
        }
      },
      { current: false },
    );
  }
  async function closeUncertain(ref, task) {
    let cursor;
    do {
      const page = await repository.queryRows(
        {
          collection: "reservations",
          ownerPackageId: ref.scope.packageId,
          where: { runId: ref.activityId, status: "reserved" },
          limit: 200,
          ...(cursor ? { afterId: cursor } : {}),
        },
        { scope: ref.scope },
      );
      const rows = page.rows.filter(
        (row) =>
          row.value.epoch === task.token.epoch &&
          row.value.sliceRunId === task.token.sliceRunId &&
          (row.value.operationId || row.value.browserWindowLeaseId) ===
            task.lease.operationId,
      );
      if (rows.length)
        await repository.transaction(
          {
            select: [
              rowSelector("runs", ref.scope, [ref.activityId]),
              rowSelector("budgetUsage", ref.scope, [ref.activityId]),
              rowSelector(
                "reservations",
                ref.scope,
                rows.map((row) => row.id),
              ),
              leaseSelector(task.lease),
            ],
          },
          (tx) => {
            collectionLease(tx.view, ref.scope, task.lease);
            const root = collectionRoot(tx.view, ref),
              usage = tx.getRow({
                collection: "budgetUsage",
                id: ref.activityId,
              });
            let changes = 0;
            for (const row of rows) {
              const reservation = tx.getRow({
                collection: "reservations",
                id: row.id,
              });
              if (reservation.status !== "reserved") continue;
              const before = structuredClone(reservation);
              reservation.status = "uncertain";
              reservation.settledAt = at();
              changeCollectionUsage(usage, before, reservation);
              tx.putRow({
                collection: "reservations",
                id: row.id,
                value: reservation,
              });
              changes++;
            }
            if (changes) {
              root.collectionProgress.ledger.revision += changes;
              tx.putRow({ collection: "runs", id: root.runId, value: root });
              tx.putRow({
                collection: "budgetUsage",
                id: root.runId,
                value: usage,
              });
            }
          },
          { scope: ref.scope, operationLease: task.lease },
        );
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
  }
  async function saveSnapshot(ref, task, child) {
    const eventsPage = await repository.queryRows(
        {
          collection: "runEvents",
          ownerPackageId: ref.scope.packageId,
          where: { runId: child.runId },
          orderBy: "seq",
          limit: 200,
        },
        { scope: ref.scope },
      ),
      snapshots = await runSnapshots(ref);
    const records = [],
      evaluations = [],
      seen = new Set();
    let cursor;
    do {
      const page = await repository.queryRows(
        {
          collection: "observations",
          ownerPackageId: ref.scope.packageId,
          where: { runId: child.runId },
          limit: 200,
          ...(cursor ? { afterId: cursor } : {}),
        },
        { scope: ref.scope },
      );
      const ids = [...new Set(page.rows.map((row) => row.value.jobId))],
        view = ids.length
          ? await repository.readView(
              { select: [rowSelector("jobs", ref.scope, ids)] },
              { scope: ref.scope },
            )
          : { rows: {} };
      for (const row of page.rows) {
        const observation = row.value;
        if (!seen.has(observation.jobId)) {
          seen.add(observation.jobId);
          records.push({
            ...view.rows.jobs[observation.jobId],
            canonical: observation.fields || observation.record,
          });
        }
      }
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
    do {
      const page = await repository.queryRows(
        {
          collection: "evaluations",
          ownerPackageId: ref.scope.packageId,
          where: { runId: child.runId },
          limit: 200,
          ...(cursor ? { afterId: cursor } : {}),
        },
        { scope: ref.scope },
      );
      evaluations.push(...page.rows.map((row) => row.value));
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
    const snapshot = {
      schemaVersion: 2,
      run: {
        ...child,
        targetSnapshot: structuredClone(snapshots.targetSnapshot),
        events: eventsPage.rows.map((row) => row.value),
      },
      profileRevision: snapshots.profileSnapshot,
      jobs: records,
      evaluations,
      events: eventsPage.rows.map((row) => row.value),
    };
    const snapshotRef = await repository.writeOwnedRunSnapshot(
      child.runId,
      snapshot,
      { scope: ref.scope, operationLease: task.lease },
    );
    await repository.transaction(
      { select: [rowSelector("runs", ref.scope, [child.runId])] },
      (tx) => {
        const run = tx.getRow({ collection: "runs", id: child.runId });
        run.snapshotRef = snapshotRef;
        tx.putRow({ collection: "runs", id: run.runId, value: run });
      },
      { scope: ref.scope, operationLease: task.lease },
    );
  }
  async function execute(ref, task) {
    const signal = task.controller.signal,
      token = task.token,
      lease = task.lease;
    let stopCode = null,
      budgets;
    try {
      while (task.permit?.ticket?.position > 0) {
        signal.throwIfAborted();
        await cancellableSleep(50, signal);
      }
      await current(ref, task);
      budgets = await createActivityBudgets({
        ledger,
        ref,
        token,
        operationLease: lease,
        modelConfig,
      });
      const snapshots = await runSnapshots(ref),
        settingsView = await repository.readView(
          { select: [{ collection: "settings", limit: 200 }] },
          { scope: ref.scope },
        ),
        pkg = await repository.getRow(
          { collection: "packages", id: ref.scope.packageId },
          { scope: ref.scope },
        ),
        settings = settingsView.rows.settings || {};
      const request = requestFactory({
        budget: budgets.sources,
        signal,
        diagnosticContext: { runId: token.sliceRunId },
      });
      const makeContext = (unit) =>
        safeContext(ref, task, {
          scope: ref.scope,
          runId: token.sliceRunId,
          sites: [unit.site],
          queries: [unit.query],
          ...snapshots,
          profileRevision: snapshots.profileSnapshot,
          config: {
            ...task.credentials.sourceConfig,
            ...settings.sourceOverrides,
            [unit.sourceId]: {
              ...task.credentials.sourceConfig?.[unit.sourceId],
              ...settings.sourceOverrides?.[unit.sourceId],
              ...pkg.collectionSettings?.sourceOverrides?.[unit.sourceId],
            },
          },
          sessionRefs: pkg.collectionSettings?.sessionRefs || {},
          budget: budgets.sources,
          modelBudget: budgets.model,
          clock,
          readService,
          ref,
          token,
          operationLease: lease,
          collectionGuard: { ref, token },
          request,
          signal,
          officialSites,
          conditionalCache,
        });
      task.apiContext = makeContext({});
      await emit(ref, "stage", { stage: "collecting" }, token.sliceRunId);
      let root = (await head(ref)).root;
      const initialBodyTasks = (
        await partPage(
          ref,
          "contentBodies",
          "collectionProgress.pendingBodies",
          { limit: 10 },
        )
      ).rows;
      const rows = await units(ref),
        now = Number(clock.now()),
        eligible = rows
          .map((row) => row.value)
          .filter(
            (unit) =>
              unit.status !== "completed" &&
              unit.status !== "waiting_for_auth" &&
              (unit.roundPages ?? unit.committedPages) <
                root.collectionProgress.limits.maxPagesPerQuery &&
              (!unit.nextDueAt || Date.parse(unit.nextDueAt) <= now),
          );
      const rotationId = rowKey(
          ref.scope.packageId,
          "collection-source-rotation",
        ),
        rotation = await repository.getRow(
          {
            collection: "sourceRotation",
            id: rotationId,
            ownerPackageId: ref.scope.packageId,
          },
          { scope: ref.scope },
        );
      const ordered = fairUnitOrder(
        eligible,
        rotation?.lastSourceId,
        rotation?.lastSiteId,
      );
      await recordDiagnostic(diagnostics, {
        operation: "collection.plan",
        runId: token.sliceRunId,
        activityId: ref.activityId,
        counts: {
          plannedSites: new Set(
            eligible.map((unit) =>
              JSON.stringify([unit.sourceId, unit.siteId]),
            ),
          ).size,
          queries: eligible.length,
        },
        outcome: "success",
      });
      for (
        let round = 0;
        round < root.collectionProgress.limits.maxPagesPerQuery;
        round++
      ) {
        let advanced = false;
        for (const seed of ordered) {
          root = await current(ref, task);
          const unit = await repository.getRow(
            {
              collection: "activityUnits",
              id: collectionPartId(
                ref.activityId,
                "collectionProgress.units",
                seed.unitId,
              ),
              ownerPackageId: ref.scope.packageId,
            },
            { scope: ref.scope },
          );
          if (
            !unit ||
            unit.status === "completed" ||
            unit.status === "waiting_for_auth" ||
            unit.riskBlocked ||
            (unit.roundPages ?? unit.committedPages) >=
              root.collectionProgress.limits.maxPagesPerQuery ||
            (unit.nextDueAt && Date.parse(unit.nextDueAt) > Number(clock.now()))
          )
            continue;
          const provider = registry.get(unit.sourceId);
          if (!provider) {
            await issue(unit, "source_unavailable", false);
            continue;
          }
          // The ledger advances rotation atomically with an admitted physical request.
          await mutate(ref, lease, token, [], (tx, r) => {
            r.collectionProgress.activeSourceId = unit.sourceId;
            r.collectionProgress.activeSiteId = unit.siteId;
          });
          const context = makeContext(unit);
          budgets.sources.setSource?.(unit.sourceId, unit.siteId);
          try {
            let page = await readProviderPage(provider, {
              ...context,
              unitId: unit.unitId + "/refresh/" + (unit.refreshRound || 0),
              site: unit.site,
              query: unit.query,
              cursor: unit.cursor,
              seenCursorHashes: unit.seenCursorHashes || [],
              context,
            });
            const records = [],
              issues = [...(page.issues || [])];
            let detailTurns = 0;
            for (const original of page.records) {
              await current(ref, task);
              let record = original;
              if (
                !record.description ||
                record.description.trim().length < 30 ||
                record.retryEligible ||
                (record.bodyStatus && record.bodyStatus !== "complete") ||
                ((provider.capabilities?.body ||
                  provider.capabilities?.detail) &&
                  !assessRecruitmentEvidence({ record, now: clock.now() })
                    .bodyVerified)
              ) {
                if (detailTurns >= 1) {
                  record = {
                    ...record,
                    bodyStatus: "incomplete",
                    retryEligible: true,
                  };
                  records.push(record);
                  continue;
                }
                detailTurns++;
                try {
                  record = await provider.fetchDetail(record, context);
                } catch (error) {
                  if (
                    signal.aborted ||
                    error.runFatal ||
                    [
                      "collection_stale_epoch",
                      "workspace_write_failed",
                    ].includes(error.code) ||
                    authCodes.has(error.code)
                  )
                    throw error;
                  record = {
                    ...record,
                    detailStatus: "unavailable",
                    bodyStatus: "incomplete",
                    retryEligible: error.retryable !== false,
                    ...(error.nextDueAt ? { nextDueAt: error.nextDueAt } : {}),
                  };
                  issues.push({
                    code: error.code || "detail_unavailable",
                    ...safeSourceDiagnosticRefs(error),
                  });
                  if (error.code === "source_budget_exhausted")
                    stopCode = error.code;
                }
              }
              record = await context.enrichRecord(record);
              if (record.attachmentBudgetExhausted) {
                issues.push(...(record.attachmentIssues || []));
                stopCode = "source_budget_exhausted";
              }
              records.push(record);
            }
            page = { ...page, records, issues };
            await persistConditionalPage(context, page);
            root = await current(ref, task);
            token.expectedRevision = root.collectionProgress.revision;
            const result = await service.commitCollectionPage({
              ref,
              token,
              unitId: unit.unitId,
              page,
              operationLease: lease,
            });
            token.expectedRevision = result.revision;
            advanced = true;
            const child = await repository.getRow(
              {
                collection: "runs",
                id: token.sliceRunId,
                ownerPackageId: ref.scope.packageId,
              },
              { scope: ref.scope },
            );
            await emit(
              ref,
              "batch",
              { jobIds: result.jobIds, counts: child.counts },
              token.sliceRunId,
            );
            if (!page.notModified)
              await evaluate(
                ref,
                task,
                result.jobIds,
                budgets,
                root.collectionMode || "rules",
              );
            if (stopCode) break;
          } catch (error) {
            if (
              signal.aborted ||
              error.runFatal ||
              ["collection_stale_epoch", "workspace_write_failed"].includes(
                error.code,
              )
            )
              throw error;
            await issue(
              unit,
              error.code || "source_unavailable",
              authCodes.has(error.code),
              error.nextDueAt,
              error,
            );
            if (error.code === "source_budget_exhausted") {
              stopCode = error.code;
              break;
            }
          }
        }
        if (stopCode || !advanced) break;
      }
      root = await current(ref, task);
      await retryContent(
        ref,
        task,
        makeContext,
        "contentBodies",
        "pendingBodies",
        budgets,
        initialBodyTasks,
      );
      await retryContent(
        ref,
        task,
        makeContext,
        "contentLinks",
        "pendingOfficialLinks",
        budgets,
      );
      const articleRecovery = await prepareArticleRecovery(repository, {
        ref, identity: articleCacheIdentity({ modelConfig }), units: rows.map(row => row.value), signal,
      });
      if (articleRecovery.changed) await mutate(ref, lease, token, articleRecovery.select, (tx, r) => {
        signal.throwIfAborted();
        applyArticleRecovery(tx, articleRecovery);
        r.collectionProgress.articleRecovery = articleRecovery.marker;
        r.collectionProgress.revision++;
      });
      const preferred = articleRecovery.preferredArticleIds.length
        ? await repository.queryRows({ collection: "contentArticles", ownerPackageId: ref.scope.packageId,
          ids: articleRecovery.preferredArticleIds, total: false }, { scope: ref.scope }) : { rows: [] };
      const ordinaryArticles = await partPage(ref, "contentArticles", "collectionProgress.pendingArticles", { limit: 10 });
      const preferredById = new Map(preferred.rows.map(row => [row.id, row]));
      const articleTasks = [...new Map([
        ...articleRecovery.preferredArticleIds.filter(id => preferredById.has(id)).map(id => [id, preferredById.get(id)]),
        ...ordinaryArticles.rows.map(row => [row.id, row]),
      ]).values()].filter(row => row.value.recoverySourceFact).slice(0, 10);
      await retryContent(
        ref,
        task,
        makeContext,
        "contentArticles",
        "pendingArticles",
        budgets,
        articleTasks,
      );
      await repository.withWriteFence((fence) => {
        // Status counts stay in the same write fence as the terminal update;
        // private queue bodies are neither hydrated nor sampled to infer auth.
        const summaries = [
          ["activityUnits", "units"],
          ["contentBodies", "pendingBodies"],
          ["contentLinks", "pendingOfficialLinks"],
          ["contentArticles", "pendingArticles"],
        ].map(([collection, part]) => {
          const result = fence.aggregateRows({
            collection,
            ownerPackageId: ref.scope.packageId,
            where: { parentId: ref.activityId, path: "collectionProgress." + part },
            groupBy: "status",
            operation: "count",
            limit: 10,
          });
          if (result.hasMore) throw packageError("collection_queue_conflict", "采集队列状态超出预期，请重新读取。");
          return result.groups;
        });
        const recoveryState = fence.getRow({ collection: "runs", id: ref.activityId, ownerPackageId: ref.scope.packageId }).collectionProgress.articleRecovery;
        const recoveryPending = recoveryState && recoveryState.phase !== "done";
        const remaining = summaries[0].filter((group) => group.key !== "completed"),
          count = (groups) => groups.reduce((total, group) => total + group.value, 0),
          remainingCount = count(remaining),
          pending = summaries.slice(1).flat(),
          pendingCount = count(pending),
          allAuth = (groups) => groups.every((group) => group.key === "waiting_for_auth"),
          status = stopCode
            ? "budget_exhausted"
            : !remainingCount && !pendingCount && !recoveryPending
              ? "completed"
              : (remainingCount && allAuth(remaining)) ||
                  (!remainingCount && pendingCount && allAuth(pending))
                ? "waiting_for_auth"
                : "paused";
        task.controller.signal.throwIfAborted();
        return fence.transaction({ select: [
          rowSelector("runs", ref.scope, [ref.activityId, token.sliceRunId]),
          leaseSelector(lease),
        ] }, (tx) => {
          task.controller.signal.throwIfAborted();
          const r = collectionRoot(tx.view, ref);
          collectionLease(tx.view, ref.scope, lease);
          collectionToken(r.collectionProgress, token);
          const child = tx.getRow({ collection: "runs", id: token.sliceRunId });
          const p = r.collectionProgress;
          p.status = status;
          p.activeSliceRunId = null;
          p.revision++;
          p.updatedAt = at();
          p.manualPaused = false;
          p.refreshReady =
            status === "paused" &&
            !!pkg.collectionSettings?.refreshEnabled &&
            recoveryState?.phase !== "blocked" &&
            !(count(summaries[3]) && r.collectionMode === "rules");
          if (recoveryState?.phase === "blocked") p.lastErrorCode = "article_cache_needs_repair";
          child.status = stopCode || child.issueCount ? "partial" : "completed";
          child.stage = "finished";
          child.finishedAt = at();
          child.usage = {
            sources: budgets.sources.snapshot(),
            model: budgets.model.snapshot(),
          };
          tx.putRow({ collection: "runs", id: child.runId, value: child });
          tx.putRow({ collection: "runs", id: r.runId, value: r });
        });
      }, { scope: ref.scope, operationLease: lease });
    } catch (error) {
      await recordDiagnostic(
        diagnostics,
        {
          operation: "run.failure",
          runId: token.sliceRunId,
          phase: "collect",
          outcome: "failed",
          code: error.code || "collection_failed",
        },
        error,
      );
      if (!signal.aborted) {
        const { root } = await head(ref).catch(() => ({}));
        if (root && !root.collectionProgress.draining)
          await mutateWithIssues(
            ref,
            lease,
            token,
            [
              {
                code: safeSourceIssues([{ code: error.code }])[0].code,
                ...safeSourceDiagnosticRefs(error),
              },
            ],
            [],
            (tx, r, child) => {
              r.collectionProgress.status = [
                "source_budget_exhausted",
                "model_budget_exhausted",
              ].includes(error.code)
                ? "budget_exhausted"
                : "paused";
              r.collectionProgress.activeSliceRunId = null;
              r.collectionProgress.revision++;
              r.collectionProgress.refreshReady = false;
              r.collectionProgress.lastErrorCode = idValid(error.code)
                ? error.code
                : "collection_failed";
              child.status = "failed";
              child.stage = "finished";
              child.finishedAt = at();
              child.issueCount = (child.issueCount || 0) + 1;
              tx.putRow({ collection: "runs", id: child.runId, value: child });
            },
          ).catch(() => {});
      }
    } finally {
      await task.stopFence;
      await Promise.allSettled([...task.pending]);
      await closeUncertain(ref, task);
      await finalizeStop(ref, task);
      const child = await repository
        .getRow(
          {
            collection: "runs",
            id: token.sliceRunId,
            ownerPackageId: ref.scope.packageId,
          },
          { scope: ref.scope },
        )
        .catch(() => null);
      if (child) {
        try {
          await saveSnapshot(ref, task, child);
        } catch (error) {
          const append = await prepareCollectionArrayAppends(repository, {
            ref,
            token,
            issues: [{ code: "snapshot_failed" }],
          });
          await repository
            .transaction(
              { select: [...append.select, ...selectorsFor(append.records)] },
              (tx) => {
                assertCollectionArrayAppends(tx, append);
                for (const row of append.records) tx.putRow(row);
              },
              { scope: ref.scope, operationLease: lease },
            )
            .catch(() => {});
        }
        await recordDiagnostic(diagnostics, {
          operation: "collection.finish",
          runId: token.sliceRunId,
          activityId: ref.activityId,
          outcome: signal.aborted ? "cancelled" : "completed",
          counts: child.counts,
        });
        await emit(
          ref,
          "done",
          { status: child.status, counts: child.counts },
          child.runId,
        ).catch(() => {});
      }
    }
    async function issue(unit, code, auth, nextDueAt, error) {
      const health = healthPlan(
          ref,
          unit,
          [],
          [{ code, ...safeSourceDiagnosticRefs(error) }],
        ),
        unitRows = unit.sourceId === "boss" && auth ? await units(ref) : [],
        unitIds = [
          ...new Set([
            collectionPartId(
              ref.activityId,
              "collectionProgress.units",
              unit.unitId,
            ),
            ...unitRows.map((row) => row.id),
          ]),
        ];
      await mutateWithIssues(
        ref,
        lease,
        token,
        safeSourceIssues(
          [{ code, ...safeSourceDiagnosticRefs(error) }],
          unit.sourceId,
          unit.siteId,
        ),
        [rowSelector("activityUnits", ref.scope, unitIds), health.selector],
        (tx, r, child) => {
          applyHealth(tx, ref, health);
          for (const id of unitIds) {
            const u = tx.getRow({ collection: "activityUnits", id });
            if (
              !u ||
              (unit.sourceId === "boss" && auth && u.sourceId !== "boss")
            )
              continue;
            u.lastErrorCode = idValid(code) ? code : "source_unavailable";
            u.lastAttemptAt = at();
            if (code !== "source_budget_exhausted")
              u.refreshDelayMs = sourceRefreshDelay({
                failed: true,
                previousMs: u.refreshDelayMs,
              });
            u.status = auth ? "waiting_for_auth" : "pending";
            u.riskBlocked = !!u.riskBlocked || riskCodes.has(code);
            u.nextDueAt =
              code === "source_budget_exhausted" || auth
                ? null
                : nextDueAt ||
                  new Date(
                    Number(clock.now()) + u.refreshDelayMs,
                  ).toISOString();
            tx.putRow({ collection: "activityUnits", id, value: u });
          }
          child.issueCount = (child.issueCount || 0) + 1;
          tx.putRow({ collection: "runs", id: child.runId, value: child });
        },
      );
    }
  }
  async function evaluate(ref, task, jobIds, budgets, mode) {
    if (!jobIds.length || !evaluationService) return;
    const modelClient =
      mode === "rules"
        ? undefined
        : modelFactory?.({
            budget: budgets.model,
            signal: task.controller.signal,
            credentials: task.credentials,
            modelConfig,
            diagnosticContext: { runId: task.token.sliceRunId },
          });
    const result = await evaluationService.evaluate({
      scope: ref.scope,
      jobIds,
      mode,
      runId: task.token.sliceRunId,
      signal: task.controller.signal,
      modelClient,
      operationLease: task.lease,
      collectionGuard: { ref, token: { ...task.token } },
    });
    task.controller.signal.throwIfAborted();
    const ids = (result.evaluations || []).map((value) => value.evaluationId);
    // Model issues have no source/site identity. Persist fixed public codes and
    // safe diagnostic references, never model text, caller messages or job IDs.
    const modelIssueCodes = new Set([
      "model_budget_exhausted", "missing_model_key", "missing_model_result",
      "invalid_model_result", "unknown_model_job_id", "model_unavailable", "model_empty_response",
      "model_json_invalid", "model_json_repair_failed", "model_http_failed", "model_pricing_unsupported",
    ]);
    const issues = (Array.isArray(result.issues) ? result.issues : []).slice(0, 100).map((issue) => ({
      code: modelIssueCodes.has(issue?.code) ? issue.code : "model_unavailable",
      ...safeSourceDiagnosticRefs(issue),
      ...(Number.isSafeInteger(issue?.affectedCount) && issue.affectedCount >= 0 ? { affectedCount: issue.affectedCount } : {}),
    }));
    for (let attempt = 0; (ids.length || issues.length) && attempt < 3; attempt++) {
      const append = await prepareCollectionArrayAppends(repository, {
        ref,
        token: task.token,
        evaluationIds: ids,
        issues,
      });
      try {
        await mutate(
          ref,
          task.lease,
          task.token,
          [...append.select, ...selectorsFor(append.records)],
          (tx, r, child) => {
            task.controller.signal.throwIfAborted();
            assertCollectionArrayAppends(tx, append);
            for (const row of append.records) tx.putRow(row);
            child.issueCount = (child.issueCount || 0) +
              append.records.filter((row) => row.collection === "runIssues" && row.runId === child.runId).length;
            tx.putRow({ collection: "runs", id: child.runId, value: child });
          },
        );
        break;
      } catch (error) {
        if (error.code !== "collection_queue_conflict" || attempt === 2)
          throw error;
      }
    }
  }
  async function retryContent(
    ref,
    task,
    makeContext,
    collection,
    key,
    budgets,
    initialRows,
  ) {
    const page = initialRows
        ? { rows: initialRows }
        : await partPage(ref, collection, "collectionProgress." + key, {
            limit: 10,
          }),
      now = Number(clock.now());
    for (const row of page.rows) {
      await current(ref, task);
      const pending = row.value;
      if (
        pending.riskBlocked ||
        (task.automatic &&
          (pending.status === "waiting_for_auth" ||
            pending.status === "needs_review" ||
            (pending.automaticAttempts || 0) >= 3))
      )
        continue;
      const due = task.automatic
        ? pending.nextDueAt
        : pending.serverCooldownUntil;
      if (due && Date.parse(due) > now) continue;
      const unit = await repository.getRow(
        {
          collection: "activityUnits",
          id: collectionPartId(
            ref.activityId,
            "collectionProgress.units",
            pending.unitId,
          ),
          ownerPackageId: ref.scope.packageId,
        },
        { scope: ref.scope },
      );
      if (!unit) continue;
      const context = makeContext(unit);
      budgets.sources.setSource?.(unit.sourceId, unit.siteId);
      try {
        let records, cacheRow;
        if (key === "pendingArticles") {
          if (pending.recoverySourceFact) {
            const basis = await repository.readView({ select: sourceFactSelectors(ref.scope, pending.recoverySourceFact) }, { scope: ref.scope });
            assertSourceFactGuard(basis, ref.scope, pending.recoverySourceFact);
            await current(ref, task);
          }
          const { root } = await head(ref),
            modelClient =
              root.collectionMode === "rules"
                ? null
                : modelFactory?.({
                    budget: budgets.model,
                    signal: task.controller.signal,
                    credentials: task.credentials,
                    modelConfig,
                    diagnosticContext: { runId: task.token.sliceRunId },
                  });
          if (!modelClient) continue;
          const expanded = await expandArticles(
            modelClient,
            {},
            [pending.record],
            {
              concurrency: 1,
              signal: task.controller.signal,
              diagnostics,
              diagnosticContext: { runId: task.token.sliceRunId },
            },
          );
          if (expanded.failed)
            throw packageError("article_extract_failed", "正文提取尚未完成。");
          records = [];
          for (const record of expanded.jobs)
            records.push(await context.enrichRecord(normalizeRecord(record)));
          cacheRow = {
            collection: "articleCache",
            id: collectionPartId(
              ref.activityId,
              "collectionProgress.articleCache",
              JSON.parse(row.id).at(-1),
            ),
            ownerPackageId: ref.scope.packageId,
            parent: {
              collection: "runs",
              id: ref.activityId,
              path: "collectionProgress.articleCache",
            },
            runId: ref.activityId,
            targetRevisionId: ref.scope.targetRevisionId,
            value: {
              ...pending.cacheIdentity,
              record: pending.record,
              unitId: pending.unitId,
              partIndex: pending.partIndex,
              partCount: pending.partCount,
              completedAt: at(),
              ...(pending.recoverySourceFact ? { recoverySourceFact: pending.recoverySourceFact } : {}),
            },
          };
        } else {
          const provider = registry.get(
            key === "pendingOfficialLinks"
              ? "official-announcements"
              : pending.record.sourceId,
          );
          if (!provider) continue;
          const seed =
            key === "pendingOfficialLinks"
              ? normalizeRecord({
                  ...pending.record,
                  sourceId: "official-announcements",
                  siteId: pending.site.siteId,
                  identityScope: pending.site.siteId,
                  sourceRecordId: pending.url,
                  sourceRecordIdKind: "hint",
                  url: pending.url,
                  description: null,
                  company: null,
                  cities: [],
                  attachments: [],
                  externalLinks: [],
                  officialLinks: [],
                  bodyStatus: "incomplete",
                  retryEligible: true,
                  linkedFrom: {
                    sourceId: pending.record.sourceId,
                    url: pending.record.url,
                  },
                })
              : pending.record;
          let record = await provider.fetchDetail(
            seed,
            key === "pendingOfficialLinks"
              ? { ...context, sites: [pending.site] }
              : context,
          );
          record = await context.enrichRecord(record);
          records = [record];
          if (key === "pendingOfficialLinks")
            cacheRow = {
              collection: "officialLinkCache",
              id: collectionPartId(
                ref.activityId,
                "collectionProgress.officialLinkCache",
                JSON.parse(row.id).at(-1),
              ),
              ownerPackageId: ref.scope.packageId,
              parent: {
                collection: "runs",
                id: ref.activityId,
                path: "collectionProgress.officialLinkCache",
              },
              runId: ref.activityId,
              targetRevisionId: ref.scope.targetRevisionId,
              value: { completedAt: at() },
            };
        }
        const result = await jobs.ingestRecords({
          scope: ref.scope,
          runId: task.token.sliceRunId,
          records,
          observedAt: at(),
          provenanceOperationId: task.lease.operationId,
          operationLease: task.lease,
          collectionGuard: { ref, token: task.token },
          ...(pending.recoverySourceFact ? { sourceFactGuard: pending.recoverySourceFact } : {}),
          signal: task.controller.signal,
        });
        await recordIds(ref, task.token, task.lease, result);
        const queue = await queuePlan(ref, pending.unitId, records),
          health = healthPlan(ref, unit, records, []);
        if (cacheRow) cacheRow.value.jobIds = result.jobIds;
        await mutate(
          ref,
          task.lease,
          task.token,
          [
            rowSelector(collection, ref.scope, [row.id]),
            ...queue.selectors,
            ...selectorsFor(queue.descriptors),
            health.selector,
            ...(cacheRow ? selectorsFor([cacheRow]) : []),
          ],
          (tx, r) => {
            const currentPending = tx.getRow({ collection, id: row.id });
            if (!currentPending || contentHash(currentPending) !== contentHash(pending))
              throw packageError("collection_queue_conflict", "正文任务已变化，不能覆盖新的提取进度。");
            applyQueues(tx, queue);
            applyHealth(tx, ref, health);
            if (
              key !== "pendingBodies" ||
              records.every(
                (record) =>
                  !record.retryEligible && record.bodyStatus === "complete",
              )
            )
              tx.deleteRow({ collection, id: row.id });
            if (cacheRow) tx.putRow(cacheRow);
            r.collectionProgress.revision++;
          },
        );
        await evaluate(
          ref,
          task,
          result.jobIds,
          budgets,
          (await head(ref)).root.collectionMode || "rules",
        );
      } catch (error) {
        if (error.code === "collection_source_fact_changed") {
          await mutate(ref, task.lease, task.token, [], (_tx, r) => {
            task.controller.signal.throwIfAborted();
            delete r.collectionProgress.articleRecovery;
            r.collectionProgress.lastErrorCode = "article_cache_needs_repair";
            r.collectionProgress.revision++;
          });
          continue;
        }
        if (
          task.controller.signal.aborted ||
          error.runFatal ||
          [
            "collection_stale_epoch",
            "workspace_write_failed",
            "source_budget_exhausted",
            "model_budget_exhausted",
          ].includes(error.code)
        )
          throw error;
        if (error.retryable === false && !authCodes.has(error.code)) {
          await mutateWithIssues(
            ref,
            task.lease,
            task.token,
            safeSourceIssues(
              [
                {
                  code: error.code || "detail_unavailable",
                  retryable: false,
                  ...safeSourceDiagnosticRefs(error),
                },
              ],
              unit.sourceId,
              unit.siteId,
            ),
            [rowSelector(collection, ref.scope, [row.id])],
            (tx, r, child) => {
              const value = tx.getRow({ collection, id: row.id });
              if (!value || contentHash(value) !== contentHash(pending))
                throw packageError(
                  "collection_queue_conflict",
                  "正文任务已变化，不能应用旧失败结果。",
                  409,
                );
              tx.deleteRow({ collection, id: row.id });
              child.issueCount = (child.issueCount || 0) + 1;
              tx.putRow({ collection: "runs", id: child.runId, value: child });
              r.collectionProgress.revision++;
            },
          );
          continue;
        }
        await mutate(
          ref,
          task.lease,
          task.token,
          [rowSelector(collection, ref.scope, [row.id])],
          (tx) => {
            const value = tx.getRow({ collection, id: row.id });
            if (!value) return;
            value.attempts = (value.attempts || 0) + 1;
            if (task.automatic)
              value.automaticAttempts = (value.automaticAttempts || 0) + 1;
            if (value.automaticAttempts >= 3) value.status = "needs_review";
            if (authCodes.has(error.code)) {
              value.status = "waiting_for_auth";
              value.riskBlocked =
                !!value.riskBlocked || riskCodes.has(error.code);
            }
            value.lastErrorCode = error.code || "detail_unavailable";
            value.nextDueAt =
              error.nextDueAt ||
              new Date(Number(clock.now()) + 600000).toISOString();
            tx.putRow({ collection, id: row.id, value });
          },
        );
      }
    }
  }
  return service;
}

/** Interleave families and sites before advancing the next keyword at a site. */
export function fairUnitOrder(units, lastSourceId, lastSiteId) {
  const families = new Map();
  for (const unit of units) {
    if (!families.has(unit.sourceId)) families.set(unit.sourceId, new Map());
    const sites = families.get(unit.sourceId);
    if (!sites.has(unit.siteId)) sites.set(unit.siteId, []);
    sites.get(unit.siteId).push(unit);
  }
  const rotate = (values, last) => {
    const index = values.indexOf(last);
    return index < 0
      ? values
      : [...values.slice(index + 1), ...values.slice(0, index + 1)];
  };
  const sourceIds = rotate([...families.keys()], lastSourceId),
    siteOrder = new Map(
      sourceIds.map((source) => [
        source,
        rotate(
          [...families.get(source).keys()],
          source === lastSourceId ? lastSiteId : null,
        ),
      ]),
    );
  const result = [];
  while (result.length < units.length) {
    let advanced = false;
    for (const source of sourceIds)
      for (const site of siteOrder.get(source)) {
        const queue = families.get(source).get(site);
        if (queue.length) {
          result.push(queue.shift());
          advanced = true;
          break;
        }
      }
    if (!advanced) break;
    for (const source of sourceIds) {
      const order = siteOrder.get(source);
      if (order.length > 1) order.push(order.shift());
    }
  }
  return result;
}
