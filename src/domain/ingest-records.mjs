import { contentHash } from "../infrastructure/storage/repository.mjs";
import {
  isCalendarDate,
  inputError,
} from "../../public/js/validation-rules.js";
import { assertSourceRecord } from "./contracts.mjs";
import { normalizeRecord } from "./record.mjs";
import { resolveJobIdentity, relateJobs } from "./identity.mjs";
import { jobBusinessFingerprint } from "./job-duplicates.mjs";
import { resolveJobId } from "./job-resolution.mjs";
import { addTargetMemberFact } from "./job-facts.mjs";
import { assertScope, assertOwned, packageError } from "./packages.mjs";
import {
  packageWorkspace,
  mergePackageWorkspace,
} from "./package-workspace.mjs";
export function ingestRecordsDraft(w, input) {
  const { scope, runId, records, observedAt, provenanceOperationId } = input;
  const targetRevisionId = scope?.targetRevisionId || input.targetRevisionId;
  if (!isCalendarDate(observedAt)) throw Error("Invalid date");
  if (w.schemaVersion === 3 && !w._scope) {
    assertScope(w, scope, new Date(observedAt));
    assertOwned(w, w.runs[runId], scope.packageId);
    const view = packageWorkspace(w, scope.packageId),
      result = ingestRecordsDraft(view, input);
    mergePackageWorkspace(w, view, scope.packageId);
    return result;
  }
  if (scope && w._scope?.packageId !== scope.packageId)
    throw packageError("package_scope_mismatch", "入库数据包范围不一致。");
  const now = () => observedAt;
  const group = (w, a, b, manual = false) => {
    const ids = [a, b].sort();
    const groupId = "g-" + contentHash(ids).slice(0, 24);
    w.duplicateGroups[groupId] = {
      groupId,
      jobIds: ids,
      manual,
      createdAt: now(),
    };
    for (const id of ids)
      w.jobs[id].duplicateGroupIds = [
        ...new Set([...(w.jobs[id].duplicateGroupIds || []), groupId]),
      ];
  };

  const jobIds = [],
    observationIds = [],
    newForTarget = [];
  const targetId = w.runs[runId]?.targetSnapshot?.targetId;
  const revisionId =
    targetRevisionId || w.runs[runId]?.targetSnapshot?.revisionId;
  if (
    revisionId &&
    !Object.values(w.targets)
      .flat()
      .some((t) => t.revisionId === revisionId)
  )
    throw inputError({ targetRevisionId: "未找到目标版本。" });
  for (const input of records) {
    const record = normalizeRecord(input);
    for (const key of [
      "status",
      "note",
      "appliedAt",
      "followUpAt",
      "resumeRevisionId",
      "events",
      "score",
      "ruleScore",
      "verdict",
      "reason",
      "tracking",
      "scoreHistory",
      "matchReason",
      "matchedKeywords",
    ])
      delete record[key];
    assertSourceRecord(record);
    const identity = resolveJobIdentity(record);
    const candidates = [
      ...new Set(
        identity.aliases.flatMap((alias) => w.identityAliases[alias] || []),
      ),
    ]
      .map((id) => w.jobs[resolveJobId(w, id, { allowMissing: true })])
      .filter(Boolean);
    const matches = candidates.filter(
      (j) => relateJobs(j.canonical, record).relation === "same",
    );
    let stored =
      matches.find(
        (j) => resolveJobIdentity(j.canonical).key === identity.key,
      ) || (matches.length === 1 ? matches[0] : null);
    // Producer input replay does not authorize merging unrelated weak historical entities.
    stored ||= candidates.find(
      (j) =>
        j.canonical.sourceId === record.sourceId &&
        j.canonical.identityScope === record.identityScope &&
        resolveJobIdentity(j.canonical).key === identity.key &&
        relateJobs(j.canonical, record).relation !== "distinct" &&
        jobBusinessFingerprint(j.canonical) === jobBusinessFingerprint(record),
    );
    if (!stored) {
      let jobId =
        "j-" +
        contentHash(
          w._scope ? [w._scope.packageId, identity.key] : identity.key,
        ).slice(0, 24);
      if (w.jobs[jobId]) jobId += "-" + jobBusinessFingerprint(record);
      if (w.jobs[jobId]) throw Error("Unresolved identity collision");
      stored = {
        jobId,
        kind: record.kind,
        canonical: record,
        sourceRefs: [],
        identityAliases: identity.aliases,
        firstSeen: observedAt,
        lastSeen: observedAt,
        targetFirstSeen: {},
        lifecycle: "observed",
        lifecycleEvidence: [],
        deadlinePassed: false,
        duplicateGroupIds: [],
        absenceCounts: {},
        observedScopes: {},
      };
      w.jobs[jobId] = stored;
      for (const j of Object.values(w.jobs))
        if (
          j.jobId !== jobId &&
          relateJobs(j.canonical, record).relation === "possible"
        )
          group(w, j.jobId, jobId);
    }
    const id = stored.jobId;
    stored.canonical = {
      ...record,
      ...(identity.strength !== "strong" &&
      resolveJobIdentity(stored.canonical).strength === "strong"
        ? Object.fromEntries(
            [
              "sourceId",
              "siteId",
              "identityScope",
              "sourceRecordId",
              "sourceRecordIdKind",
              "urlKind",
            ].map((k) => [k, stored.canonical[k]]),
          )
        : {}),
      description: record.description || stored.canonical.description,
    };
    stored.lastSeen =
      observedAt > stored.lastSeen ? observedAt : stored.lastSeen;
    stored.firstSeen =
      observedAt < stored.firstSeen ? observedAt : stored.firstSeen;
    stored.lifecycle = "observed";
    stored.lifecycleEvidence = [{ url: record.url, at: observedAt }];
    stored.deadlinePassed =
      !!record.deadlineAt &&
      Date.parse(record.deadlineAt) < Date.parse(observedAt);
    const ref = {
      sourceId: record.sourceId,
      siteId: record.siteId,
      sourceRecordId: record.sourceRecordId,
      sourceRecordIdKind: record.sourceRecordIdKind,
      identityScope: record.identityScope,
      urlKind: record.urlKind,
      url: record.url,
    };
    if (!stored.sourceRefs.some((x) => contentHash(x) === contentHash(ref)))
      stored.sourceRefs.push(ref);
    stored.identityAliases = [
      ...new Set([...stored.identityAliases, ...identity.aliases]),
    ];
    for (const alias of [...stored.identityAliases, input.id].filter(Boolean))
      w.identityAliases[alias] = [
        ...new Set([...(w.identityAliases[alias] || []), id]),
      ];
    if (targetId && !stored.targetFirstSeen[targetId]) {
      stored.targetFirstSeen[targetId] = observedAt;
      newForTarget.push(id);
    }
    const hash = contentHash(record);
    const oid =
      "o-" +
      contentHash([
        runId,
        record.sourceId,
        record.siteId,
        record.sourceRecordId,
        id,
        hash,
      ]).slice(0, 32);
    if (!w.observations[oid])
      w.observations[oid] = {
        observationId: oid,
        jobId: id,
        runId,
        ...(revisionId ? { targetRevisionId: revisionId } : {}),
        ...(provenanceOperationId ? { provenanceOperationId } : {}),
        sourceId: record.sourceId,
        siteId: record.siteId,
        sourceRecordId: record.sourceRecordId,
        observedAt,
        parserVersion: record.parserVersion,
        contentHash: hash,
        fields: record,
        evidence: record.evidence,
      };
    if (revisionId) {
      const wasMember = !!w.targetMembers?.[revisionId]?.[id];
      addTargetMemberFact(w, {
        targetRevisionId: revisionId,
        jobId: id,
        observationId: oid,
        provenanceOperationId,
      });
      if (!wasMember && !newForTarget.includes(id)) newForTarget.push(id);
    }
    jobIds.push(id);
    observationIds.push(oid);
  }
  return { jobIds, observationIds, newForTarget };
}
