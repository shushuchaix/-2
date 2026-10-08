import { randomUUID } from "node:crypto";
import {runtimeRepository,runtimeGate,exactScope} from './package-runtime-service.mjs';
import {assertScope,assertOwned,requirePackage,packageError} from '../domain/packages.mjs';
import { selectRunJobFact } from "../domain/job-facts.mjs";
import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import { setTimeout as delay } from "node:timers/promises";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { loadSiteCatalog } from "../sources/catalog.mjs";
import { buildCollectionPlan } from "../sources/planning.mjs";
import { createSourceBudget } from "../infrastructure/http/budget.mjs";
import {
  createModelBudget,
  createConfiguredModelBudget,
} from "../llm/budget.mjs";
import { evaluateRules } from "../domain/ranking.mjs";
import { expandArticles } from "../match/article.mjs";
import { normalizeRecord } from "../domain/record.mjs";
import { hasLiveOwner } from "../infrastructure/storage/process-owner.mjs";
import { recordSourceHealth } from "./source-health.mjs";
import {
  recordDiagnostic,
  withDiagnosticContext,
} from "../infrastructure/diagnostics/log.mjs";
const terminal = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);
const isWorkspaceWriteFailure = (error) =>
  /^(?:EACCES|EPERM|ENOSPC|EROFS|EBUSY|EIO|EMFILE|ENFILE)$/.test(
    error.code || "",
  ) ||
  /atomic\.|workspace\.(?:lock|read|previous|current)/.test(
    error.storageOperation || "",
  );
