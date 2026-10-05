import { contentHash } from "../infrastructure/storage/repository.mjs";
import {
  assertSourceRecord,
  APPLICATION_STATUSES,
} from "../domain/contracts.mjs";
import { normalizeRecord } from "../domain/record.mjs";
import { resolveJobIdentity, relateJobs } from "../domain/identity.mjs";
import { deriveLifecycle } from "../domain/lifecycle.mjs";
const date = (v) => {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v)))
    throw Error("Invalid date");
  return v;
};
export function resolveStoredJobId(w, id) {
  if (w.jobs[id]) return id;
  const ids = w.identityAliases[id] || [];
  if (ids.length !== 1)
    throw Error(ids.length ? "Ambiguous legacy job id" : "Job not found");
  return ids[0];
}
export function createJobService({ repository, clock = repository.clock }) {
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
    async ingestRecords({ runId, records, observedAt = now() }) {
      date(observedAt);
      return (
        await repository.mutateWorkspace((w) => {
          const jobIds = [],
            observationIds = [],
            newForTarget = [];
          const targetId = w.runs[runId]?.targetSnapshot?.targetId;
          for (const input of records) {
            const record = normalizeRecord(input);
            for (const key of [
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
            const candidates = (w.identityAliases[identity.key] || [])
              .map((id) => w.jobs[id])
              .filter(Boolean);
            let stored = candidates.find(
              (j) => relateJobs(j.canonical, record).relation === "same",
            );
            if (!stored) {
              let jobId = "j-" + contentHash(identity.key).slice(0, 24);
              if (w.jobs[jobId])
                jobId +=
                  "-" +
                  contentHash([
                    record.cities,
                    record.jobType,
                    record.graduationYear,
                    record.title,
                    record.level,
                  ]).slice(0, 12);
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
              url: record.url,
            };
            if (
              !stored.sourceRefs.some(
                (x) => contentHash(x) === contentHash(ref),
              )
            )
              stored.sourceRefs.push(ref);
            for (const alias of [...identity.aliases, input.id].filter(Boolean))
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
                sourceId: record.sourceId,
                siteId: record.siteId,
                sourceRecordId: record.sourceRecordId,
                observedAt,
                parserVersion: record.parserVersion,
                contentHash: hash,
                fields: record,
                evidence: record.evidence,
              };
            jobIds.push(id);
            observationIds.push(oid);
          }
          return { jobIds, observationIds, newForTarget };
        })
      ).result;
    },
    async finalizeCoverage({ runId, coverage = [], detailEvidence = [] }) {
      return (
        await repository.mutateWorkspace((w) => {
          for (const job of Object.values(w.jobs)) {
            job.absenceCounts ||= {};
            job.observedScopes ||= {};
            const observations = Object.values(w.observations).filter(
              (o) => o.jobId === job.jobId && o.runId === runId,
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
              detailEvidence: detailEvidence.filter(
                (e) => e.jobId === job.jobId,
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
            if (!w.jobs[e.jobId] || !e.evaluationId)
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
      const w = await repository.read();
      let items = Object.values(w.jobs).map((job) => {
        const evaluations = Object.values(w.evaluations)
          .filter(
            (e) =>
              e.jobId === job.jobId &&
              (!filters.targetRevisionId ||
                e.targetRevisionId === filters.targetRevisionId),
          )
          .sort((a, b) =>
            String(b.createdAt || "").localeCompare(a.createdAt || ""),
          );
        return {
          job,
          ...job.canonical,
          jobId: job.jobId,
          application: w.applications[job.jobId] || {
            jobId: job.jobId,
            status: "new",
            note: "",
            events: [],
          },
          evaluation: evaluations[0] || null,
        };
      });
      if (filters.targetRevisionId) items = items.filter((i) => i.evaluation);
      if (filters.targetId)
        items = items.filter((i) => i.job.targetFirstSeen[filters.targetId]);
      if (filters.status)
        items = items.filter((i) => i.application.status === filters.status);
      if (filters.kind) items = items.filter((i) => i.kind === filters.kind);
      if (filters.sourceId)
        items = items.filter((i) =>
          i.job.sourceRefs.some((r) => r.sourceId === filters.sourceId),
        );
      if (filters.qualification)
        items = items.filter(
          (i) => i.evaluation?.qualification?.status === filters.qualification,
        );
      if (filters.recommendation)
        items = items.filter(
          (i) => i.evaluation?.recommendation === filters.recommendation,
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
    async getJob(id) {
      const w = await repository.read();
      id = resolveStoredJobId(w, id);
      const job = w.jobs[id];
      const relatedIds = new Set(
        job.duplicateGroupIds.flatMap(
          (g) => w.duplicateGroups[g]?.jobIds || [],
        ),
      );
      relatedIds.delete(id);
      return {
        job,
        observations: Object.values(w.observations).filter(
          (o) => o.jobId === id,
        ),
        evaluations: Object.values(w.evaluations).filter((e) => e.jobId === id),
        application: w.applications[id] || {
          jobId: id,
          status: "new",
          note: "",
          resumeRevisionId: null,
          appliedAt: null,
          followUpAt: null,
          events: [],
        },
        relatedJobs: [...relatedIds].map((i) => w.jobs[i]).filter(Boolean),
      };
    },
    async updateApplication(id, patch) {
      return (
        await repository.mutateWorkspace((w) => {
          id = resolveStoredJobId(w, id);
          const current = w.applications[id] || {
            jobId: id,
            status: "new",
            note: "",
            resumeRevisionId: null,
            appliedAt: null,
            followUpAt: null,
            events: [],
          };
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
                throw Error("Invalid resume revision");
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
          return current;
        })
      ).result;
    },
    async linkJobs(a, b) {
      return (
        await repository.mutateWorkspace((w) => {
          a = resolveStoredJobId(w, a);
          b = resolveStoredJobId(w, b);
          if (a === b) throw Error("Cannot link job to itself");
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
                w.jobs[jid].duplicateGroupIds = w.jobs[
                  jid
                ].duplicateGroupIds.filter((x) => x !== id);
              delete w.duplicateGroups[id];
            }
          return { unlinked: [a, b] };
        })
      ).result;
    },
  };
}
