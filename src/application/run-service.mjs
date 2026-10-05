import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { loadSiteCatalog } from "../sources/catalog.mjs";
import { buildCollectionPlan } from "../sources/planning.mjs";
import { createSourceBudget } from "../infrastructure/http/budget.mjs";
import { createModelBudget } from "../llm/budget.mjs";
import { evaluateRules } from "../domain/ranking.mjs";
import { expandArticles } from "../match/article.mjs";
import { normalizeRecord } from "../domain/record.mjs";
import { hasLiveOwner } from "../infrastructure/storage/process-owner.mjs";
import { recordSourceHealth } from "./source-health.mjs";
const terminal = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);
export function createRunService({
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
}) {
  const active = new Map(),
    now = () => new Date(clock.now()).toISOString();
  async function update(id, patch) {
    return (
      await repository.mutateWorkspace((w) => {
        const run = w.runs[id];
        if (!run) throw Error("Run not found");
        Object.assign(run, patch);
        return run;
      })
    ).result;
  }
  async function emit(id, type, payload = {}) {
    if (eventHub) return eventHub.publish(id, type, payload);
    return (
      await repository.mutateWorkspace((w) => {
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
      })
    ).result;
  }
  async function execute(
    id,
    { controller, permit, profileRevision, targetSnapshot, mode, credentials },
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
      shortlisted: 0,
      aiSuccess: 0,
      fallback: 0,
      newForTarget: 0,
    };
    let plan, budget, client, modelBudget;
    let checking = false;
    // Keep an active run alive until it observes cross-entry cancellation.
    // The finally block releases this handle when execution reaches a terminal state.
    const cancellationPoll = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        if ((await repository.read()).runs[id]?.cancelRequestedAt)
          controller.abort();
      } catch {
      } finally {
        checking = false;
      }
    }, 500);
    async function ingest(records) {
      try {
        const result = await jobService.ingestRecords({ runId: id, records });
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
        await update(id, { counts: { ...counts } });
        await emit(id, "batch", {
          jobIds: result.jobIds,
          counts: { ...counts },
        });
        return result;
      } catch (error) {
        error.code = "workspace_write_failed";
        throw error;
      }
    }
    async function stage(name) {
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
          : modelFactory?.({ signal, budget: modelBudget, credentials });
      const request = requestFactory({ budget, signal });
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
        request,
        signal,
        clock,
        config,
        onBatch: ingest,
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
            continue;
          }
          try {
            const result = await provider.collect({
              ...context,
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
          } catch (error) {
            if (signal.aborted || error.code === "workspace_write_failed")
              throw error;
            const code = error.code || "source_unavailable";
            issues.push({
              code,
              sourceId: provider.id,
              siteId: context.sites[0].siteId,
              message: "来源采集未完成。",
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
        .map((jobId) => ({ jobId, ...workspaceNow.jobs[jobId].canonical }))
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
        try {
          budget.claimDetail(
            record.sourceId + "/" + record.siteId + "/" + record.sourceRecordId,
          );
          detail = await provider.fetchDetail(record, context);
        } catch (error) {
          if (signal.aborted) throw error;
          issues.push({
            code: error.code || "detail_unavailable",
            sourceId: record.sourceId,
            siteId: record.siteId,
            jobId: record.jobId,
            message: "详情未取得，保留已有事实。",
          });
          if (error.status === 404)
            detailEvidence.push({
              jobId: record.jobId,
              status: 404,
              url: record.url,
            });
          continue;
        }
        if (detail?.description) await ingest([detail]);
      }
      await saveSourceHealth();
      await stage("expanding");
      workspaceNow = await repository.read();
      const notices = [...jobIds]
        .map((jobId) => workspaceNow.jobs[jobId].canonical)
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
          { maxExpand: 5, concurrency: 1, signal },
        );
        signal.throwIfAborted();
        if (expanded.jobs.length) {
          await ingest(expanded.jobs.map(normalizeRecord));
          counts.expanded = expanded.jobs.length;
        }
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
      });
      evaluations.push(...result.evaluations);
      issues.push(...result.issues);
      counts.eligible = evaluations.filter(
        (e) => e.qualification.status === "pass",
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
        issues.push({
          code: error.code || "run_failed",
          message: "任务未完成，已保存的数据保留。",
        });
        await update(id, {
          status:
            error.code === "workspace_write_failed"
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
      permit?.release();
    }
    const workspace = await repository.read();
    const persisted = Object.values(workspace.evaluations).filter(
      (e) => e.runId === id,
    );
    const snapshot = {
      run: workspace.runs[id],
      profileRevision,
      jobs: [...jobIds].map((jobId) => workspace.jobs[jobId]),
      evaluations: evaluations.length ? evaluations : persisted,
      events: workspace.runs[id].events || [],
    };
    try {
      const snapshotRef = await repository.writeRunSnapshot(id, snapshot);
      await update(id, { snapshotRef });
      await emit(id, "done", { status: snapshot.run.status, counts });
      snapshot.run = (await repository.read()).runs[id];
      snapshot.events = snapshot.run.events || [];
    } catch (error) {
      await update(id, {
        status: "failed",
        issues: [
          ...issues,
          {
            code: "snapshot_failed",
            message: "运行快照未写入，恢复检查会报告缺失。",
          },
        ],
        snapshotRef: null,
      });
      await emit(id, "done", { status: "failed", counts });
      throw error;
    }
    return snapshot;
  }
  const service = {
    async startRun({ targetRevisionId, mode = "rules", credentials = {} }) {
      if (!["rules", "ai", "auto"].includes(mode))
        throw Error("Invalid run mode");
      const target = await workspaceService.getTargetRevision(targetRevisionId);
      if (!target || !target.enabled)
        throw Error("Enabled target revision required");
      const profile = await workspaceService.getProfileRevision(
        target.profileRevisionId,
      );
      if (!profile) throw Error("Profile revision missing");
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
      };
      try {
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
        throw error;
      }
      active.set(runId, frozen);
      frozen.promise = Promise.resolve()
        .then(() => execute(runId, frozen))
        .finally(() => active.delete(runId));
      frozen.promise.catch(() => {});
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