function createLegacyRunService({
  repository,
  workspaceService,
  jobService,
  evaluationService,
  registry,
  requestFactory,
  modelFactory,
  eventHub,
  runGate,
  clock = repository.clock,
  catalog,
  config = {},
  diagnostics,
  operationGate = createWorkspaceOperationGate({ repository }),
}) {
  const active = new Map(),
    now = () => new Date(clock.now()).toISOString();
  async function persist(operation) {
    try {
      return await operation();
    } catch (error) {
      if (isWorkspaceWriteFailure(error)) {
        error.runFatal = true;
        error.runFailureCode = "workspace_write_failed";
      }
      throw error;
    }
  }
  async function update(id, patch) {
    return (
      await persist(() =>
        repository.mutateWorkspace((w) => {
          const run = w.runs[id];
          if (!run) throw Error("Run not found");
          Object.assign(run, patch);
          return run;
        },{operationLease:active.get(id)?.operationLease}),
      )
    ).result;
  }
  async function emit(id, type, payload = {}) {
    if (eventHub) return persist(() => eventHub.publish(id, type, payload));
    return (
      await persist(() =>
        repository.mutateWorkspace((w) => {
          const run = w.runs[id];
          const event = {
            schemaVersion: 2,
            runId: id,
            seq: ++run.lastSeq,
            type,
            at: now(),
            payload,
          };
          run.events = [...(run.events || []), event].slice(-200);
          return event;
        }),
      )
    ).result;
  }
  async function execute(
    id,
    {
      controller,
      permit,
      profileRevision,
      targetSnapshot,
      mode,
      credentials,
      modelConfig,
      operationLease,
    },
  ) {
    const signal = controller.signal,
      jobIds = new Set(),
      newForTarget = new Set(),
      normalized = new Set(),
      coverage = [],
      issues = [],
      evaluations = [];
    const counts = {
      raw: 0,
      normalized: 0,
      notices: 0,
      expanded: 0,
      deduplicated: 0,
      eligible: 0,
      qualificationUnknown: 0,
      qualificationFailed: 0,
      shortlisted: 0,
      aiSuccess: 0,
      fallback: 0,
      newForTarget: 0,
    };
    let plan,
      budget,
      client,
      modelBudget,
      currentStage = "queued",
      stageStarted = clock.now(),
      finalStatus = "failed",
      finalUsage;
    const executionStarted = clock.now();
    async function diagnose(operation, error, context = {}) {
      const entry = await recordDiagnostic(
        diagnostics,
        { operation, runId: id, stage: currentStage, ...context },
        error,
      );
      if (entry) error.diagnosticId = entry.diagnosticId;
      return entry;
    }
    try {
      let checking = false,
        pollFailed = false,
        cancellationRead = Promise.resolve();
      // Keep an active run alive until it observes cross-entry cancellation.
      // The finally block releases this handle when execution reaches a terminal state.
      const cancellationPoll = setInterval(() => {
        if (checking) return;
        checking = true;
        cancellationRead = (async () => {
        try {
          if ((await repository.read()).runs[id]?.cancelRequestedAt)
            controller.abort();
          pollFailed = false;
        } catch (error) {
          if (!pollFailed)
            await diagnose("run.poll", error, {
              phase: "read",
              outcome: "failed",
            });
          pollFailed = true;
        } finally {
          checking = false;
        }
        })();
      }, 500);
      async function ingest(records) {
        let operation = "run.ingest";
        try {
          const result = await jobService.ingestRecords({
            runId: id,
            records,
            targetRevisionId: targetSnapshot.revisionId,
          });
          for (const jobId of result.jobIds) jobIds.add(jobId);
          for (const jobId of result.newForTarget) newForTarget.add(jobId);
          for (const record of records) {
            const key = contentHash([
              record.sourceId,
              record.identityScope,
              record.sourceRecordId || record.url,
              record.kind,
            ]);
            if (!normalized.has(key)) {
              normalized.add(key);
              counts.normalized++;
              if (record.kind !== "job") counts.notices++;
            }
          }
          counts.deduplicated = jobIds.size;
          counts.newForTarget = newForTarget.size;
          operation = "run.counts";
          await update(id, { counts: { ...counts } });
          operation = "run.events";
          await emit(id, "batch", {
            jobIds: result.jobIds,
            counts: { ...counts },
          });
          await recordDiagnostic(diagnostics, {
            operation: "run.batch",
            runId: id,
            stage: currentStage,
            phase: "finished",
            outcome: "success",
            sourceId: records[0]?.sourceId,
            siteId: records[0]?.siteId,
            counts: {
              input: records.length,
              accepted: result.jobIds.length,
              normalized: counts.normalized,
              deduplicated: counts.deduplicated,
              newForTarget: counts.newForTarget,
            },
          });
          return result;
        } catch (error) {
          await diagnose(operation, error, {
            sourceId: records[0]?.sourceId,
            siteId: records[0]?.siteId,
            recordCount: records.length,
          });
          // Preserve the underlying code. Validation/program errors are not filesystem failures.
          error.runFailureCode = isWorkspaceWriteFailure(error)
            ? "workspace_write_failed"
            : operation === "run.ingest"
              ? "record_ingest_failed"
              : "run_progress_failed";
          error.runFatal = true;
          throw error;
        }
      }
      async function stage(name) {
        await recordDiagnostic(diagnostics, {
          operation: "run.stage.finished",
          runId: id,
          stage: currentStage,
          phase: "finished",
          outcome: "success",
          durationMs: Math.max(0, clock.now() - stageStarted),
          counts: { ...counts },
        });
        currentStage = name;
        stageStarted = clock.now();
        await recordDiagnostic(diagnostics, {
          operation: "run.stage",
          runId: id,
          stage: name,
        });
        await update(id, { stage: name, counts: { ...counts } });
        await emit(id, "stage", { stage: name });
      }
      try {
        await emit(id, "queued", { position: permit?.queued || 0 });
        while (permit?.ticket?.position > 0) {
          signal.throwIfAborted();
          await delay(50, undefined, { signal });
        }
        signal.throwIfAborted();
        await update(id, { status: "running", startedAt: now() });
        await stage("planning");
        const workspace = await repository.read();
        const sites = structuredClone(
          catalog ||
            loadSiteCatalog({ customSites: workspace.settings.customSites }),
        );
        if (config.__activeSearchProvider)
          for (const site of sites)
            if (["search", "social_discovery"].includes(site.category))
              site.status = "ready";
        plan = buildCollectionPlan({
          targetSnapshot,
          profileRevision,
          catalog: sites,
          health: workspace.sourceHealth,
          sourceOverrides: workspace.settings.sourceOverrides,
        });
        budget = createSourceBudget(plan.budgets);
        modelBudget =
          credentials.modelBudget ||
          createModelBudget({
            maxRequests: Math.min(
              20,
              targetSnapshot.budgets?.maxModelRequests ??
                workspace.settings.budgets?.maxModelRequests ??
                20,
            ),
          });
        client =
          mode === "rules"
            ? null
            : modelFactory?.({
                signal,
                budget: modelBudget,
                credentials,
                modelConfig,
                diagnosticContext: { runId: id },
              });
        const request = requestFactory({
          budget,
          signal,
          diagnosticContext: { runId: id },
        });
        await recordDiagnostic(diagnostics, {
          operation: "run.plan",
          runId: id,
          stage: currentStage,
          mode,
          phase: "finished",
          outcome: "success",
          counts: {
            plannedSites: plan.sites.length,
            skippedSites: plan.skipped.length,
            queries: plan.queries.length,
          },
          usage: { sources: budget.snapshot(), model: modelBudget.snapshot() },
        });
        await update(id, {
          plan,
          usage: { sources: budget.snapshot(), model: modelBudget.snapshot() },
        });
        await stage("collecting");
        const contexts = plan.sites.map((site) => ({
          runId: id,
          sites: [site],
          queries: plan.queries.filter((q) => q.siteId === site.siteId),
          targetSnapshot,
          profileRevision,
          budget,
          request: (url, options = {}) =>
            request(url, {
              ...options,
              diagnosticContext: {
                ...options.diagnosticContext,
                runId: id,
                sourceId: site.providerId,
                siteId: site.siteId,
              },
            }),
          signal,
          clock,
          config,
          diagnostics,
          onBatch: ingest,
          reportDiagnostic: (event, error) =>
            recordDiagnostic(
              diagnostics,
              { ...event, runId: id, stage: currentStage },
              error,
            ),
          reportError: (error, context) =>
            diagnose(
              currentStage === "details" ? "run.detail" : "run.collect",
              error,
              context,
            ),
        }));
        const rounds = Math.max(1, ...contexts.map((c) => c.queries.length));
        for (let round = 0; round < rounds; round++)
          for (const context of contexts) {
            if (round >= Math.max(1, context.queries.length)) continue;
            signal.throwIfAborted();
            const provider = registry.get(context.sites[0].providerId);
            if (!provider) {
              issues.push({
                code: "provider_unavailable",
                sourceId: context.sites[0].providerId,
                siteId: context.sites[0].siteId,
              });
              await recordDiagnostic(diagnostics, {
                operation: "run.source",
                runId: id,
                sourceId: context.sites[0].providerId,
                siteId: context.sites[0].siteId,
                stage: currentStage,
                queryIndex: round,
                outcome: "failed",
                code: "provider_unavailable",
                level: "warn",
              });
              continue;
            }
            const sourceStarted = clock.now();
            try {
              const result = await provider.collect({
                ...context,
                queryIndex: round,
                queries: [
                  context.queries[round] || { keyword: "", pageLimit: 1 },
                ],
              });
              if (result.records.length) await ingest(result.records);
              counts.raw += result.stats?.raw ?? result.records.length;
              coverage.push(...result.coverage);
              issues.push(...result.issues);
              await emit(id, "source", {
                sourceId: provider.id,
                siteId: context.sites[0].siteId,
                stats: result.stats,
                issues: result.issues,
              });
              for (const code of [
                ...new Set(result.issues.map((issue) => issue.code)),
              ]
                .filter(Boolean)
                .concat(result.issues.length ? [] : [undefined]))
                await recordDiagnostic(diagnostics, {
                  operation: "run.source",
                  runId: id,
                  sourceId: provider.id,
                  siteId: context.sites[0].siteId,
                  stage: currentStage,
                  recordCount: result.records.length,
                  level: result.issues.length ? "warn" : "info",
                  code,
                  queryIndex: round,
                  phase: "finished",
                  outcome: result.issues.length
                    ? "partial"
                    : result.records.length
                      ? "success"
                      : "empty",
                  counts: {
                    raw: result.stats?.raw ?? result.records.length,
                    accepted: result.records.length,
                  },
                  issueCount: result.issues.length,
                  durationMs: clock.now() - sourceStarted,
                });
            } catch (error) {
              if (
                signal.aborted ||
                error.runFatal ||
                error.code === "workspace_write_failed"
              )
                throw error;
              const entry = await diagnose("run.collect", error, {
                sourceId: provider.id,
                siteId: context.sites[0].siteId,
                queryIndex: round,
                durationMs: Math.max(0, clock.now() - sourceStarted),
              });
              const code = error.code || "source_unavailable";
              issues.push({
                code,
                sourceId: provider.id,
                siteId: context.sites[0].siteId,
                message: "来源采集未完成。",
                ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
              });
              coverage.push({
                sourceId: provider.id,
                siteId: context.sites[0].siteId,
                status: "failed",
                truncated: true,
                queries: [context.queries[round]?.keyword || ""],
                cities: [],
                pages: 0,
                reason: code,
              });
            }
          }
        await stage("details");
        async function saveSourceHealth() {
          if (!coverage.length) return;
          await repository.mutateWorkspace((w) => {
            const keys = [
              ...new Set(coverage.map((c) => c.sourceId + "/" + c.siteId)),
            ];
            for (const key of keys) {
              const entries = coverage.filter(
                (c) => c.sourceId + "/" + c.siteId === key,
              );
              const { sourceId, siteId } = entries[0];
              const samples = Object.values(w.observations).filter((o) => {
                const r = o.fields || o.record;
                return (
                  o.runId === id &&
                  o.sourceId === sourceId &&
                  o.siteId === siteId &&
                  r?.title &&
                  r?.url &&
                  r?.description?.trim().length >= 30
                );
              });
              if (samples.length)
                recordSourceHealth(
                  w,
                  { sourceId, siteId, status: "ready" },
                  clock.now(),
                );
              recordSourceHealth(
                w,
                {
                  sourceId,
                  siteId,
                  runId: id,
                  sampleCount: new Set(samples.map((o) => o.jobId)).size,
                  status: entries.some((c) => c.status === "failed")
                    ? "unavailable"
                    : samples.length
                      ? "ready"
                      : "empty",
                  issues: issues.filter(
                    (i) =>
                      i.sourceId === sourceId &&
                      (!i.siteId || i.siteId === siteId),
                  ),
                },
                clock.now(),
              );
            }
          });
        }
        let workspaceNow = await repository.read();
        const ordered = [...jobIds]
          .map((jobId) => ({
            jobId,
            ...selectRunJobFact(workspaceNow, { runId: id, jobId }).record,
          }))
          .sort(
            (a, b) =>
              evaluateRules(b, profileRevision.profile, targetSnapshot).score -
              evaluateRules(a, profileRevision.profile, targetSnapshot).score,
          );
        const detailEvidence = [];
        for (const record of ordered
          .filter((r) => !r.description || r.description.length < 30)
          .slice(0, plan.budgets.maxDetails)) {
          signal.throwIfAborted();
          const provider = registry.get(record.sourceId),
            context = contexts.find((c) => c.sites[0].siteId === record.siteId);
          if (!provider || !context) continue;
          let detail;
          const detailStarted = clock.now();
          try {
            budget.claimDetail(
              record.sourceId +
                "/" +
                record.siteId +
                "/" +
                record.sourceRecordId,
            );
            detail = await provider.fetchDetail(record, {
              ...context,
              request: (url, options = {}) =>
                context.request(url, {
                  ...options,
                  diagnosticContext: {
                    ...options.diagnosticContext,
                    endpointKind: "detail",
                  },
                }),
            });
          } catch (error) {
            if (signal.aborted) throw error;
            const insufficient = error.code === "detail_insufficient";
            const entry = await diagnose(
              insufficient ? "run.detail.insufficient" : "run.detail",
              error,
              {
                sourceId: record.sourceId,
                siteId: record.siteId,
                jobId: record.jobId,
                requestId: error.requestId,
                parser: error.parser,
                durationMs: Math.max(0, clock.now() - detailStarted),
                outcome: insufficient ? "insufficient" : "failed",
              },
            );
            issues.push({
              code: error.code || "detail_unavailable",
              sourceId: record.sourceId,
              siteId: record.siteId,
              jobId: record.jobId,
              message: insufficient
                ? "原网站未提供完整岗位要求，已保留列表信息。可打开原链接核查或补充招聘正文。"
                : "详情未取得，保留已有事实。",
              ...(insufficient ? { retryable: false } : {}),
              ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
            });
            if (error.status === 404)
              detailEvidence.push({
                jobId: record.jobId,
                status: 404,
                url: record.url,
              });
            continue;
          }
          await recordDiagnostic(diagnostics, {
            operation: "run.detail.result",
            runId: id,
            sourceId: record.sourceId,
            siteId: record.siteId,
            jobId: record.jobId,
            stage: currentStage,
            phase: "finished",
            outcome: detail?.description ? "success" : "insufficient",
            durationMs: Math.max(0, clock.now() - detailStarted),
            parser: {
              version: record.parserVersion,
              textLength: detail?.description?.length || 0,
            },
          });
          if (detail?.description) await ingest([detail]);
        }
        await saveSourceHealth();
        await stage("expanding");
        workspaceNow = await repository.read();
        const notices = [...jobIds]
          .map(
            (jobId) =>
              selectRunJobFact(workspaceNow, { runId: id, jobId }).record,
          )
          .filter(
            (r) =>
              r.kind !== "job" &&
              r.description?.length >= 120 &&
              !["search_metadata", "authorization_required"].includes(
                r.accessStatus,
              ),
          );
        if (client?.available && notices.length) {
          const expanded = await expandArticles(
            client,
            profileRevision.profile,
            notices,
            {
              maxExpand: 5,
              concurrency: 1,
              signal,
              diagnostics,
              diagnosticContext: { runId: id },
            },
          );
          signal.throwIfAborted();
          if (expanded.jobs.length) {
            await ingest(expanded.jobs.map(normalizeRecord));
            counts.expanded = expanded.jobs.length;
          }
          await recordDiagnostic(diagnostics, {
            operation: "run.expansion",
            runId: id,
            stage: currentStage,
            phase: "finished",
            outcome: expanded.failed ? "partial" : "success",
            counts: {
              input: notices.length,
              expanded: expanded.jobs.length,
              skipped: expanded.skipped,
              noJob: expanded.noJob,
              failed: expanded.failed || 0,
            },
          });
        } else {
          await recordDiagnostic(diagnostics, {
            operation: "run.expansion",
            runId: id,
            stage: currentStage,
            phase: "finished",
            outcome: "skipped",
            code: notices.length ? "model_unavailable" : "no_notices",
            counts: { input: notices.length, expanded: 0 },
          });
        }
        await stage("evaluating");
        const result = await evaluationService.evaluate({
          jobIds: [...jobIds],
          profileRevisionId: profileRevision.revisionId,
          targetRevisionId: targetSnapshot.revisionId,
          mode,
          signal,
          runId: id,
          modelClient: client,
          operationLease,
        });
        evaluations.push(...result.evaluations);
        issues.push(...result.issues);
        counts.eligible = evaluations.filter(
          (e) => e.qualification.status === "pass",
        ).length;
        counts.qualificationUnknown = evaluations.filter(
          (e) => e.qualification.status === "unknown",
        ).length;
        counts.qualificationFailed = evaluations.filter(
          (e) => e.qualification.status === "fail",
        ).length;
        counts.shortlisted = evaluations.filter(
          (e) =>
            e.qualification.status !== "fail" &&
            e.recommendation !== "insufficient",
        ).length;
        counts.aiSuccess = evaluations.filter((e) => e.status === "ai").length;
        counts.fallback = evaluations.filter(
          (e) => e.status === "rule_fallback",
        ).length;
        await jobService.finalizeCoverage({
          runId: id,
          coverage,
          detailEvidence,
        });
        const collectionFailed = coverage.some((c) => c.status === "failed"),
          truncated = coverage.some((c) => c.truncated);
        const status =
          !jobIds.size &&
          collectionFailed &&
          !coverage.some((c) => c.status === "complete")
            ? "failed"
            : collectionFailed || truncated
              ? "partial"
              : "completed";
        finalStatus = status;
        finalUsage = { sources: budget.snapshot(), model: result.usage };
        await update(id, {
          status,
          stage: "finished",
          counts,
          coverage,
          issues,
          evaluationIds: evaluations.map((e) => e.evaluationId),
          degraded: counts.fallback > 0,
          usage: { sources: budget.snapshot(), model: result.usage },
          finishedAt: now(),
        });
      } catch (error) {
        if (signal.aborted) {
          finalStatus = "cancelled";
          issues.push({
            code: "cancelled",
            message: "任务已显式取消，已采集事实保留。",
          });
          await update(id, {
            status: "cancelled",
            stage: "finished",
            counts,
            coverage,
            issues,
            finishedAt: now(),
            usage: {
              sources: budget?.snapshot() || {},
              model: modelBudget?.snapshot() || {},
            },
          });
        } else {
          if (!error.diagnosticId) await diagnose("run.failed", error);
          const code = error.runFailureCode || error.code || "run_failed";
          finalStatus =
            error.runFatal || error.code === "workspace_write_failed"
              ? "failed"
              : jobIds.size
                ? "partial"
                : "failed";
          issues.push({
            code,
            message:
              code === "record_ingest_failed"
                ? "岗位记录处理失败，已保存的数据保留。请查看更新日志。"
                : code === "workspace_write_failed"
                  ? "工作区写入失败，请检查磁盘空间与目录权限，并查看更新日志。已保存的数据保留。"
                  : "任务未完成，已保存的数据保留。请查看更新日志。",
            ...(error.diagnosticId ? { diagnosticId: error.diagnosticId } : {}),
            stage: currentStage,
          });
          await update(id, {
            status:
              error.runFatal || error.code === "workspace_write_failed"
                ? "failed"
                : jobIds.size
                  ? "partial"
                  : "failed",
            stage: "finished",
            counts,
            coverage,
            issues,
            finishedAt: now(),
            usage: {
              sources: budget?.snapshot() || {},
              model: modelBudget?.snapshot() || {},
            },
          });
        }
      } finally {
        clearInterval(cancellationPoll);
        await cancellationRead;
        permit?.release();
      }
      const workspace = await repository.read();
      const persisted = Object.values(workspace.evaluations).filter(
        (e) => e.runId === id,
      );
      const snapshot = {
        run: workspace.runs[id],
        profileRevision,
        jobs: [...jobIds].map((jobId) => ({
          ...workspace.jobs[jobId],
          canonical: selectRunJobFact(workspace, { runId: id, jobId }).record,
        })),
        evaluations: evaluations.length ? evaluations : persisted,
        events: workspace.runs[id].events || [],
      };
      try {
        const snapshotRef = await repository.writeRunSnapshot(id, snapshot, {
          operationLease,
        });
        await update(id, { snapshotRef });
        await emit(id, "done", { status: snapshot.run.status, counts });
        snapshot.run = (await repository.read()).runs[id];
        snapshot.events = snapshot.run.events || [];
      } catch (error) {
        finalStatus = "failed";
        const entry = await diagnose("run.snapshot", error);
        await update(id, {
          status: "failed",
          issues: [
            ...issues,
            {
              code: "snapshot_failed",
              message: "运行快照未写入，恢复检查会报告缺失。",
              ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
            },
          ],
          snapshotRef: null,
        });
        await emit(id, "done", { status: "failed", counts });
        throw error;
      }
      return snapshot;
    } catch (error) {
      finalStatus = "failed";
      throw error;
    } finally {
      await recordDiagnostic(diagnostics, {
        operation: "run.stage.finished",
        runId: id,
        stage: currentStage,
        phase: "finished",
        outcome: ["completed", "partial", "cancelled"].includes(finalStatus)
          ? finalStatus
          : "failed",
        durationMs: Math.max(0, clock.now() - stageStarted),
        counts: { ...counts },
      });
      await recordDiagnostic(diagnostics, {
        operation: "run.finished",
        runId: id,
        stage: "finished",
        phase: "finished",
        outcome: finalStatus,
        code: finalStatus,
        level:
          finalStatus === "failed"
            ? "error"
            : finalStatus === "partial"
              ? "warn"
              : "info",
        durationMs: Math.max(0, clock.now() - executionStarted),
        counts: { ...counts },
        issueCount: issues.length,
        coverage: {
          sites: new Set(
            coverage.map((entry) => entry.sourceId + "/" + entry.siteId),
          ).size,
          complete: coverage.filter((entry) => entry.status === "complete")
            .length,
          failed: coverage.filter((entry) => entry.status === "failed").length,
          truncated: coverage.filter((entry) => entry.truncated).length,
        },
        usage: finalUsage || {
          sources: budget?.snapshot() || {},
          model: { ...modelBudget?.snapshot(), ...client?.usage },
        },
      });
    }
  }
  const service = {
    async startRun({
      targetRevisionId,
      mode = "rules",
      credentials = {},
      operationLease: parentLease,
    }) {
      assertInput("run", {
        targetRevisionId,
        mode,
        userApiKey: credentials.userApiKey,
      });
      if (mode === "rules") {
        const { userApiKey, ...rest } = credentials;
        credentials = rest;
      }
      if (!["rules", "ai", "auto"].includes(mode))
        throw Error("Invalid run mode");
      const target = await workspaceService.getTargetRevision(targetRevisionId);
      if (!target || !target.enabled)
        throw inputError({
          targetRevisionId: "请选择仍然存在且已启用的搜索目标。",
        });
      const profile = await workspaceService.getProfileRevision(
        target.profileRevisionId,
      );
      if (!profile) throw Error("Profile revision missing");
      const modelConfig = structuredClone(config.deepseek || {});
      if (mode !== "rules" && !credentials.modelBudget) {
        const settings = (await repository.read()).settings.budgets || {},
          budgets = { ...settings, ...target.budgets };
        if (settings.maxCostCny != null && target.budgets?.maxCostCny != null)
          budgets.maxCostCny = Math.min(
            settings.maxCostCny,
            target.budgets.maxCostCny,
          );
        credentials = {
          ...credentials,
          modelBudget: createConfiguredModelBudget({ modelConfig, budgets }),
        };
      }
      const permit =
        credentials.permit || runGate?.acquire(credentials.ip || "local");
      if (permit && !permit.ok) {
        const e = Error(permit.reason);
        e.status = permit.status;
        e.retryAfterMs = permit.retryAfterMs;
        throw e;
      }
      const runId = "r-" + randomUUID();
      const frozen = {
        controller: new AbortController(),
        permit,
        profileRevision: structuredClone(profile),
        targetSnapshot: structuredClone(target),
        mode,
        credentials,
        modelConfig,
      };
      try {
        frozen.operationLease = await operationGate.acquire("collect", {
          targetRevisionId,
          profileRevisionId: profile.revisionId,
          parentLease,
        });
        await repository.mutateWorkspace((w) => {
          w.runs[runId] = {
            runId,
            targetSnapshot: frozen.targetSnapshot,
            profileRevisionId: profile.revisionId,
            mode,
            ownerPid: process.pid,
            status: "queued",
            stage: "queued",
            coverage: [],
            counts: {},
            usage: {},
            issues: [],
            lastSeq: 0,
            events: [],
            createdAt: now(),
            startedAt: null,
            finishedAt: null,
            snapshotRef: null,
          };
        });
      } catch (error) {
        permit?.release();
        await frozen.operationLease?.release();
        throw error;
      }
      active.set(runId, frozen);
      await recordDiagnostic(diagnostics, {
        operation: "run.started",
        runId,
        stage: "queued",
      });
      frozen.promise = Promise.resolve()
        .then(() =>
          withDiagnosticContext(
            { ...credentials.diagnosticContext, runId },
            () => execute(runId, frozen),
          ),
        )
        .finally(async () => {
          try {
            await frozen.operationLease.release();
          } finally {
            active.delete(runId);
          }
        });
      frozen.promise.catch((error) => {
        if (!error.diagnosticId)
          void recordDiagnostic(
            diagnostics,
            { operation: "run.failed", runId },
            error,
          );
      });
      return { runId, status: "queued" };
    },
    async getRun(runId) {
      const run = (await repository.read()).runs[runId];
      if (!run) throw Error("Run not found");
      return run;
    },
    async listRuns(filters = {}) {
      return Object.values((await repository.read()).runs)
        .filter(
          (r) =>
            (filters.includeDeleted || !r.deletedAt) &&
            (!filters.status || r.status === filters.status) &&
            (!filters.targetId ||
              r.targetSnapshot?.targetId === filters.targetId),
        )
        .sort((a, b) =>
          String(b.createdAt || b.startedAt).localeCompare(
            a.createdAt || a.startedAt,
          ),
        );
    },
    async cancelRun(runId) {
      const run = await service.getRun(runId);
      if (terminal.has(run.status)) return run;
      const task = active.get(runId);
      await update(runId, { cancelRequestedAt: now() });
      await recordDiagnostic(diagnostics, {
        operation: "run.cancel",
        runId,
        stage: run.stage,
        phase: "started",
        outcome: "cancelled",
        code: "cancel_requested",
      });
      if (task) task.controller.abort();
      else if (!hasLiveOwner(run))
        await update(runId, {
          status: "interrupted",
          stage: "finished",
          finishedAt: now(),
          issues: [...(run.issues || []), { code: "process_interrupted" }],
        });
      return service.getRun(runId);
    },
    async waitForRun(runId) {
      const task = active.get(runId);
      if (task) return task.promise;
      const run = await service.getRun(runId);
      if (!terminal.has(run.status))
        throw Error("Run belongs to another process");
      if (run.snapshotRef)
        return { ...(await repository.readRunSnapshot(runId)), run };
      return {
        run,
        profileRevision: await workspaceService.getProfileRevision(
          run.profileRevisionId,
        ),
        jobs: [],
        evaluations: [],
        events: run.events || [],
      };
    },
  };
  return service;
}
export function createRunService(options){
 const legacy=createLegacyRunService(options),instances=new Map();const repository=options.repository,gate=options.operationGate||createWorkspaceOperationGate({repository});
 async function instance(scope,runId){const w=await repository.read();assertScope(w,scope,repository.clock.now());if(runId)assertOwned(w,w.runs[runId],scope.packageId);const selected=exactScope(scope);
  if(!instances.has(selected.packageId)){
   const repo=runtimeRepository(repository,selected);
   const workspaceService={...options.workspaceService,
    async getTargetRevision(id){const v=await repo.read();return Object.values(v.targets).flat().find(t=>t.revisionId===id);},
    async getProfileRevision(id){const v=await repo.read();return Object.values(v.profiles).flat().find(p=>p.revisionId===id);}
   };
   const jobService={...options.jobService,ingestRecords:input=>options.jobService.ingestRecords({...input,scope:selected}),finalizeCoverage:input=>options.jobService.finalizeCoverage({...input,scope:selected})};
   const evaluationService={...options.evaluationService,evaluate:input=>options.evaluationService.evaluate({...input,scope:selected})};
   const eventHub=options.eventHub?{publish:(id,type,payload)=>options.eventHub.publish(id,type,payload,selected)}:null;
   instances.set(selected.packageId,createLegacyRunService({...options,repository:repo,workspaceService,jobService,evaluationService,eventHub,operationGate:runtimeGate(gate,selected)}));
  }
  return instances.get(selected.packageId);
 }
 const api={
  async startRun(input){if((await repository.read()).schemaVersion!==3)return legacy.startRun(input);const service=await instance(input.scope);return service.startRun({...input,targetRevisionId:input.scope.targetRevisionId});},
  async getRun(id,scope){if((await repository.read()).schemaVersion!==3)return legacy.getRun(id);return (await instance(scope,id)).getRun(id);},
  async listRuns(filters={}){const w=await repository.read();if(w.schemaVersion!==3)return legacy.listRuns(filters);if(!filters.allTargets)return (await instance(filters)).listRuns(filters);return Object.values(w.runs).filter(r=>w.packages[r.ownerPackageId]?.kind==='target'&&w.packages[r.ownerPackageId]?.state==='active'&&(!filters.status||r.status===filters.status)&&!r.deletedAt).map(r=>({...r,scope:{packageId:r.ownerPackageId,targetRevisionId:w.packages[r.ownerPackageId].versionId},versionName:w.packages[r.ownerPackageId].versionName})).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));},
  async cancelRun(id,scope){if((await repository.read()).schemaVersion!==3)return legacy.cancelRun(id);return (await instance(scope,id)).cancelRun(id);},
  async waitForRun(id,scope){if((await repository.read()).schemaVersion!==3)return legacy.waitForRun(id);return (await instance(scope,id)).waitForRun(id);},
  async cancelPackageAndWait(packageId){const w=await repository.read(),pkg=requirePackage(w,packageId,{now:repository.clock.now()});if(pkg.kind!=='target')return;const scope={packageId,targetRevisionId:pkg.versionId},ids=Object.values(w.runs).filter(r=>r.ownerPackageId===packageId&&!terminal.has(r.status)).map(r=>r.runId);for(const id of ids)await api.cancelRun(id,scope);for(const id of ids)if(instances.has(packageId))await api.waitForRun(id,scope);await gate.recover();for(;;){const current=await repository.read();if(!Object.values(current.runs).some(r=>r.ownerPackageId===packageId&&!terminal.has(r.status))&&!Object.values(current.operationLeases||{}).some(l=>l.packageIds?.includes(packageId)))break;await delay(50);}}
 };
 return api;
}
