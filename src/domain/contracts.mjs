/** Shared v2 contracts. Missing facts stay null; execution state differs from recommendation. */
export const SCHEMA_VERSION = 2;
export const APPLICATION_STATUSES = [
  "new",
  "seen",
  "interested",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "ignored",
];
export const JOB_KINDS = ["job", "recruitment_notice", "company_campaign"];
export const JOB_TYPES = ["campus", "internship", "social", "unknown"];
export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
];
export const LIFECYCLES = [
  "observed",
  "notRecentlySeen",
  "inaccessible",
  "closed",
  "unknown",
];
/** @typedef {{profileId:string,revision:number,revisionId:string,text:string,profile:object,overrides:object,contentHash:string,parserVersion:string,createdAt:string}} ProfileRevision */
/** @typedef {{targetId:string,revision:number,revisionId:string,profileRevisionId:string,enabled:boolean,roles:string[],cityMode:string,cities:string[],jobTypes:string[],sourceIds:string[],siteIds:string[],coverageMode:string,budgets:object}} SearchTarget */
/** @typedef {{sourceId:string,siteId:string,sourceRecordId:string|null,identityScope:string,kind:string,title:string,company:string|null,cities:string[],jobType:string,url:string,description:string|null,evidence:object[],parserVersion:string}} SourceRecord */
/** @typedef {{jobId:string,kind:string,canonical:SourceRecord,sourceRefs:object[],identityAliases:string[],firstSeen:string,lastSeen:string,targetFirstSeen:object,lifecycle:string,lifecycleEvidence:object[],deadlinePassed:boolean,duplicateGroupIds:string[]}} Job */
/** @typedef {{runId:string,targetSnapshot:SearchTarget,status:string,stage:string,coverage:object[],counts:object,usage:object,issues:object[],lastSeq:number,startedAt:string|null,finishedAt:string|null,snapshotRef:object|null}} Run */
/** @typedef {{evaluationId:string,jobId:string,profileRevisionId:string,targetRevisionId:string,jdHash:string,qualification:object,score:number,components:object,evidence:object[],gaps:string[],completeness:object,status:string,recommendation:string}} Evaluation */
/** @typedef {{jobId:string,status:string,note:string,resumeRevisionId:string|null,appliedAt:string|null,followUpAt:string|null,events:object[]}} Application */
/** @typedef {{schemaVersion:2,revision:number,profiles:object,targets:object,jobs:object,observations:object,evaluations:object,applications:object,runs:object,sourceHealth:object,identityAliases:object,duplicateGroups:object,recoveryRecords:object[],migration:object|null,settings:object}} Workspace */
export function createEmptyWorkspace() {
  return {
    schemaVersion: 2,
    revision: 0,
    profiles: {},
    targets: {},
    jobs: {},
    observations: {},
    evaluations: {},
    applications: {},
    runs: {},
    sourceHealth: {},
    identityAliases: {},
    duplicateGroups: {},
    recoveryRecords: [],
    migration: null,
    settings: { sourceOverrides: {}, customSites: [], model: {}, budgets: {} },
  };
}
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
export function assertWorkspace(value) {
  if (!plain(value) || value.schemaVersion !== 2)
    throw new Error("Unsupported workspace schema");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0)
    throw new Error("Invalid workspace revision");
  for (const key of [
    "profiles",
    "targets",
    "jobs",
    "observations",
    "evaluations",
    "applications",
    "runs",
    "sourceHealth",
    "identityAliases",
    "duplicateGroups",
    "settings",
  ])
    if (!plain(value[key])) throw new Error("Invalid workspace " + key);
  if (!Array.isArray(value.recoveryRecords))
    throw new Error("Invalid recoveryRecords");
  for (const key of ["profiles", "targets"])
    for (const list of Object.values(value[key]))
      if (!Array.isArray(list) || list.some((x) => !plain(x)))
        throw new Error("Invalid " + key + " revisions");
  for (const [id, job] of Object.entries(value.jobs))
    if (!plain(job) || job.jobId !== id || !JOB_KINDS.includes(job.kind))
      throw new Error("Invalid job " + id);
  for (const [id, application] of Object.entries(value.applications))
    if (
      !plain(application) ||
      application.jobId !== id ||
      !APPLICATION_STATUSES.includes(application.status)
    )
      throw new Error("Invalid application " + id);
  return value;
}
export function assertSourceRecord(value) {
  if (!plain(value) || typeof value.sourceId !== "string" || !value.sourceId)
    throw new Error("Missing sourceId");
  if (typeof value.title !== "string" || !value.title.trim())
    throw new Error("Missing source title");
  if (!(value.sourceId === "manual" && value.url === null)) {
    let url;
    try {
      url = new URL(value.url);
    } catch {
      throw new Error("Invalid source url");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid source url");
  }
  if (!JOB_KINDS.includes(value.kind) || !JOB_TYPES.includes(value.jobType))
    throw new Error("Invalid source kind/type");
  if (!Array.isArray(value.cities) || !Array.isArray(value.evidence))
    throw new Error("Invalid source evidence/cities");
  return value;
}
