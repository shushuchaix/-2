// Legacy API facade over the authoritative v2 workspace.
import path from "node:path";
import { DATA_ROOT } from "./config.mjs";
import { APPLICATION_STATUSES } from "./domain/contracts.mjs";
import {
  openWorkspaceRepository,
  contentHash,
} from "./infrastructure/storage/repository.mjs";
import { migrateV1 } from "./infrastructure/storage/migrate-v1.mjs";
import {upgradeWorkspace} from './infrastructure/storage/upgrade-workspace.mjs';
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
    await upgradeWorkspace({repository});
    return { repository, service: createJobService({ repository }) };
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
        ids.length === 1 &&
        ids[0] === job.jobId,
    )?.[0];
    const id = legacy || job.jobId;
    const evaluations = Object.values(w.evaluations)
      .filter((e) => e.jobId === job.jobId)
      .sort((a, b) =>
        String(b.createdAt || "").localeCompare(a.createdAt || ""),
      );
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
          .filter((o) => o.jobId === job.jobId)
          .map((o) => o.runId),
      ).size,
      score: evaluations[0]?.score ?? null,
      scoreHistory: evaluations.map((e) => ({
        at: e.createdAt,
        score: e.score,
      })),
      status: w.applications[job.jobId]?.status || "new",
      note: w.applications[job.jobId]?.note || "",
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
      const a = w.applications[id] || {
        jobId: id,
        status: "new",
        note: "",
        events: [],
      };
      if (rec.status) a.status = rec.status;
      if (Object.hasOwn(rec, "note")) a.note = rec.note;
      w.applications[id] = a;
    }
  });
  return { ok: true };
}
export async function upsert(
  jobs = [],
  { runId = "", at = new Date().toISOString(), persist = true } = {},
) {
  const ctx = await context();
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
  valid.forEach((j, i) =>
    (before.jobs[jobIds[i]] ? ongoing : added).push(j.id || jobIds[i]),
  );
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
  for (const j of jobs) {
    const rec =
      index.jobs[j.id] ||
      Object.values(index.jobs).find((r) => r.jobId === j.jobId);
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
