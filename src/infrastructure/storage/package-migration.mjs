import { randomUUID } from "node:crypto";
import { contentHash } from "./repository.mjs";
import { createEmptyControl, applyDeletionLedger } from "./package-control.mjs";
import { assertWorkspace } from "../../domain/contracts.mjs";
import { normalizeWorkspaceExtensions } from "../../domain/workspace-management.mjs";
import { backfillTargetMembers } from "../../domain/job-facts.mjs";
import {
  packageRecords,
  countPackageRecords,
} from "../../domain/package-ownership.mjs";
import { packageError, RETENTION_MS } from "../../domain/packages.mjs";

const flat = (w, key) => Object.values(w[key] || {}).flat();
const time = (value) => new Date(value).toISOString();
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stable(value[k])]),
        )
      : value;
function immutableVersion(r, kind) {
  if (kind === "profile")
    return {
      text: r.text || "",
      profile: r.profile || {},
      overrides: r.overrides || {},
      parserVersion: r.parserVersion || null,
    };
  return Object.fromEntries(
    Object.entries(r).filter(
      ([k]) =>
        ![
          "enabled",
          "versionName",
          "archivedAt",
          "updatedAt",
          "availability",
          "references",
          "nameKey",
          "kind",
          "profileSnapshot",
          "ownerPackageId",
          "packageId",
          "recordId",
        ].includes(k),
    ),
  );
}
/** Pure conversion also used by restore and managed backup sanitation. UUID preparation is persisted by the caller before any body is written. */
export function normalizeBackupOwnership({
  workspace,
  snapshots = {},
  control,
  now = Date.now(),
}) {
  const c = structuredClone(control || createEmptyControl());
  const at = time(now),
    warnings = [];
  function identity(namespace, key) {
    const safeKey = "legacy:" + contentHash(key),
      index = c.identityIndex[namespace];
    if (!Object.hasOwn(index, safeKey)) index[safeKey] = randomUUID();
    return index[safeKey];
  }
  const finish = (w, ownedSnapshots) => {
    for (const [kind, key] of [
      ["profile", "profiles"],
      ["target", "targets"],
    ])
      for (const r of flat(w, key)) {
        const counter = kind + ":" + r[kind + "Id"];
        c.versionHighWater[counter] = Math.max(
          c.versionHighWater[counter] || 0,
          r.revision || 0,
        );
        w.versionCounters[kind][r[kind + "Id"]] = Math.max(
          w.versionCounters[kind][r[kind + "Id"]] || 0,
          c.versionHighWater[counter],
        );
      }
    const filtered = applyDeletionLedger(w, c),
      retained = {};
    for (const [id, s] of Object.entries(ownedSnapshots))
      if (
        filtered.runs[id] &&
        s.ownerPackageId === filtered.runs[id].ownerPackageId &&
        !Object.values(c.deletionLedger).some((d) =>
          d.recordIds?.includes(s.recordId),
        )
      )
        retained[id] = s;
    assertWorkspace(filtered);
    const counts = Object.fromEntries(
      [
        "profiles",
        "targets",
        "jobs",
        "observations",
        "evaluations",
        "runs",
        "applications",
        "events",
        "files",
      ].map((k) => [k, 0]),
    );
    let unassignedCount = 0;
    for (const { collection, record } of packageRecords(filtered)) {
      counts[collection]++;
      if (
        filtered.packages[record.ownerPackageId]?.kind === "legacy_unassigned"
      )
        unassignedCount++;
    }
    return {
      workspace: filtered,
      snapshots: retained,
      control: c,
      report: {
        packageCount: Object.keys(filtered.packages).length,
        counts,
        unassignedCount,
        warnings: [...new Set(warnings)],
      },
    };
  };
  if (workspace.schemaVersion === 3)
    return finish(
      normalizeWorkspaceExtensions(workspace),
      structuredClone(snapshots),
    );
  assertWorkspace(workspace);
  const old = normalizeWorkspaceExtensions(workspace),
    w = structuredClone(old);
  Object.assign(w, {
    schemaVersion: 3,
    packages: {},
    profiles: {},
    targets: {},
    jobs: {},
    observations: {},
    evaluations: {},
    runs: {},
    applications: {},
    events: {},
    files: {},
    targetMembers: {},
    identityAliases: {},
    jobRedirects: {},
    duplicateGroups: {},
    dedupOperations: {},
  });
  c.migrationJournal.legacyVersions ||= {};
  const profileMap = new Map(),
    targetMap = new Map(),
    runMap = new Map();
  function makePackage(kind, r, meta) {
    const digest = contentHash(stable(immutableVersion(r, kind))),
      versionKey = kind + ":" + r.revisionId;
    const prior = c.migrationJournal.legacyVersions[versionKey];
    if (prior && prior !== digest)
      throw packageError(
        "migration_identity_conflict",
        "旧版本标识对应的内容冲突，需修复后再迁移。",
        409,
      );
    c.migrationJournal.legacyVersions[versionKey] = digest;
    const id = identity("package", [kind, r.revisionId, digest]);
    const p = {
      packageId: id,
      kind,
      versionId: r.revisionId,
      versionName: meta.versionName,
      enabled: meta.enabled,
      state: "active",
      archiveId: null,
      archivedAt: null,
      purgeAt: null,
    };
    if (meta.archivedAt) {
      const episodeKey = "legacy:" + contentHash([id, meta.archivedAt]);
      let episode = c.archiveEpisodes[episodeKey];
      if (!episode) {
        const valid = Number.isFinite(Date.parse(meta.archivedAt));
        const archivedAt = valid ? time(meta.archivedAt) : at;
        episode = {
          packageId: id,
          archiveId: randomUUID(),
          archivedAt,
          purgeAt: time(
            Math.max(
              Date.parse(archivedAt) + RETENTION_MS,
              Date.parse(at) + RETENTION_MS,
            ),
          ),
          archiveDateUnknown: !valid,
          legacy: true,
        };
        c.archiveEpisodes[episodeKey] = episode;
      }
      Object.assign(p, {
        state: "trashed",
        archiveId: episode.archiveId,
        archivedAt: episode.archivedAt,
        purgeAt: episode.purgeAt,
        archiveDateUnknown: episode.archiveDateUnknown,
      });
      // Keep management metadata parseable even when the old date could not be verified.
      w.versionMetadata[r.revisionId].archivedAt = p.archivedAt;
    }
    w.packages[id] = p;
    return id;
  }
  function owned(collection, oldId, owner, r) {
    return {
      ...structuredClone(r),
      recordId: identity("record", [collection, oldId, owner]),
      ownerPackageId: owner,
    };
  }
  let legacyOwner;
  function unassigned() {
    if (!legacyOwner) {
      legacyOwner = identity("package", ["legacy_unassigned", c.workspaceId]);
      w.packages[legacyOwner] = {
        packageId: legacyOwner,
        kind: "legacy_unassigned",
        versionId: "legacy-unassigned@1",
        versionName: "待归属历史",
        enabled: true,
        state: "active",
        archiveId: null,
        archivedAt: null,
        purgeAt: null,
      };
    }
    return legacyOwner;
  }
  for (const r of flat(old, "profiles")) {
    const owner = makePackage("profile", r, old.versionMetadata[r.revisionId]);
    const item = owned("profiles", r.revisionId, owner, r);
    item.packageId = owner;
    (w.profiles[r.profileId] ||= []).push(item);
    profileMap.set(r.revisionId, item);
  }
  for (const r of flat(old, "targets")) {
    const owner = makePackage("target", r, old.versionMetadata[r.revisionId]);
    const item = owned("targets", r.revisionId, owner, r);
    item.packageId = owner;
    let source = profileMap.get(r.profileRevisionId);
    if (!source) {
      const verified = Object.values(old.runs)
        .filter(
          (run) =>
            run.targetSnapshot?.revisionId === r.revisionId &&
            run.profileSnapshot?.revisionId === r.profileRevisionId,
        )
        .map((run) => run.profileSnapshot);
      if (
        verified.length &&
        new Set(
          verified.map((s) =>
            contentHash(stable(immutableVersion(s, "profile"))),
          ),
        ).size === 1
      )
        source = verified[0];
    }
    item.profileSnapshot = source
      ? owned("profileSnapshot", r.revisionId, owner, {
          ...source,
          provenance: {
            profileRevisionId: r.profileRevisionId,
            sourcePackageId: source.ownerPackageId || null,
          },
        })
      : null;
    if (item.profileSnapshot) item.profileSnapshot.packageId = owner;
    item.incomplete = !item.profileSnapshot;
    if (item.incomplete) warnings.push("target_profile_unverified");
    (w.targets[r.targetId] ||= []).push(item);
    targetMap.set(r.revisionId, item);
  }
  const verifiedTarget = (id) => targetMap.get(id)?.ownerPackageId || null;
  const evidenceOwner = (r) => {
    const ids = [
      verifiedTarget(r.targetRevisionId),
      runMap.get(r.runId)?.ownerPackageId,
    ].filter(Boolean);
    return new Set(ids).size === 1 ? ids[0] : unassigned();
  };
  for (const [id, r] of Object.entries(old.runs)) {
    const target = targetMap.get(
        r.targetSnapshot?.revisionId || r.targetRevisionId,
      ),
      owner = target?.ownerPackageId || unassigned();
    const item = owned("runs", id, owner, r),
      newId = "r-" + item.recordId;
    item.runId = newId;
    item.provenance = { ...item.provenance, legacyRunId: id };
    item.snapshotRef = null;
    item.profileSnapshot = target?.profileSnapshot
      ? structuredClone(target.profileSnapshot)
      : null;
    // Embedded run snapshots are immutable copies, not separate main-map identities.
    item.targetSnapshot = target
      ? structuredClone(target)
      : r.targetSnapshot || null;
    item.events = (r.events || []).map((e, i) =>
      owned("runEvents", [id, e.seq ?? i], owner, e),
    );
    w.runs[newId] = item;
    runMap.set(id, item);
    if (r.snapshotRef && !snapshots[id])
      warnings.push("missing_legacy_snapshot");
  }
  const jobOwners = new Map(Object.keys(old.jobs).map((id) => [id, new Set()]));
  const observationOwner = new Map(),
    evaluationOwner = new Map(),
    applicationOwner = new Map();
  for (const [id, o] of Object.entries(old.observations)) {
    const owner = evidenceOwner(o);
    observationOwner.set(id, owner);
    jobOwners.get(o.jobId)?.add(owner);
  }
  for (const [id, e] of Object.entries(old.evaluations)) {
    const owner = evidenceOwner(e);
    evaluationOwner.set(id, owner);
    jobOwners.get(e.jobId)?.add(owner);
  }
  for (const [id, a] of Object.entries(old.applications)) {
    // Resume binding and job membership are not proof of a historical application's target.
    const owner = evidenceOwner(a);
    applicationOwner.set(id, owner);
    jobOwners.get(a.jobId)?.add(owner);
    for (const jobId of a.legacyJobIds || []) jobOwners.get(jobId)?.add(owner);
  }
  for (const group of Object.values(old.duplicateGroups || {}))
    if (group.manual) {
      const owner = verifiedTarget(group.targetRevisionId) || unassigned();
      for (const id of group.jobIds || []) jobOwners.get(id)?.add(owner);
    }
  const jobMap = new Map();
  for (const [id, j] of Object.entries(old.jobs)) {
    const owners = jobOwners.get(id);
    if (!owners.size) owners.add(unassigned());
    for (const owner of owners) {
      const item = owned("jobs", id, owner, j),
        newId = "j-" + item.recordId;
      item.jobId = newId;
      item.provenance = { ...item.provenance, legacyJobId: id };
      item.targetFirstSeen = {};
      item.duplicateGroupIds = [];
      for (const target of targetMap.values())
        if (target.ownerPackageId === owner)
          item.targetFirstSeen[target.revisionId] =
            j.targetFirstSeen?.[target.revisionId] || j.firstSeen;
      w.jobs[newId] = item;
      jobMap.set(owner + ":" + id, newId);
      for (const alias of [...(j.identityAliases || []), id])
        w.identityAliases[owner + ":" + alias] = [
          ...new Set([
            ...(w.identityAliases[owner + ":" + alias] || []),
            newId,
          ]),
        ];
    }
  }
  for (const [alias, ids] of Object.entries(old.identityAliases || {}))
    for (const owner of Object.keys(w.packages)) {
      const mapped = ids
        .map((id) => jobMap.get(owner + ":" + id))
        .filter(Boolean);
      if (mapped.length)
        w.identityAliases[owner + ":" + alias] = [
          ...new Set([
            ...(w.identityAliases[owner + ":" + alias] || []),
            ...mapped,
          ]),
        ];
    }
  for (const [id, g] of Object.entries(old.duplicateGroups || {})) {
    const owners = g.manual
      ? [verifiedTarget(g.targetRevisionId) || unassigned()]
      : Object.keys(w.packages);
    for (const owner of owners) {
      const jobIds = (g.jobIds || [])
        .map((id) => jobMap.get(owner + ":" + id))
        .filter(Boolean);
      if (jobIds.length < 2) continue;
      const item = owned("duplicateGroups", id, owner, g);
      item.groupId = "g-" + item.recordId;
      item.jobIds = jobIds;
      w.duplicateGroups[item.groupId] = item;
      for (const jobId of jobIds)
        w.jobs[jobId].duplicateGroupIds.push(item.groupId);
    }
  }
  for (const [id, redirect] of Object.entries(old.jobRedirects || {}))
    for (const owner of Object.keys(w.packages)) {
      let destination = redirect.toJobId;
      const seen = new Set();
      while (old.jobRedirects[destination] && !seen.has(destination)) {
        seen.add(destination);
        destination = old.jobRedirects[destination].toJobId;
      }
      const toJobId = jobMap.get(owner + ":" + destination);
      if (!toJobId) continue;
      w.jobRedirects[owner + ":" + id] = owned("jobRedirects", id, owner, {
        ...redirect,
        toJobId,
      });
      w.identityAliases[owner + ":" + id] = [toJobId];
    }
  for (const [id, o] of Object.entries(old.observations)) {
    const owner = observationOwner.get(id),
      jobId = jobMap.get(owner + ":" + o.jobId);
    if (!jobId) warnings.push("orphan_observation");
    const item = owned("observations", id, owner, o);
    item.observationId = "o-" + item.recordId;
    item.jobId = jobId || null;
    item.runId =
      runMap.get(o.runId)?.ownerPackageId === owner
        ? runMap.get(o.runId).runId
        : null;
    item.targetRevisionId =
      Object.values(w.targets)
        .flat()
        .find((t) => t.ownerPackageId === owner)?.revisionId || null;
    item.provenance = { ...item.provenance, legacyObservationId: id };
    w.observations[item.observationId] = item;
  }
  for (const [id, e] of Object.entries(old.evaluations)) {
    const owner = evaluationOwner.get(id),
      jobId = jobMap.get(owner + ":" + e.jobId);
    if (!jobId) warnings.push("orphan_evaluation");
    const item = owned("evaluations", id, owner, e);
    item.evaluationId = "e-" + item.recordId;
    item.jobId = jobId || null;
    item.runId =
      runMap.get(e.runId)?.ownerPackageId === owner
        ? runMap.get(e.runId).runId
        : null;
    if (item.observationId)
      item.observationId =
        Object.values(w.observations).find(
          (o) =>
            o.ownerPackageId === owner &&
            o.provenance?.legacyObservationId === item.observationId,
        )?.observationId || null;
    if (verifiedTarget(item.targetRevisionId) !== owner)
      item.targetRevisionId = null;
    item.provenance = { ...item.provenance, legacyEvaluationId: id };
    w.evaluations[item.evaluationId] = item;
  }
  for (const [id, a] of Object.entries(old.applications)) {
    const owner = applicationOwner.get(id),
      item = owned("applications", id, owner, a);
    item.applicationId = "a-" + item.recordId;
    item.jobId = jobMap.get(owner + ":" + a.jobId) || null;
    item.legacyJobIds = (a.legacyJobIds || [])
      .map((jobId) => jobMap.get(owner + ":" + jobId))
      .filter(Boolean);
    item.runId =
      runMap.get(a.runId)?.ownerPackageId === owner
        ? runMap.get(a.runId).runId
        : null;
    item.events = (a.events || []).map((e, i) =>
      owned("applicationEvents", [id, i], owner, e),
    );
    item.provenance = {
      ...item.provenance,
      legacyApplicationId: id,
      resumeRevisionId: a.resumeRevisionId || null,
    };
    item.resumeRevisionId =
      Object.values(w.targets)
        .flat()
        .find((t) => t.ownerPackageId === owner)?.profileSnapshot?.revisionId ||
      null;
    if (verifiedTarget(item.targetRevisionId) !== owner)
      item.targetRevisionId = null;
    w.applications[item.applicationId] = item;
  }
  for (const [id, event] of Object.entries(old.events || {})) {
    const run = runMap.get(event.runId),
      owner = run?.ownerPackageId || unassigned();
    const item = owned("events", id, owner, event);
    item.eventId = "ev-" + item.recordId;
    item.runId = run?.runId || null;
    if (item.jobId) item.jobId = jobMap.get(owner + ":" + item.jobId) || null;
    if (item.applicationId)
      item.applicationId =
        Object.values(w.applications).find(
          (a) =>
            a.ownerPackageId === owner &&
            a.provenance?.legacyApplicationId === item.applicationId,
        )?.applicationId || null;
    w.events[item.eventId] = item;
  }
  // Rebuild version facts from records with a verified owner, rather than from legacy global membership.
  backfillTargetMembers(w);
  const ownedSnapshots = {};
  for (const [oldId, run] of runMap) {
    const raw = snapshots[oldId];
    if (!raw) continue;
    const owner = run.ownerPackageId,
      sid = identity("record", ["snapshot", oldId, owner]);
    const snapshot = {
      recordId: sid,
      ownerPackageId: owner,
      run: structuredClone(run),
      profile: structuredClone(run.profileSnapshot),
      target: structuredClone(run.targetSnapshot),
      observations: Object.values(w.observations).filter(
        (o) => o.runId === run.runId,
      ),
      evaluations: Object.values(w.evaluations).filter(
        (e) => e.runId === run.runId,
      ),
      jobs: Object.values(w.jobs).filter((j) => j.ownerPackageId === owner),
    };
    if (w.packages[owner].kind === "legacy_unassigned")
      snapshot.legacyResult = structuredClone(raw.legacyResult || raw);
    run.snapshotRef = {
      path: "runs-v2/" + run.runId + ".json",
      hash: contentHash(snapshot),
    };
    ownedSnapshots[run.runId] = snapshot;
    const fileId = identity("record", ["snapshotFile", oldId, owner]);
    w.files[fileId] = {
      recordId: fileId,
      fileId,
      ownerPackageId: owner,
      runId: run.runId,
      path: run.snapshotRef.path,
      hash: run.snapshotRef.hash,
      kind: "run_snapshot",
      snapshotRecordId: sid,
    };
  }
  // Global recovery notes carry no private bodies; record-specific notes follow their record's owner.
  w.recoveryRecords = (old.recoveryRecords || []).map((note) => {
    const run = runMap.get(note.runId);
    return run
      ? { ...note, runId: run.runId, ownerPackageId: run.ownerPackageId }
      : note;
  });
  return finish(w, ownedSnapshots);
}
