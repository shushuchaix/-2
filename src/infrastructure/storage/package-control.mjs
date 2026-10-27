import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { writeAtomicJson } from "./atomic.mjs";
import { UUID_RE, packageError } from "../../domain/packages.mjs";
import { assertPurgeWorker, assertPurgeWorkerTransition, assertPurgePublication, assertPurgeFileIntent, assertPurgeTaskProofTransition } from '../maintenance/protocol.mjs';

const checksum = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = () =>
  packageError(
    "control_state_invalid",
    "控制状态损坏或缺失，已停止业务访问。请保留数据目录并查看诊断。",
    503,
  );
const maps = [
  "ownershipTransfers",
  "versionHighWater",
  "archiveEpisodes",
  "deletionLedger",
  "purgeTasks",
  "migrationJournal",
];
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
export function createEmptyControl(workspaceId = randomUUID()) {
  return {
    formatVersion: 1,
    workspaceId,
    identityIndex: { package: {}, record: {} },
    ...Object.fromEntries(maps.map((k) => [k, {}])),
  };
}
export function assertControl(c) {
  if (
    !plain(c) ||
    c.formatVersion !== 1 ||
    !UUID_RE.test(c.workspaceId) ||
    !plain(c.identityIndex) ||
    maps.some((k) => !plain(c[k]))
  )
    throw invalid();
  for (const namespace of ["package", "record"])
    if (
      !plain(c.identityIndex[namespace]) ||
      Object.values(c.identityIndex[namespace]).some((id) => !UUID_RE.test(id))
    )
      throw invalid();
  if (
    Object.values(c.versionHighWater).some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    )
  )
    throw invalid();
  for (const [id, entry] of Object.entries(c.deletionLedger)) {
    if (
      !UUID_RE.test(id) ||
      !["purge_pending", "purged"].includes(entry.phase) ||
      !Array.isArray(entry.recordIds) ||
      entry.recordIds.some((r) => !UUID_RE.test(r))
    )
      throw invalid();
    if (
      Object.keys(entry).some(
        (k) =>
          ![
            "phase",
            "recordIds",
            "archiveId",
            "archivedAt",
            "purgeAt",
            "operationId",
            "createdAt",
            "purgedAt",
            "counts",
            "code",
          ].includes(k),
      )
    )
      throw invalid();
  }
  for(const task of Object.values(c.purgeTasks))if(task?.worker!==undefined)assertPurgeWorker(task.worker,{task});
  for(const task of Object.values(c.purgeTasks)){
    if(task?.sqlPublication!==undefined)assertPurgePublication(task.sqlPublication,task);
    if(task?.fileIntent!==undefined)assertPurgeFileIntent(task.fileIntent,task);
  }
  return c;
}
export function assertControlTransition(previous, next) {
  assertControl(next);
  if (!previous) return;
  if (previous.workspaceId !== next.workspaceId) throw invalid();
  for (const namespace of ["package", "record"])
    for (const [key, id] of Object.entries(previous.identityIndex[namespace]))
      if (next.identityIndex[namespace][key] !== id) throw invalid();
  for (const [key, n] of Object.entries(previous.versionHighWater))
    if ((next.versionHighWater[key] ?? -1) < n) throw invalid();
  for(const [key,episode]of Object.entries(previous.archiveEpisodes)){
    const nextEpisode=next.archiveEpisodes[key];
    if(!nextEpisode||['packageId','archiveId','archivedAt','purgeAt','legacy','archiveDateUnknown'].some(field=>
      episode[field]!==undefined&&nextEpisode[field]!==episode[field]))throw invalid();
  }
  for (const [id, e] of Object.entries(previous.deletionLedger)) {
    const n = next.deletionLedger[id];
    if (
      !n ||
      e.recordIds.some((r) => !n.recordIds.includes(r)) ||
      (e.phase === "purged" && n.phase !== "purged") ||
      ['archiveId','archivedAt','purgeAt','operationId','createdAt','purgedAt'].some(field=>e[field]!==undefined&&n[field]!==e[field])
    )
      throw invalid();
  }
  for(const [id,task]of Object.entries(next.purgeTasks))if(task?.worker!==undefined||previous.purgeTasks[id]?.worker!==undefined)
    assertPurgeWorkerTransition(previous.purgeTasks[id]?.worker,task.worker,{task,previousTask:previous.purgeTasks[id],
      retirementTask:task.worker?.previousRetirement?.descriptor.taskId===id?previous.purgeTasks[id]:next.purgeTasks[task.worker?.previousRetirement?.descriptor.taskId]});
  for(const [id,task]of Object.entries(previous.purgeTasks))if(task?.worker!==undefined&&!Object.hasOwn(next.purgeTasks,id))throw invalid();
  for(const [id,task]of Object.entries(next.purgeTasks))if(task?.worker!==undefined||previous.purgeTasks[id]?.worker!==undefined)
    assertPurgeTaskProofTransition(previous.purgeTasks[id],task);
}
export function openPackageControl({
  dataDir,
  fsAdapter = fs,
  captureFileIdentity = false,
  onRenameRecovery,
}) {
  const dir = path.join(path.resolve(dataDir), "control"),
    state = path.join(dir, "state.json"),
    marker = path.join(dir, "initialized.json");
  const atomicOptions = (resource, identity = captureFileIdentity) => ({
    fsAdapter,
    captureFileIdentity: identity,
    onRenameRecovery: (event) => {
      // A completed rename cannot fail or wait on an optional observer.
      try {
        Promise.resolve(
          onRenameRecovery?.({
            resource,
            retryCount: event.retryCount,
            code: event.code,
            retryDelayMs: event.retryDelayMs,
          }),
        ).catch(() => {});
      } catch {}
    },
  });
  const atomicWrite = async (
    resource,
    file,
    value,
    identity = captureFileIdentity,
  ) => {
    try {
      return await writeAtomicJson(
        file,
        value,
        atomicOptions(resource, identity),
      );
    } catch (error) {
      // Only the writer of this fixed destination assigns its public alias.
      try {
        error.storageResource = resource;
      } catch {}
      throw error;
    }
  };
  const json = async (file) => {
    try {
      return JSON.parse(await fsAdapter.readFile(file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw invalid();
    }
  };
  async function read({ allowUninitialized = false } = {}) {
    const m = await json(marker),
      envelope = await json(state);
    if (!m && !envelope) {
      if (allowUninitialized) return null;
      throw invalid();
    }
    if (
      !m ||
      !envelope ||
      m.formatVersion !== 1 ||
      !["preparing", "ready"].includes(m.phase) ||
      !UUID_RE.test(m.workspaceId)
    )
      throw invalid();
    if (m.phase !== "ready" && !allowUninitialized) throw invalid();
    const { checksum: hash, ...c } = envelope;
    if (c.workspaceId !== m.workspaceId || hash !== checksum(c))
      throw invalid();
    return assertControl(c);
  }
  // Internal: caller must hold the workspace lock. This method never takes it again.
  async function commitInLock(next, { previous = null } = {}) {
    assertControlTransition(previous, next);
    const m = await json(marker);
    if (m && m.workspaceId !== next.workspaceId) throw invalid();
    if (!m)
      await atomicWrite(
        "control/initialized.json",
        marker,
        { formatVersion: 1, workspaceId: next.workspaceId, phase: "preparing" },
        false,
      );
    const stateIdentity = await atomicWrite(
      "control/state.json",
      state,
      { ...next, checksum: checksum(next) },
    );
    let markerIdentity;
    if (!m || m.phase !== "ready")
      markerIdentity = await atomicWrite(
        "control/initialized.json",
        marker,
        { formatVersion: 1, workspaceId: next.workspaceId, phase: "ready" },
      );
    return { state: stateIdentity, marker: markerIdentity };
  }
  return { read, commitInLock };
}
export async function reserveIdentity(tx, { namespace, key }) {
  if (
    !["package", "record"].includes(namespace) ||
    typeof key !== "string" ||
    !key
  )
    throw invalid();
  const next = structuredClone(tx.control || createEmptyControl());
  if (Object.hasOwn(next.identityIndex[namespace], key))
    return next.identityIndex[namespace][key];
  const id = randomUUID();
  next.identityIndex[namespace][key] = id;
  await tx.commitControl(next);
  return id;
}
export function applyDeletionLedger(workspace, control) {
  const w = structuredClone(workspace);
  if (w.schemaVersion !== 3 || !control) return w;
  const deletedPackages = new Set(Object.keys(control.deletionLedger));
  const deletedRecords = new Set(
    Object.values(control.deletionLedger).flatMap((e) => e.recordIds),
  );
  const removed = (r) =>
    r &&
    (deletedPackages.has(r.ownerPackageId) || deletedRecords.has(r.recordId));
  for (const key of ["profiles", "targets"])
    for (const [parent, list] of Object.entries(w[key])) {
      w[key][parent] = list.filter((r) => !removed(r));
      if (!w[key][parent].length) delete w[key][parent];
    }
  for (const key of [
    "jobs",
    "observations",
    "evaluations",
    "applications",
    "runs",
    "events",
    "files",
  ])
    for (const [id, r] of Object.entries(w[key] || {})) {
      if (removed(r)) delete w[key][id];
      else if (key === "applications")
        r.events = (r.events || []).filter((e) => !removed(e));
    }
  w.recoveryRecords = (w.recoveryRecords || []).filter((r) => !removed(r));
  const revisions = new Set(
    [
      ...Object.values(w.profiles).flat(),
      ...Object.values(w.targets).flat(),
    ].map((r) => r.revisionId),
  );
  for (const id of Object.keys(w.versionMetadata || {}))
    if (!revisions.has(id)) delete w.versionMetadata[id];
  for (const [id, members] of Object.entries(w.targetMembers || {})) {
    if (!revisions.has(id)) {
      delete w.targetMembers[id];
      continue;
    }
    for (const [jobId, m] of Object.entries(members))
      if (!w.jobs[jobId]) delete members[jobId];
      else {
        m.factRefs = (m.factRefs || []).filter(
          (r) => w.observations[r.observationId],
        );
        if (!m.factRefs.some((r) => r.observationId === m.currentObservationId))
          m.currentObservationId = m.factRefs.at(-1)?.observationId ?? null;
      }
  }
  for (const [id, r] of Object.entries(w.jobRedirects || {}))
    if (deletedPackages.has(r.ownerPackageId) || !w.jobs[r.toJobId])
      delete w.jobRedirects[id];
  for (const [id, g] of Object.entries(w.duplicateGroups || {})) {
    g.jobIds = g.jobIds.filter((jobId) => w.jobs[jobId]);
    if (g.jobIds.length < 2) delete w.duplicateGroups[id];
  }
  for (const [alias, ids] of Object.entries(w.identityAliases || {})) {
    w.identityAliases[alias] = ids.filter((id) => w.jobs[id]);
    if (!w.identityAliases[alias].length) delete w.identityAliases[alias];
  }
  for (const j of Object.values(w.jobs))
    j.duplicateGroupIds = (j.duplicateGroupIds || []).filter(
      (id) => w.duplicateGroups[id],
    );
  for (const [id, e] of Object.entries(control.deletionLedger))
      if (w.packages[id]) {
        delete w.packages[id].collectionCache;
        delete w.packages[id].collectionSettings;
      if (e.phase === "purged") delete w.packages[id];
      else
        Object.assign(w.packages[id], {
          state: "purge_pending",
          archiveId: e.archiveId,
          archivedAt: e.archivedAt,
          purgeAt: e.purgeAt,
        });
    }
  return w;
}
