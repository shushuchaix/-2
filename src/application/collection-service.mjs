import { randomUUID } from "node:crypto";
import { assertScope, packageError } from "../domain/packages.mjs";
import {
  createCollectionRoot,
  normalizeCollectionRun,
} from "../domain/collection.mjs";
import { ingestRecordsDraft } from "../domain/ingest-records.mjs";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { collectionLimitsFor } from "../../public/js/validation-rules.js";
import { assertOperationWriteAllowed } from "./workspace-operations.mjs";
import {
  createActivityBudgets,
  createCollectionLedger,
} from "./collection-ledger.mjs";
import { readProviderPage } from "../sources/collection-page.mjs";
import { runtimeRepository } from "./package-runtime-service.mjs";
import { cancellableSleep } from "../infrastructure/http/scheduler.mjs";
import { sourceRefreshDelay } from "../sources/source-quality.mjs";
const terminal = new Set(["completed", "cancelled"]);
const stale = () =>
  packageError("collection_stale_epoch", "活动已停止或进度已变化，请刷新。");
const idValid = (id) =>
  typeof id === "string" && /^[A-Za-z0-9_.-]{1,160}$/.test(id);
export function createCollectionService({
  repository,
  operationGate,
  registry,
  requestFactory,
  ledger = createCollectionLedger({ repository }),
  clock = repository.clock,
  events,
  planner,
  readService,
  attachmentService,
  evaluationService,
  modelFactory,
  modelConfig,
  runGate,
  diagnostics,
}) {
  const active = new Map();
  const at = () => new Date(clock.now()).toISOString();
  function rootFor(w, ref) {
    assertScope(w, ref?.scope, clock.now());
    const root = w.runs[ref.activityId];
    if (
      !root ||
      root.collectionRole !== "collection_root" ||
      root.ownerPackageId !== ref.scope.packageId ||
      root.targetSnapshot?.revisionId !== ref.scope.targetRevisionId
    )
      throw packageError("collection_scope", "采集活动不属于此目标版本。");
    return root;
  }
  function tokenFor(root) {
    const p = root.collectionProgress;
    return {
      epoch: p.epoch,
      expectedRevision: p.revision,
      sliceRunId: p.activeSliceRunId,
    };
  }
  function checkToken(root, token, revision = true) {
    const p = root.collectionProgress;
    if (
      !token ||
      p.epoch !== token.epoch ||
      p.activeSliceRunId !== token.sliceRunId ||
      p.status !== "collecting" ||
      (revision && p.revision !== token.expectedRevision)
    )
      throw stale();
  }
  function checkLease(w, scope, lease) {
    assertOperationWriteAllowed(w, { operationLease: lease });
    const stored = w.operationLeases?.[lease?.operationId];
    if (
      !stored ||
      stored.token !== lease.token ||
      stored.kind !== "collect" ||
      stored.scope?.packageId !== scope.packageId ||
      stored.scope?.targetRevisionId !== scope.targetRevisionId
    )
      throw packageError("invalid_operation_lease", "采集操作授权已失效。");
  }
  async function planFor(scope, root, options = {}) {
    const w = await repository.read(),
      pkg = assertScope(w, scope, clock.now()),
      target = Object.values(w.targets)
        .flat()
        .find((t) => t.revisionId === scope.targetRevisionId);
    if (
      pkg.enabled === false ||
      (w.versionMetadata?.[target.revisionId]?.enabled ?? target.enabled) ===
        false
    )
      throw packageError("version_disabled", "目标版本已停用，请先启用。");
    const plan = await planner({
      scope,
      target,
      targetSnapshot: target,
      profileRevision: target.profileSnapshot,
      ownedState: root?.collectionProgress || {},
      activity: root,
      options,
      mode: target.coverageMode || "standard",
      now: clock.now(),
      workspace: w,
    });
    const limits = collectionLimitsFor(
      target.coverageMode || "standard",
      plan.limits || options.limits || {},
    );
    const units =
      plan.units ||
      (plan.queries || []).map((query, i) => ({
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
        queryIndex: i,
        query,
        site: plan.sites.find((s) => s.siteId === query.siteId),
      }));
    if (units.length > 1000)
      throw packageError("collection_plan_invalid", "采集计划单元超限。", 400);
    const hashes = plan.hashes || {
      planHash: contentHash(units),
      catalogHash: contentHash(plan.sites || units.map((u) => u.site)),
      queryHash: contentHash(target.roles),
      parserVersion: "collection-v1",
    };
    return { ...plan, units, limits, hashes, target };
  }
  async function emit(id, type, payload, scope) {
    await events?.publish?.(id, type, payload, scope);
  }
  async function mutateCurrent(ref, token, lease, action) {
    return (
      await repository.mutateWorkspace(
        (w) => {
          const root = rootFor(w, ref);
          checkLease(w, ref.scope, lease);
          checkToken(root, token, false);
          return action(w, root);
        },
        { operationLease: lease },
      )
    ).result;
  }
  const service = {
    async start({ scope, options = {}, credentials = {} }) {
      if (!["rules", "ai", "auto"].includes(options.mode || "rules"))
        throw packageError("validation_failed", "评价模式无效。", 400);
      const plan = await planFor(scope, null, options),
        lease = await operationGate.acquire("collect", { scope });
      const activityId = "collection-" + randomUUID(),
        ref = {
          scope: {
            packageId: scope.packageId,
            targetRevisionId: scope.targetRevisionId,
          },
          activityId,
        };
      try {
        await repository.mutateWorkspace(
          (w) => {
            assertScope(w, scope, clock.now());
            checkLease(w, scope, lease);
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
            root.collectionProgress.uncovered =
              plan.uncovered || plan.skipped || [];
            root.collectionProgress.refreshReady = true;
            w.runs[activityId] = root;
          },
          { operationLease: lease },
        );
      } finally {
        await lease.release();
      }
      return service.resume({
        ref,
        requestId: options.requestId || randomUUID(),
        credentials,
      });
    },
    async get(ref) {
      return structuredClone(rootFor(await repository.read(), ref));
    },
    async list({ scope }) {
      const w = await repository.read();
      assertScope(w, scope, clock.now());
      return Object.values(w.runs)
        .filter(
          (r) =>
            r.ownerPackageId === scope.packageId &&
            r.collectionRole === "collection_root",
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async resume({
      ref,
      requestId = randomUUID(),
      replan = false,
      credentials = {},
      automatic = false,
    }) {
      if (!idValid(requestId) || typeof replan !== "boolean")
        throw packageError("validation_failed", "续采参数无效。", 400);
      const before = await service.get(ref),
        old = before.collectionProgress;
      if (terminal.has(old.status))
        throw packageError(
          "collection_terminal",
          "已结束或取消的活动不能续采。",
        );
      if (old.activeSliceRunId)
        return {
          activityId: ref.activityId,
          sliceRunId: old.activeSliceRunId,
          runId: old.activeSliceRunId,
          status: "queued",
          joined: true,
        };
      if (old.resumeRequests?.[requestId])
        return { ...old.resumeRequests[requestId], joined: true };
      if (
        automatic &&
        (!old.refreshReady ||
          old.manualPaused ||
          old.status === "waiting_for_auth" ||
          old.status === "budget_exhausted")
      )
        return {
          activityId: ref.activityId,
          status: old.status,
          skipped: true,
        };
      const plan = await planFor(ref.scope, before);
      const changed = ["catalogHash", "queryHash", "parserVersion"].some(
        (k) => old[k] !== plan.hashes[k],
      );
      if (changed && !replan) {
        await repository.mutateWorkspace((w) => {
          const root = rootFor(w, ref),
            p = root.collectionProgress;
          if (!p.activeSliceRunId && !terminal.has(p.status)) {
            p.status = "paused";
            p.replanRequired = true;
            p.refreshReady = false;
            p.revision++;
            p.updatedAt = at();
          }
        });
        throw packageError(
          "collection_replan_required",
          "来源、查询或解析规则已变化，请确认重新规划；累计额度保留。",
        );
      }
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
      } catch (e) {
        permit?.release?.();
        throw e;
      }
      let claim;
      try {
        claim = (
          await repository.mutateWorkspace(
            (w) => {
              const root = rootFor(w, ref),
                p = root.collectionProgress;
              checkLease(w, ref.scope, lease);
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
              if (replan) {
                const units = {};
                for (const u of plan.units) {
                  const previous = p.units[u.unitId],
                    compatible =
                      previous &&
                      contentHash(previous.query || {}) ===
                        contentHash(u.query || {}) &&
                      p.parserVersion === plan.hashes.parserVersion;
                  units[u.unitId] = compatible
                    ? { ...previous, ...u }
                    : {
                        ...u,
                        cursor: null,
                        committedPages: 0,
                        committedPageKeys: [],
                        status: "pending",
                        nextDueAt: null,
                        lastErrorCode: null,
                      };
                }
                p.units = units;
                Object.assign(p, plan.hashes);
                p.replanRequired = false;
                p.epoch++;
              }
              if (!automatic) {
                p.manualPaused = false;
                p.refreshReady = true;
                for (const u of Object.values(p.units))
                  if (u.status === "waiting_for_auth") u.status = "pending";
              }
              const sliceRunId = "slice-" + randomUUID();
              p.status = "collecting";
              p.activeSliceRunId = sliceRunId;
              p.revision++;
              p.updatedAt = at();
              const child = {
                runId: sliceRunId,
                recordId: randomUUID(),
                ownerPackageId: ref.scope.packageId,
                collectionRole: "collection_slice",
                collectionActivityId: root.runId,
                targetSnapshot: structuredClone(root.targetSnapshot),
                profileRevisionId: root.profileSnapshot.revisionId,
                mode: root.collectionMode || "rules",
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
              w.runs[sliceRunId] = child;
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
              return { ...response, token: tokenFor(root) };
            },
            { operationLease: lease },
          )
        ).result;
      } catch (e) {
        await lease.release();
        permit?.release?.();
        throw e;
      }
      if (claim.joined) {
        await lease.release();
        permit?.release?.();
        return claim;
      }
      const task = {
        controller: new AbortController(),
        lease,
        token: claim.token,
        credentials,
        permit,
      };
      active.set(ref.activityId, task);
      task.promise = Promise.resolve()
        .then(() => execute(ref, task))
        .finally(async () => {
          try {
            await Promise.allSettled([...(task.pending || [])]);
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
        page.records.length > 5000 ||
        typeof page.done !== "boolean"
      )
        throw packageError(
          "collection_page_invalid",
          "采集页面结果无效。",
          400,
        );
      return (
        await repository.mutateWorkspace(
          (w) => {
            const root = rootFor(w, ref),
              p = root.collectionProgress;
            checkLease(w, ref.scope, operationLease);
            checkToken(root, token, false);
            const unit = p.units[unitId];
            if (!unit)
              throw packageError("collection_unit_missing", "未找到采集单元。");
            if (unit.committedPageKeys.includes(page.pageKey))
              return {
                duplicate: true,
                committedPages: unit.committedPages,
                revision: p.revision,
                jobIds: [],
              };
            checkToken(root, token, true);
            const result = ingestRecordsDraft(w, {
              scope: ref.scope,
              runId: token.sliceRunId,
              records: page.records,
              observedAt: at(),
              provenanceOperationId: operationLease.operationId,
            });
            unit.committedPageKeys.push(page.pageKey);
            unit.committedPages++;
            unit.roundPages = (unit.roundPages || 0) + 1;
            unit.cursor = page.done ? null : structuredClone(page.nextCursor);
            unit.status = page.done ? "completed" : "pending";
            unit.lastErrorCode = null;
            unit.lastSuccessAt = at();
            unit.lastAttemptAt = at();
            unit.refreshDelayMs = sourceRefreshDelay({
              changes: result.newForTarget.length,
              total: page.records.length,
              previousMs: unit.refreshDelayMs,
            });
            unit.seenCursorHashes ||= [];
            if (
              page.cursorHash &&
              !unit.seenCursorHashes.includes(page.cursorHash)
            )
              unit.seenCursorHashes.push(page.cursorHash);
            if (
              page.done &&
              w.packages[ref.scope.packageId].collectionSettings?.refreshEnabled
            ) {
              unit.status = "pending";
              unit.nextDueAt = new Date(
                Number(clock.now()) + unit.refreshDelayMs,
              ).toISOString();
              unit.refreshRound = (unit.refreshRound || 0) + 1;
              unit.roundPages = 0;
              unit.seenCursorHashes = [];
            }
            unit.seenIds = [
              ...new Set([
                ...(unit.seenIds || []),
                ...page.records.map((r) =>
                  contentHash([
                    r.sourceId,
                    r.identityScope,
                    r.sourceRecordId || r.url,
                  ]),
                ),
              ]),
            ].slice(-5000);
            const child = w.runs[token.sliceRunId];
            child.counts.raw += page.raw ?? page.records.length;
            child.counts.normalized += page.records.length;
            child.counts.newForTarget += result.newForTarget.length;
            child.counts.notices += page.records.filter(
              (r) => r.kind !== "job",
            ).length;
            child.jobIds = [
              ...new Set([...(child.jobIds || []), ...result.jobIds]),
            ];
            child.counts.deduplicated = child.jobIds.length;
            child.issues.push(
              ...(page.issues || []).map((i) => ({
                code: idValid(i.code) ? i.code : "collection_page_issue",
                sourceId: unit.sourceId,
                siteId: unit.siteId,
                retryable: i.retryable === true,
              })),
            );
            p.metrics.committedPages = (p.metrics.committedPages || 0) + 1;
            p.metrics.newUnique =
              (p.metrics.newUnique || 0) + result.newForTarget.length;
            p.revision++;
            p.updatedAt = at();
            return {
              duplicate: false,
              committedPages: unit.committedPages,
              revision: p.revision,
              ...result,
            };
          },
          { operationLease },
        )
      ).result;
    },
    async pause(ref) {
      return stopActivity(ref, "paused", true);
    },
    async cancel(ref) {
      return stopActivity(ref, "cancelled", true);
    },
    async wait(ref) {
      const task = active.get(ref.activityId);
      if (task) await task.promise;
      return service.get(ref);
    },
    async adjustLimits({ ref, limits, expectedRevision }) {
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
      const w = await repository.read(),
        pkg = w.packages[packageId];
      if (!pkg || pkg.kind !== "target" || pkg.state !== "active") return;
      for (const root of Object.values(w.runs).filter(
        (r) =>
          r.ownerPackageId === packageId &&
          r.collectionRole === "collection_root" &&
          !terminal.has(r.collectionProgress.status),
      ))
        await service.pause({
          scope: { packageId, targetRevisionId: pkg.versionId },
          activityId: root.runId,
        });
    },
    async recover() {
      await repository.mutateWorkspace((w) => {
        for (const [id, root] of Object.entries(w.runs))
          if (
            root.collectionRole === "collection_root" &&
            !terminal.has(root.collectionProgress.status) &&
            w.packages[root.ownerPackageId]?.state === "active"
          ) {
            const p = root.collectionProgress;
            p.refreshReady = false;
            p.manualPaused = true;
            if (p.activeSliceRunId) {
              const child = w.runs[p.activeSliceRunId];
              if (child) {
                child.status = "interrupted";
                child.finishedAt = at();
              }
            }
            const normalized = normalizeCollectionRun(root, { restored: true });
            normalized.collectionProgress.resumeRequests = {};
            w.runs[id] = normalized;
          }
      });
    },
    async stop() {
      for (const [activityId] of [...active]) {
        const w = await repository.read(),
          root = w.runs[activityId];
        if (root && w.packages[root.ownerPackageId]?.state === "active")
          await service.pause({
            scope: {
              packageId: root.ownerPackageId,
              targetRevisionId: root.targetSnapshot.revisionId,
            },
            activityId,
          });
      }
    },
    setReadService(value) {
      readService = value;
    },
    setAttachmentService(value) {
      attachmentService = value;
    },
    async withActivityContext(ref, callback) {
      const root = rootFor(await repository.read(), ref),
        task = active.get(ref.activityId);
      if (!task?.apiContext || root.collectionProgress.status !== "collecting")
        throw packageError(
          "collection_probe_unavailable",
          "请在活动运行期间使用累计预算探针。",
        );
      task.controller.signal.throwIfAborted();
      const pending = Promise.resolve().then(() => callback(task.apiContext));
      task.pending ||= new Set();
      task.pending.add(pending);
      try {
        return await pending;
      } finally {
        task.pending.delete(pending);
      }
    },
  };
  async function stopActivity(ref, status, manual) {
    await repository.mutateWorkspace((w) => {
      const root = rootFor(w, ref),
        p = root.collectionProgress;
      if (terminal.has(p.status)) return;
      p.epoch++;
      p.revision++;
      p.status = status;
      p.manualPaused = manual;
      p.refreshReady = false;
      p.updatedAt = at();
      const child = w.runs[p.activeSliceRunId];
      if (child && ["running", "queued"].includes(child.status)) {
        child.status = "cancelled";
        child.stage = "finished";
        child.finishedAt = at();
      }
      p.activeSliceRunId = null;
    });
    const task = active.get(ref.activityId);
    if (task) {
      task.controller.abort(stale());
      await task.promise.catch(() => {});
    }
    return service.get(ref);
  }
  async function execute(ref, task) {
    const { lease } = task,
      signal = task.controller.signal,
      token = { ...task.token };
    let stopCode = null;
    let budgets, request;
    try {
      while (task.permit?.ticket?.position > 0) {
        signal.throwIfAborted();
        await cancellableSleep(50, signal);
      }
      signal.throwIfAborted();
      budgets = await createActivityBudgets({
        ledger,
        ref,
        token,
        operationLease: lease,
        modelConfig,
        maxModelRequests: 1000,
      });
      request = requestFactory({
        budget: budgets.sources,
        signal,
        diagnosticContext: { runId: token.sliceRunId },
      });
      task.apiContext = {
        budget: budgets.sources,
        request,
        signal,
        operationLease: lease,
        collectionGuard: { ref, token },
      };
      await emit(token.sliceRunId, "stage", { stage: "collecting" }, ref.scope);
      let root = await service.get(ref);
      const now = Number(clock.now()),
        eligible = Object.values(root.collectionProgress.units).filter(
          (u) =>
            u.status !== "completed" &&
            u.status !== "waiting_for_auth" &&
            (!u.nextDueAt || Date.parse(u.nextDueAt) <= now),
        );
      const siteIds = [...new Set(eligible.map((u) => u.siteId))].slice(0, 10),
        units = eligible.filter((u) => siteIds.includes(u.siteId));
      // Every selected site gets one page before another depth round.
      for (
        let round = 0;
        round < root.collectionProgress.limits.maxPagesPerQuery;
        round++
      ) {
        let advanced = false;
        for (const seed of units) {
          signal.throwIfAborted();
          root = await service.get(ref);
          checkToken(root, token, false);
          const unit = root.collectionProgress.units[seed.unitId],
            limit = root.collectionProgress.limits.maxPagesPerQuery;
          if (
            unit.status === "completed" ||
            unit.status === "waiting_for_auth" ||
            (unit.roundPages ?? unit.committedPages) >= limit ||
            (unit.nextDueAt && Date.parse(unit.nextDueAt) > Number(clock.now()))
          )
            continue;
          const provider = registry.get(unit.sourceId);
          if (!provider) {
            await issue(unit, "source_unavailable", false);
            continue;
          }
          try {
            const context = {
              scope: ref.scope,
              runId: token.sliceRunId,
              sites: [unit.site],
              queries: [unit.query],
              targetSnapshot: root.targetSnapshot,
              profileRevision: root.profileSnapshot,
              config: task.credentials.sourceConfig || {},
              budget: budgets.sources,
              clock,
              readService,
              ref,
              token,
              operationLease: lease,
              request,
              signal,
            };
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
            for (const original of page.records) {
              signal.throwIfAborted();
              let record = original;
              if (
                !record.description ||
                record.description.trim().length < 30
              ) {
                try {
                  record = await provider.fetchDetail(record, context);
                } catch (e) {
                  if (
                    signal.aborted ||
                    e.code === "collection_stale_epoch" ||
                    e.code === "workspace_write_failed"
                  )
                    throw e;
                  record = { ...record, detailStatus: "unavailable" };
                  issues.push({ code: e.code || "detail_unavailable" });
                  if (e.code === "source_budget_exhausted") stopCode = e.code;
                }
              }
              if (record.attachments?.length && attachmentService) {
                record = await attachmentService.enrich({
                  record,
                  ref,
                  token,
                  operationLease: lease,
                  request,
                  signal,
                });
              }
              records.push(record);
            }
            page = { ...page, records, issues };
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
            const child = (await repository.read()).runs[token.sliceRunId];
            await emit(
              token.sliceRunId,
              "batch",
              { jobIds: result.jobIds, counts: child.counts },
              ref.scope,
            );
            if (result.jobIds.length && evaluationService) {
              const modelClient =
                root.collectionMode === "rules"
                  ? undefined
                  : modelFactory?.({
                      budget: budgets.model,
                      signal,
                      credentials: task.credentials,
                      modelConfig,
                      diagnosticContext: { runId: token.sliceRunId },
                    });
              const evaluation = await evaluationService.evaluate({
                scope: ref.scope,
                jobIds: result.jobIds,
                mode: root.collectionMode || "rules",
                runId: token.sliceRunId,
                signal,
                modelClient,
                operationLease: lease,
                collectionGuard: { ref, token: { ...token } },
              });
              await mutateCurrent(ref, token, lease, (w) => {
                const child = w.runs[token.sliceRunId];
                child.evaluationIds = [
                  ...new Set([
                    ...child.evaluationIds,
                    ...evaluation.evaluations.map((e) => e.evaluationId),
                  ]),
                ];
              });
            }
            if (stopCode) break;
          } catch (e) {
            if (
              signal.aborted ||
              e.code === "collection_stale_epoch" ||
              e.code === "workspace_write_failed"
            )
              throw e;
            if (e.code === "source_budget_exhausted") {
              stopCode = e.code;
              break;
            }
            await issue(
              unit,
              e.code || "source_unavailable",
              [
                "login_required",
                "challenge_required",
                "restricted",
                "captcha",
                "http_forbidden",
              ].includes(e.code),
              e.nextDueAt,
            );
          }
        }
        if (stopCode || !advanced) break;
      }
      root = await service.get(ref);
      checkToken(root, token, false);
      const p = root.collectionProgress,
        all = Object.values(p.units),
        refresh = Boolean(
          (await repository.read()).packages[ref.scope.packageId]
            .collectionSettings?.refreshEnabled,
        );
      const remaining = all.filter((u) => u.status !== "completed"),
        future = remaining.some(
          (u) => u.nextDueAt && Date.parse(u.nextDueAt) > Number(clock.now()),
        );
      const status = stopCode
        ? "budget_exhausted"
        : !remaining.length
          ? "completed"
          : remaining.every((u) => u.status === "waiting_for_auth")
            ? "waiting_for_auth"
            : "paused";
      await mutateCurrent(ref, token, lease, (w, r) => {
        const p = r.collectionProgress;
        p.status = status;
        p.activeSliceRunId = null;
        p.revision++;
        p.updatedAt = at();
        p.manualPaused = false;
        p.refreshReady = status === "paused" && refresh;
        const child = w.runs[token.sliceRunId];
        child.status =
          stopCode || child.issues.length ? "partial" : "completed";
        child.stage = "finished";
        child.finishedAt = at();
      });
    } catch (e) {
      if (!signal.aborted)
        await mutateCurrent(ref, token, lease, (w, r) => {
          r.collectionProgress.status = "paused";
          r.collectionProgress.activeSliceRunId = null;
          r.collectionProgress.revision++;
          r.collectionProgress.refreshReady = false;
          r.collectionProgress.lastErrorCode = idValid(e.code)
            ? e.code
            : "collection_failed";
          const child = w.runs[token.sliceRunId];
          child.status = "failed";
          child.stage = "finished";
          child.finishedAt = at();
          child.issues.push({
            code: idValid(e.code) ? e.code : "collection_failed",
          });
        }).catch(() => {});
    } finally {
      const w = await repository.read(),
        child = w.runs[token.sliceRunId];
      if (
        child &&
        budgets &&
        w.packages[ref.scope.packageId]?.state === "active"
      ) {
        const usage = await ledger.snapshot(ref);
        const repo = runtimeRepository(repository, ref.scope);
        const snapshot = {
          schemaVersion: 2,
          run: structuredClone(child),
          profileRevision: structuredClone(
            w.runs[ref.activityId].profileSnapshot,
          ),
          jobs: (child.jobIds || []).map((id) => w.jobs[id]).filter(Boolean),
          evaluations: (child.evaluationIds || [])
            .map((id) => w.evaluations[id])
            .filter(Boolean),
          events: child.events,
        };
        try {
          const snapshotRef = await repo.writeRunSnapshot(
            child.runId,
            snapshot,
            { operationLease: lease },
          );
          await repository.mutateWorkspace(
            (d) => {
              assertScope(d, ref.scope, clock.now());
              d.runs[child.runId].snapshotRef = snapshotRef;
              d.runs[child.runId].usage = {
                sources: budgets.sources.snapshot(),
                model: budgets.model.snapshot(),
                activity: usage,
              };
            },
            { operationLease: lease },
          );
        } catch (e) {
          await repository
            .mutateWorkspace(
              (d) => {
                if (
                  d.runs[child.runId] &&
                  d.packages[ref.scope.packageId]?.state === "active"
                )
                  d.runs[child.runId].issues.push({ code: "snapshot_failed" });
              },
              { operationLease: lease },
            )
            .catch(() => {});
        }
        const final = (await repository.read()).runs[child.runId];
        await emit(
          child.runId,
          "done",
          { status: final.status, counts: final.counts },
          ref.scope,
        ).catch(() => {});
      }
    }
    async function issue(unit, code, auth, nextDueAt) {
      await mutateCurrent(ref, token, lease, (w, r) => {
        const u = r.collectionProgress.units[unit.unitId];
        u.lastErrorCode = idValid(code) ? code : "source_unavailable";
        u.lastAttemptAt = at();
        u.refreshDelayMs = sourceRefreshDelay({
          failed: true,
          previousMs: u.refreshDelayMs,
        });
        u.status = auth ? "waiting_for_auth" : "pending";
        u.nextDueAt =
          nextDueAt ||
          new Date(Number(clock.now()) + u.refreshDelayMs).toISOString();
        w.runs[token.sliceRunId].issues.push({
          code: u.lastErrorCode,
          sourceId: u.sourceId,
          siteId: u.siteId,
        });
      });
    }
  }
  return service;
}
