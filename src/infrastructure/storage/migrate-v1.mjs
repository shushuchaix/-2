import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./repository.mjs";
import { writeAtomicJson } from "./atomic.mjs";
import { resolveJobIdentity, relateJobs } from "../../domain/identity.mjs";
import { normalizeRecord } from "../../domain/record.mjs";
import { jobBusinessFingerprint } from "../../domain/job-duplicates.mjs";
import { APPLICATION_STATUSES } from "../../domain/contracts.mjs";
import { redactBusiness } from "../../domain/redact.mjs";
export async function migrateV1({
  dataDir,
  repository,
  dryRun = false,
  memoryOnly = false,
}) {
  // Managed backup sanitation supplies already verified strings. Keep the
  // conversion inside its caller's memory repository, without rereading files
  // or producing another unfiltered backup.
  const memoryInputs =
    typeof memoryOnly === "object" ? memoryOnly?.inputs : null;
  if (
    memoryInputs !== null &&
    (!Array.isArray(memoryInputs) ||
      memoryInputs.some(
        (i) =>
          !i ||
          typeof i.path !== "string" ||
          typeof i.body !== "string" ||
          !/^(?:job-index\.json|runs\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json)$/.test(
            i.path,
          ),
      ) ||
      new Set(memoryInputs.map((i) => i.path)).size !== memoryInputs.length)
  )
    throw Error("Invalid memory migration inputs");
  const memoryMap =
    memoryInputs && new Map(memoryInputs.map((i) => [i.path, i.body]));
  const readLegacy = async (relative) => {
    if (!memoryMap) return fs.readFile(path.join(dataDir, relative), "utf8");
    if (!memoryMap.has(relative))
      throw Object.assign(Error("Legacy input absent"), { code: "ENOENT" });
    return memoryMap.get(relative);
  };
  const inputs = [];
  let index = null;
  try {
    const body = await readLegacy("job-index.json");
    inputs.push({ path: "job-index.json", body });
    try {
      index = JSON.parse(body);
      if (index.version !== 1 || !index.jobs || Array.isArray(index.jobs))
        throw Error("unsupported index");
    } catch (e) {
      throw Error("Corrupt legacy index: " + e.message);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const names = memoryMap
    ? [...memoryMap.keys()]
        .filter((p) => p.startsWith("runs/"))
        .map((p) => p.slice(5))
    : await fs.readdir(path.join(dataDir, "runs")).catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      });
  const runs = [],
    skipped = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const body = await readLegacy("runs/" + name);
    inputs.push({ path: "runs/" + name, body });
    try {
      const run = JSON.parse(body);
      if (!Array.isArray(run.jobs || run.results)) throw Error("no jobs array");
      const runId = run.runId || "legacy-" + contentHash(run).slice(0, 16);
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId))
        throw Error("Unsafe legacy run id");
      runs.push({ ...run, runId, jobs: run.jobs || run.results });
    } catch (e) {
      skipped.push({ file: name, reason: e.message });
    }
  }
  if (!inputs.length)
    return {
      status: "no_legacy",
      counts: { jobs: 0 },
      conflicts: [],
      skipped,
      backupPath: null,
      manifestPath: null,
    };
  const hash = contentHash(inputs);
  const current = await repository.read();
  if (current.migration?.inputHash === hash)
    return { ...current.migration, status: "already_migrated" };
  if (current.migration)
    throw Error("Legacy inputs changed after migration; resolve explicitly");
  const jobs = {},
    observations = {},
    evaluations = {},
    aliases = {};
  const at = new Date(repository.clock.now()).toISOString();
  const ingest = (input, runId, seenAt) => {
    if (!input?.title || !input.url) return;
    const r = normalizeRecord(input);
    for (const key of [
      "status",
      "note",
      "appliedAt",
      "followUpAt",
      "resumeRevisionId",
      "events",
      "tracking",
      "score",
      "ruleScore",
      "verdict",
      "reason",
      "scoreHistory",
      "matchReason",
      "matchedKeywords",
    ])
      delete r[key];
    let identity;
    try {
      identity = resolveJobIdentity(r);
    } catch (e) {
      skipped.push({ file: runId, reason: e.message });
      return;
    }
    const same = (stored) => {
      const relation = relateJobs(stored, r).relation;
      return (
        relation === "same" ||
        (relation !== "distinct" &&
          resolveJobIdentity(stored).key === identity.key &&
          jobBusinessFingerprint(stored) === jobBusinessFingerprint(r))
      );
    };
    const matches = [
      ...new Set(identity.aliases.flatMap((alias) => aliases[alias] || [])),
    ].filter((id) => same(jobs[id].canonical));
    let id =
      matches.find(
        (id) => resolveJobIdentity(jobs[id].canonical).key === identity.key,
      ) ||
      (matches.length === 1
        ? matches[0]
        : "j-" + contentHash(identity.key).slice(0, 24));
    if (jobs[id] && !same(jobs[id].canonical))
      id += "-" + jobBusinessFingerprint(r).slice(0, 24);
    const job = jobs[id] || {
      jobId: id,
      kind: r.kind,
      canonical: r,
      sourceRefs: [{ sourceId: r.sourceId, siteId: r.siteId, url: r.url }],
      identityAliases: identity.aliases,
      firstSeen: input.firstSeen || seenAt,
      lastSeen: input.lastSeen || seenAt,
      targetFirstSeen: {},
      lifecycle: "unknown",
      lifecycleEvidence: [],
      deadlinePassed: false,
      duplicateGroupIds: [],
    };
    job.canonical = {
      ...r,
      ...(identity.strength !== "strong" &&
      resolveJobIdentity(job.canonical).strength === "strong"
        ? Object.fromEntries(
            ["sourceId", "siteId", "identityScope", "sourceRecordId"].map(
              (k) => [k, job.canonical[k]],
            ),
          )
        : {}),
      description: r.description || job.canonical.description,
    };
    job.firstSeen =
      (input.firstSeen || seenAt) < job.firstSeen
        ? input.firstSeen || seenAt
        : job.firstSeen;
    job.lastSeen = seenAt > job.lastSeen ? seenAt : job.lastSeen;
    jobs[id] = job;
    job.identityAliases = [
      ...new Set([...job.identityAliases, ...identity.aliases]),
    ];
    for (const alias of [...job.identityAliases, input.id].filter(Boolean))
      aliases[alias] = [...new Set([...(aliases[alias] || []), id])];
    const oid = "o-" + contentHash([runId, id, r]).slice(0, 24);
    observations[oid] = {
      observationId: oid,
      jobId: id,
      runId,
      sourceId: r.sourceId,
      siteId: r.siteId,
      observedAt: seenAt,
      record: r,
      contentHash: contentHash(r),
    };
    if (typeof input.score === "number") {
      const eid =
        "legacy-" + contentHash([runId, id, input.score]).slice(0, 24);
      evaluations[eid] = {
        evaluationId: eid,
        jobId: id,
        profileRevisionId: null,
        targetRevisionId: null,
        jdHash: contentHash(r.description || ""),
        score: input.score,
        status: "legacy",
        recommendation: "insufficient",
        evidence: [],
        gaps: ["旧版评分未重新核验"],
      };
    }
  };
  for (const run of runs)
    for (const j of run.jobs)
      ingest(j, run.runId || "legacy", run.createdAt || at);
  for (const j of Object.values(index?.jobs || {}))
    ingest(j, "legacy-index", j.lastSeen || at);
  const applications = {},
    conflicts = [];
  for (const [oldId, rec] of Object.entries(index?.jobs || {})) {
    const ids = aliases[oldId] || [];
    if (ids.length > 1)
      conflicts.push({
        legacyId: oldId,
        jobIds: ids,
        reason: "ambiguous_legacy_identity",
      });
    if (!ids.length) continue;
    const id = ids.length === 1 ? ids[0] : "legacy:" + oldId;
    applications[id] = {
      jobId: id,
      status: APPLICATION_STATUSES.includes(rec.status) ? rec.status : "new",
      note: String(rec.note || ""),
      resumeRevisionId: null,
      appliedAt: rec.appliedAt || null,
      followUpAt: null,
      events: [{ type: "migration", at, legacyId: oldId }],
      legacyJobIds: ids,
    };
  }
  const summary = {
    status: dryRun ? "preview" : "migrated",
    inputHash: hash,
    version: 1,
    counts: {
      jobs: Object.keys(jobs).length,
      runs: runs.length,
      applications: Object.keys(applications).length,
    },
    conflicts,
    skipped,
    backupPath: memoryOnly
      ? null
      : path.join(dataDir, "backups", "v1-" + hash.slice(0, 16)),
    manifestPath: null,
  };
  summary.manifestPath = memoryOnly
    ? null
    : path.join(summary.backupPath, "manifest.json");
  if (dryRun) return summary;
  if (!memoryOnly) {
    await fs.mkdir(summary.backupPath, { recursive: true });
    for (const input of inputs) {
      const p = path.join(summary.backupPath, input.path);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, input.body, { flag: "wx" }).catch(async (e) => {
        if (e.code !== "EEXIST") throw e;
        if ((await fs.readFile(p, "utf8")) !== input.body)
          throw Error("Backup conflict");
      });
    }
    await writeAtomicJson(summary.manifestPath, {
      version: 1,
      inputHash: hash,
      files: inputs.map((i) => ({ path: i.path, hash: contentHash(i.body) })),
      counts: summary.counts,
      conflicts,
      skipped,
    });
  }
  const legacyRuns = {};
  for (const run of runs) {
    const id = run.runId;
    const metadata = {
      runId: id,
      status: "completed",
      stage: "legacy",
      startedAt: run.createdAt || null,
      finishedAt: run.createdAt || null,
      counts: { returned: run.jobs.length },
      coverage: [],
      issues: [],
      legacy: true,
    };
    const snapshotRef = await repository.writeRunSnapshot(id, {
      run: metadata,
      legacyResult: redactBusiness(run),
    });
    legacyRuns[id] = { ...metadata, snapshotRef };
  }
  await repository.mutateWorkspace((w) => {
    if (w.migration?.inputHash === hash) return;
    if (w.migration) throw Error("Concurrent migration conflict");
    Object.assign(w.jobs, jobs);
    Object.assign(w.observations, observations);
    Object.assign(w.evaluations, evaluations);
    Object.assign(w.applications, applications);
    Object.assign(w.identityAliases, aliases);
    w.migration = summary;
    for (const s of skipped)
      w.recoveryRecords.push({ type: "migration_issue", ...s, at });
    Object.assign(w.runs, legacyRuns);
  });
  return summary;
}
