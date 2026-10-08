// Legacy API facade over the authoritative v2 workspace.
import path from "node:path";
import { DATA_ROOT } from "./config.mjs";
import { APPLICATION_STATUSES } from "./domain/contracts.mjs";
import {
  openWorkspaceRepository,
  contentHash,
} from "./infrastructure/storage/repository.mjs";
import { migrateV1 } from "./infrastructure/storage/migrate-v1.mjs";
import { createWorkspaceOperationGate } from "./application/workspace-operations.mjs";
import {
  resolveJobId,
  resolveJobIds,
  jobIdMatches,
  projectJobApplication,
  findAssociatedApplication,
} from "./domain/job-resolution.mjs";
import {
  selectVersionJobFact,
  selectMatchingEvaluation,
} from "./domain/job-facts.mjs";
import { normalizeRecord } from "./domain/record.mjs";
import { upgradeWorkspace } from "./infrastructure/storage/upgrade-workspace.mjs";
import {
  createJobService,
  resolveStoredJobId,
} from "./application/job-service.mjs";
export const STATUSES = APPLICATION_STATUSES;
export const STATUS_LABELS = {
  new: "未处理",
  seen: "已看过",
  interested: "感兴趣",
  applied: "已投递",
  interviewing: "面试中",
  offer: "已录用",
  rejected: "已拒",
  ignored: "不感兴趣",
};
export const INDEX_PATH = path.join(DATA_ROOT, "workspace.v2.json");
let ready;
async function context() {
  ready ||= (async () => {
    const repository = await openWorkspaceRepository({ dataDir: DATA_ROOT });
    await migrateV1({ dataDir: DATA_ROOT, repository });
    await upgradeWorkspace({ repository });
    return {
      repository,
      operationGate: createWorkspaceOperationGate({ repository }),
      service: createJobService({ repository }),
    };
  })();
  return ready;
}
function view(w) {
  const jobs = {};
  for (const job of Object.values(w.jobs)) {
    const legacy = Object.entries(w.identityAliases).find(
      ([key, ids]) =>
        !key.startsWith("id:") &&
        !key.startsWith("url:") &&
        !key.startsWith("fields:") &&
        !key.startsWith("content:") &&
        !key.startsWith("input:") &&
        resolveJobIds(w, ids, { allowMissing: true }).length === 1 &&
        resolveJobId(w, ids[0], { allowMissing: true }) === job.jobId,
    )?.[0];
    const id = legacy || job.jobId;
    const evaluations = Object.values(w.evaluations)
      .filter((e) => jobIdMatches(w, e.jobId, job.jobId))
      .sort((a, b) =>
        String(b.createdAt || "").localeCompare(a.createdAt || ""),
      );
    const fact = selectVersionJobFact(w, { jobId: job.jobId }),
      evaluation = selectMatchingEvaluation(w, {
        jobId: job.jobId,
        factContentHash: fact.factContentHash,
      }),
      application = projectJobApplication(w, job.jobId);
    jobs[id] = {
      ...job.canonical,
      id,
      jobId: job.jobId,
      city: job.canonical.cities.join(" / "),
      source: job.canonical.sourceId,
      firstSeen: job.firstSeen,
      lastSeen: job.lastSeen,
      seenCount: new Set(
        Object.values(w.observations)
          .filter((o) => jobIdMatches(w, o.jobId, job.jobId))
          .map((o) => o.runId),
      ).size,
      score: evaluation?.score ?? null,
      scoreHistory: evaluations.map((e) => ({
        at: e.createdAt,
        score: e.score,
      })),
      status: application.status,
      note: application.note,
      lifecycle: job.lifecycle,
    };
  }
  return {
    version: 1,
    jobs,
    runs: Object.values(w.runs),
    updatedAt:
      Object.values(w.jobs)
        .map((j) => j.lastSeen)
        .sort()
        .at(-1) || "",
  };
}
export async function loadIndex() {
  return view(await (await context()).repository.read());
}
export async function saveIndex(index) {
  const { repository } = await context();
  await repository.mutateWorkspace((w) => {
    for (const rec of Object.values(index.jobs || {})) {
      const id = resolveStoredJobId(w, rec.jobId || rec.id);
      const a = findAssociatedApplication(w, id) || {
        jobId: id,
        status: "new",
        note: "",
        events: [],
      };
      const changes = {};
      for (const key of ["status", "note"])
        if (Object.hasOwn(rec, key) && a[key] !== rec[key]) {
          changes[key] = { from: a[key], to: rec[key] };
          a[key] = rec[key];
        }
      if (Object.keys(changes).length)
        a.events.push({
          type: "application_updated",
          at: new Date().toISOString(),
          changes,
        });
      w.applications[a.jobId] = a;
    }
  });
  return { ok: true };
}
export async function upsert(
  jobs = [],
  {
    runId = "",
    at = new Date().toISOString(),
    persist = true,
    operationLease,
  } = {},
) {
  const ctx = await context();
  if (persist && !operationLease)
    return ctx.operationGate.withOperation("legacy", {}, (lease) =>
      upsert(jobs, { runId, at, persist, operationLease: lease }),
    );
  const before = await ctx.repository.read();
  let repository = ctx.repository;
  if (!persist) {
    let state = structuredClone(before);
    repository = {
      ...repository,
      read: async () => structuredClone(state),
      mutateWorkspace: async (fn) => {
        const result = await fn(state);
        state.revision++;
        return { revision: state.revision, result };
      },
    };
  }
  const service = createJobService({ repository });
  const valid = jobs.filter((j) => j.title && j.url);
  const { jobIds } = await service.ingestRecords({
    runId: runId || "legacy-" + Date.now(),
    records: valid,
    observedAt: at,
  });
  const evaluations = valid.flatMap((j, i) =>
    typeof j.score === "number"
      ? [
          {
            evaluationId:
              "legacy-" + contentHash([runId, jobIds[i], j.score]).slice(0, 24),
            jobId: jobIds[i],
            jdHash: contentHash(normalizeRecord(j).description || ""),
            score: j.score,
            status: "legacy",
            targetRevisionId: null,
            createdAt: at,
          },
        ]
      : [],
  );
  if (evaluations.length) await service.saveEvaluations(evaluations);
  const added = [],
    ongoing = [];
  const counted = new Set();
  valid.forEach((j, i) => {
    if (counted.has(jobIds[i])) return;
    counted.add(jobIds[i]);
    (resolveJobId(before, jobIds[i], { allowMissing: true })
      ? ongoing
      : added
    ).push(j.id || jobIds[i]);
  });
  const index = view(await repository.read());
  return {
    added,
    ongoing,
    disappeared: [],
    saved: { ok: true },
    stats: {
      total: Object.keys(index.jobs).length,
      added: added.length,
      ongoing: ongoing.length,
      disappeared: 0,
      pruned: 0,
      persisted: persist,
    },
    index,
  };
}
export async function annotate(jobs = [], diff, { now = Date.now() } = {}) {
  const index = diff.index || (await loadIndex());
  const w = await (await context()).repository.read();
  for (const j of jobs) {
    const rec =
      index.jobs[j.id] ||
      Object.values(index.jobs).find((r) =>
        jobIdMatches(w, r.jobId, j.jobId || j.id),
      );
    j.tracking = {
      isNew: diff.added.includes(j.id || j.jobId),
      firstSeen: rec?.firstSeen || "",
      lastSeen: rec?.lastSeen || "",
      seenCount: rec?.seenCount || 1,
      status: rec?.status || "new",
      statusLabel: STATUS_LABELS[rec?.status || "new"],
      daysListed: rec?.firstSeen
        ? Math.max(0, Math.floor((now - Date.parse(rec.firstSeen)) / 864e5))
        : 0,
    };
  }
  return { jobs, disappearedIds: [] };
}
export async function setStatus(id, status, note) {
  const { service } = await context();
  const patch = { status };
  if (note !== undefined) patch.note = note;
  return service.updateApplication(id, patch);
}
export async function summary() {
  const index = await loadIndex();
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const rec of Object.values(index.jobs)) byStatus[rec.status]++;
  return {
    total: Object.keys(index.jobs).length,
    byStatus,
    statusLabels: STATUS_LABELS,
    staleCount: Object.values(index.jobs).filter(
      (r) => r.seenCount >= 5 && ["new", "seen"].includes(r.status),
    ).length,
    runs: index.runs.length,
    updatedAt: index.updatedAt,
  };
}
export async function listJobs({ status = "", limit = 200 } = {}) {
  return Object.values((await loadIndex()).jobs)
    .filter((r) => !status || r.status === status)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit);
}
