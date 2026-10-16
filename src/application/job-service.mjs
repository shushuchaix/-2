import { ingestRecordsDraft } from "../domain/ingest-records.mjs";
import {
  assessRecruitmentEvidence,
  gateRecommendation,
} from "../domain/recruitment-evidence.mjs";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { createPackageJobService } from "./package-job-service.mjs";
import {
  assertInput,
  inputError,
  isCalendarDate,
} from "../../public/js/validation-rules.js";
import {
  assertSourceRecord,
  APPLICATION_STATUSES,
} from "../domain/contracts.mjs";
import { normalizeRecord } from "../domain/record.mjs";
import { resolveJobIdentity, relateJobs } from "../domain/identity.mjs";
import { buildWorkspaceDuplicatePlan } from "../domain/job-duplicates.mjs";
import { jobBusinessFingerprint } from "../domain/job-duplicates.mjs";
import {
  resolveJobId,
  resolveJobIds,
  jobIdMatches,
  resolveApplicationAssociation,
  findAssociatedApplication,
  projectJobApplication,
} from "../domain/job-resolution.mjs";
import { deriveLifecycle } from "../domain/lifecycle.mjs";
import {
  addTargetMemberFact,
  backfillTargetMembers,
  selectVersionJobFact,
  selectMatchingEvaluation,
  resolveEvaluationFactBasis,
} from "../domain/job-facts.mjs";
const date = (v) => {
  if (!isCalendarDate(v)) throw Error("Invalid date");
  return v;
};
export function resolveStoredJobId(w, id) {
  return resolveJobId(w, id);
}
function createLegacyJobService({ repository, clock = repository.clock }) {
  const now = () => new Date(clock.now()).toISOString();
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
  return {
    async ingestRecords({
      runId,
      records,
      observedAt = now(),
      targetRevisionId,
      provenanceOperationId,
    }) {
      return (
        await repository.mutateWorkspace((w) =>
          ingestRecordsDraft(w, {
            runId,
            records,
            observedAt,
            targetRevisionId,
            provenanceOperationId,
          }),
        )
      ).result;
    },
    async finalizeCoverage({ runId, coverage = [], detailEvidence = [] }) {
      return (
        await repository.mutateWorkspace((w) => {
          for (const job of Object.values(w.jobs)) {
            job.absenceCounts ||= {};
            job.observedScopes ||= {};
            const observations = Object.values(w.observations).filter(
              (o) => jobIdMatches(w, o.jobId, job.jobId) && o.runId === runId,
            );
            const relevant = coverage
              .filter((c) =>
                job.sourceRefs.some(
                  (r) => r.sourceId === c.sourceId && r.siteId === c.siteId,
                ),
              )
              .map((c) => ({
                ...c,
                scopeKey:
                  c.scopeKey ||
                  contentHash([c.sourceId, c.siteId, c.queries, c.cities]),
                previouslyObserved: false,
              }));
            for (const c of relevant) {
              c.previouslyObserved = !!job.observedScopes[c.scopeKey];
              if (
                observations.some(
                  (o) => o.sourceId === c.sourceId && o.siteId === c.siteId,
                )
              ) {
                job.observedScopes[c.scopeKey] = true;
                job.absenceCounts[c.scopeKey] = 0;
              }
            }
            const lifecycle = deriveLifecycle({
              previous: job,
              observations,
              coverage: relevant,
              detailEvidence: detailEvidence.filter((e) =>
                jobIdMatches(w, e.jobId, job.jobId),
              ),
              now: new Date(clock.now()),
            });
            job.lifecycle = lifecycle.state;
            job.lifecycleEvidence = lifecycle.evidence;
            job.deadlinePassed = lifecycle.deadlinePassed;
            for (const c of relevant)
              if (
                c.status === "complete" &&
                !c.truncated &&
                c.previouslyObserved &&
                !observations.some(
                  (o) => o.sourceId === c.sourceId && o.siteId === c.siteId,
                )
              )
                job.absenceCounts[c.scopeKey] =
                  (job.absenceCounts[c.scopeKey] || 0) + 1;
          }
          return { updated: Object.keys(w.jobs).length };
        })
      ).result;
    },
    async saveEvaluations(evaluations) {
      return (
        await repository.mutateWorkspace((w) => {
          for (const e of evaluations) {
            if (
              !resolveJobId(w, e.jobId, { allowMissing: true }) ||
              !e.evaluationId
            )
              throw Error("Invalid evaluation reference");
            if (
              w.evaluations[e.evaluationId] &&
              contentHash(w.evaluations[e.evaluationId]) !== contentHash(e)
            )
              throw Error("Evaluation immutable");
            w.evaluations[e.evaluationId] = structuredClone(e);
          }
          return evaluations;
        })
      ).result;
    },
    async queryJobs(filters = {}) {
      assertInput("filters", {
        ...filters,
        targetRevisionId: ["all", "unassigned"].includes(
          filters.targetRevisionId,
        )
          ? undefined
          : filters.targetRevisionId,
      });
      const w = await repository.read();
      backfillTargetMembers(w);
      const revisionId = ["all", "unassigned"].includes(
        filters.targetRevisionId,
      )
        ? null
        : filters.targetRevisionId;
      const target = revisionId
        ? Object.values(w.targets)
            .flat()
            .find((t) => t.revisionId === revisionId)
        : null;
      if (
        revisionId &&
        (!target || (filters.targetId && target.targetId !== filters.targetId))
      )
        throw inputError({
          targetRevisionId: "目标版本不存在或与所属目标不匹配。",
        });
      const duplicateStatuses = new Map();
      const duplicatePlan = buildWorkspaceDuplicatePlan(w);
      for (const pair of duplicatePlan.possiblePairs)
        for (const id of pair.jobIds) duplicateStatuses.set(id, "possible");
      for (const g of duplicatePlan.groups)
        for (const id of [g.keepJobId, ...g.removeJobIds])
          duplicateStatuses.set(
            id,
            g.protected
              ? "protected"
              : duplicateStatuses.get(id) === "protected"
                ? "protected"
                : "possible",
          );
      let items = Object.values(w.jobs).map((job) => {
        const itemTarget =
          target ||
          (filters.targetId
            ? (w.targets[filters.targetId] || [])
                .filter((t) => w.targetMembers[t.revisionId]?.[job.jobId])
                .sort((a, b) => b.revision - a.revision)[0]
            : null);
        const itemRevisionId = revisionId || itemTarget?.revisionId;
        const fact = selectVersionJobFact(w, {
          targetRevisionId: itemRevisionId,
          jobId: job.jobId,
        });
        const evaluation = selectMatchingEvaluation(w, {
          jobId: job.jobId,
          targetRevisionId: itemRevisionId,
          profileRevisionId: itemTarget?.profileRevisionId,
          factContentHash: fact.factContentHash,
        });
        return {
          job,
          ...(fact.record ||
            (itemRevisionId
              ? {
                  title: job.canonical.title,
                  company: job.canonical.company,
                  kind: job.kind,
                  cities: [],
                }
              : job.canonical)),
          fact,
          duplicateStatus: duplicateStatuses.get(job.jobId) || "normal",
          jobId: job.jobId,
          application: projectJobApplication(w, job.jobId),
          recruitmentEvidence: assessRecruitmentEvidence({
            record: fact.record || job.canonical,
            now: clock.now(),
          }),
          evaluation: evaluation
            ? gateRecommendation(
                { ...evaluation, jobId: job.jobId },
                fact.record || job.canonical,
                clock.now(),
              )
            : null,
        };
      });
      if (revisionId)
        items = items.filter((i) => w.targetMembers[revisionId]?.[i.jobId]);
      if (filters.targetRevisionId === "unassigned")
        items = items.filter(
          (i) => !Object.values(w.targetMembers).some((m) => m[i.jobId]),
        );
      if (filters.targetId)
        items = items.filter((i) =>
          (w.targets[filters.targetId] || []).some(
            (t) => w.targetMembers[t.revisionId]?.[i.jobId],
          ),
        );
      const applicationStatus = filters.applicationStatus || filters.status;
      if (filters.openingStatus && filters.openingStatus !== "all")
        items = items.filter(
          (i) => i.recruitmentEvidence.openingStatus === filters.openingStatus,
        );
      if (applicationStatus && applicationStatus !== "all")
        items = items.filter((i) => i.application.status === applicationStatus);
      if (filters.duplicateStatus && filters.duplicateStatus !== "all")
        items = items.filter(
          (i) => i.duplicateStatus === filters.duplicateStatus,
        );
      if (filters.kind && filters.kind !== "all")
        items = items.filter((i) => i.kind === filters.kind);
      if (filters.sourceId)
        items = items.filter((i) =>
          i.job.sourceRefs.some((r) => r.sourceId === filters.sourceId),
        );
      if (filters.qualification && filters.qualification !== "all")
        items = items.filter(
          (i) =>
            (i.evaluation?.qualification?.status || "unknown") ===
            filters.qualification,
        );
      if (filters.recommendation && filters.recommendation !== "all")
        items = items.filter((i) =>
          filters.recommendation === "unevaluated"
            ? !i.evaluation
            : i.evaluation?.recommendation === filters.recommendation,
        );
      if (filters.cities?.length)
        items = items.filter((i) =>
          i.cities.some((c) => filters.cities.includes(c)),
        );
      if (filters.since)
        items = items.filter((i) => i.job.lastSeen >= date(filters.since));
      if (filters.search) {
        const q = String(filters.search).toLowerCase();
        items = items.filter((i) =>
          [i.title, i.company, i.description, i.application.note]
            .join(" ")
            .toLowerCase()
            .includes(q),
        );
      }
      items.sort(
        (a, b) =>
          (b.evaluation?.score || 0) - (a.evaluation?.score || 0) ||
          b.job.lastSeen.localeCompare(a.job.lastSeen),
      );
      const total = items.length,
        page = Math.max(1, Number(filters.page) || 1),
        pageSize = Math.max(1, Math.min(200, Number(filters.pageSize) || 50));
      return {
        items: items.slice((page - 1) * pageSize, page * pageSize),
        total,
        page,
        pageSize,
      };
    },
    async getJob(id, { targetRevisionId } = {}) {
      const w = await repository.read();
      backfillTargetMembers(w);
      const requestedJobId = id;
      id = resolveStoredJobId(w, id);
      const job = w.jobs[id];
      if (
        targetRevisionId &&
        !Object.values(w.targets)
          .flat()
          .some((t) => t.revisionId === targetRevisionId)
      )
        throw inputError({ targetRevisionId: "未找到目标版本。" });
      const target = Object.values(w.targets)
        .flat()
        .find((t) => t.revisionId === targetRevisionId);
      const fact = selectVersionJobFact(w, { targetRevisionId, jobId: id });
      const evaluation = selectMatchingEvaluation(w, {
        jobId: id,
        targetRevisionId,
        profileRevisionId: target?.profileRevisionId,
        factContentHash: fact.factContentHash,
      });
      const relatedIds = new Set(
        resolveJobIds(
          w,
          (job.duplicateGroupIds || []).flatMap(
            (g) => w.duplicateGroups[g]?.jobIds || [],
          ),
          { allowMissing: true },
        ),
      );
      relatedIds.delete(id);
      return {
        job: targetRevisionId
          ? {
              ...job,
              canonical: fact.record || {
                title: job.canonical.title,
                company: job.canonical.company,
                kind: job.kind,
                cities: [],
              },
            }
          : job,
        jobId: id,
        requestedJobId,
        fact,
        targetRevisionId: targetRevisionId || null,
        recruitmentEvidence: assessRecruitmentEvidence({
          record: fact.record || job.canonical,
          now: clock.now(),
        }),
        evaluation: evaluation
          ? gateRecommendation(
              { ...evaluation, jobId: id },
              fact.record || job.canonical,
              clock.now(),
            )
          : null,
        observations: Object.values(w.observations).filter((o) =>
          jobIdMatches(w, o.jobId, id),
        ),
        evaluations: Object.values(w.evaluations)
          .filter((e) => jobIdMatches(w, e.jobId, id))
          .map((e) => ({
            ...e,
            factBasis: resolveEvaluationFactBasis(w, e),
            matchesCurrentFact: e.evaluationId === evaluation?.evaluationId,
          })),
        application: projectJobApplication(w, id),
        relatedJobs: [...relatedIds].map((i) => w.jobs[i]).filter(Boolean),
        unresolvedApplications: Object.values(w.applications).filter((a) => {
          const association = resolveApplicationAssociation(w, a);
          return (
            association.status === "ambiguous" &&
            association.jobIds.includes(id)
          );
        }),
      };
    },
    async listUnresolvedApplications(filters = {}) {
      assertInput("filters", filters);
      const w = await repository.read();
      const items = Object.values(w.applications)
        .filter((a) => resolveApplicationAssociation(w, a).status !== "single")
        .filter(
          (a) =>
            !(filters.applicationStatus || filters.status) ||
            (filters.applicationStatus || filters.status) === "all" ||
            a.status === (filters.applicationStatus || filters.status),
        )
        .filter(
          (a) =>
            !filters.search ||
            [a.jobId, a.note]
              .join(" ")
              .toLowerCase()
              .includes(String(filters.search).toLowerCase()),
        )
        .map((application) => ({
          application,
          association: resolveApplicationAssociation(w, application),
          candidateJobs: resolveApplicationAssociation(w, application)
            .jobIds.map((id) => w.jobs[id])
            .filter(Boolean),
        }));
      return { items, total: items.length };
    },
    async getApplication(id) {
      const w = await repository.read();
      const a = w.applications[id];
      if (a) {
        const association = resolveApplicationAssociation(w, a);
        return {
          application:
            association.status === "single"
              ? {
                  ...a,
                  jobId: association.jobIds[0],
                  originalApplicationId: a.jobId,
                }
              : a,
          association,
          candidateJobs: association.jobIds.map((j) => w.jobs[j]),
          unresolved: association.status !== "single",
        };
      }
      const application = projectJobApplication(w, id);
      return {
        application,
        association: resolveApplicationAssociation(w, application),
        unresolved: false,
      };
    },
    async updateApplication(id, patch) {
      assertInput("application", patch);
      return (
        await repository.mutateWorkspace((w) => {
          const requested = id;
          const associated =
            w.applications[id] ||
            findAssociatedApplication(w, resolveStoredJobId(w, id));
          id = associated?.jobId || resolveStoredJobId(w, id);
          const current = associated || {
            jobId: id,
            status: "new",
            note: "",
            resumeRevisionId: null,
            appliedAt: null,
            followUpAt: null,
            events: [],
          };
          current.events ||= [];
          const changes = {};
          for (const key of [
            "status",
            "note",
            "resumeRevisionId",
            "appliedAt",
            "followUpAt",
          ])
            if (Object.hasOwn(patch, key)) {
              const value = patch[key];
              if (key === "status" && !APPLICATION_STATUSES.includes(value))
                throw Error("Invalid application status");
              if (
                key === "note" &&
                (typeof value !== "string" || value.length > 20000)
              )
                throw Error("Invalid note");
              if (["appliedAt", "followUpAt"].includes(key) && value !== null)
                date(value);
              if (
                key === "resumeRevisionId" &&
                value !== null &&
                !Object.values(w.profiles)
                  .flat()
                  .some((p) => p.revisionId === value)
              )
                throw inputError({
                  resumeRevisionId: "简历版本已不存在，请重新选择。",
                });
              if (current[key] !== value)
                changes[key] = { from: current[key], to: value };
              current[key] = value;
            }
          if (Object.keys(changes).length)
            current.events.push({
              type: "application_updated",
              at: now(),
              changes,
            });
          w.applications[id] = current;
          const association = resolveApplicationAssociation(w, current);
          return {
            ...current,
            jobId:
              association.status === "single"
                ? association.jobIds[0]
                : current.jobId,
            originalApplicationId: current.jobId,
            requestedJobId: requested,
            association,
          };
        })
      ).result;
    },
    async linkJobs(a, b) {
      assertInput("link", { jobId: b }, { selfId: a });
      return (
        await repository.mutateWorkspace((w) => {
          a = resolveStoredJobId(w, a);
          try {
            b = resolveStoredJobId(w, b);
          } catch {
            throw inputError({ jobId: "未找到该岗位，请核对岗位编号。" });
          }
          if (a === b) throw inputError({ jobId: "不能将岗位关联到自身。" });
          group(w, a, b, true);
          return { linked: [a, b] };
        })
      ).result;
    },
    async unlinkJobs(a, b) {
      return (
        await repository.mutateWorkspace((w) => {
          a = resolveStoredJobId(w, a);
          b = resolveStoredJobId(w, b);
          for (const [id, g] of Object.entries(w.duplicateGroups))
            if (g.jobIds.includes(a) && g.jobIds.includes(b)) {
              for (const jid of g.jobIds)
                w.jobs[resolveStoredJobId(w, jid)].duplicateGroupIds = w.jobs[
                  resolveStoredJobId(w, jid)
                ].duplicateGroupIds.filter((x) => x !== id);
              delete w.duplicateGroups[id];
            }
          return { unlinked: [a, b] };
        })
      ).result;
    },
  };
}
export function createJobService(options) {
  const legacy = createLegacyJobService(options),
    scoped = createPackageJobService({
      ...options,
      legacyFactory: createLegacyJobService,
    });
  return Object.fromEntries(
    [...new Set([...Object.keys(legacy), ...Object.keys(scoped)])].map(
      (name) => [
        name,
        async (...args) => {
          const w = await options.repository.read();
          const implementation = w.schemaVersion === 3 ? scoped : legacy;
          if (!implementation[name])
            throw Object.assign(Error("该入口需要准确的目标版本。"), {
              code: "version_scope_required",
              status: 409,
            });
          return implementation[name](...args);
        },
      ],
    ),
  );
}
