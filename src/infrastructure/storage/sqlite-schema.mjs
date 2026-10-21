/** Fixed identifiers only. Values are always bound by sqlite-store.mjs. */
export const SQLITE_STORE_VERSION = 1;
export const SQLITE_COLLECTIONS = Object.freeze([
  'packages', 'profiles', 'targets', 'profileCopies', 'jobs', 'observations',
  'evaluations', 'applications', 'runs', 'events', 'files', 'sourceHealth',
  'identityAliasLinks', 'aliasGroups', 'duplicateGroups', 'jobRedirects',
  'versionMetadata', 'versionSubmissions', 'versionCounters', 'targetMembers',
  'memberGroups', 'profileGroups', 'targetGroups', 'dedupOperations',
  'operationLeases', 'recoveryRecords', 'workspaceFields', 'settings',
  'runEvents', 'applicationEvents', 'runSnapshots', 'runCoverage', 'runIssues',
  'runEvaluationIds', 'activityUnits', 'reservations', 'activityUsage',
  'contentBodies', 'contentArticles', 'articleCache', 'contentLinks',
  'officialLinkCache', 'activityJobIds', 'conditionalCache', 'jobProjections',
  'maintenanceTasks', 'sourceRotation', 'jobIdentityKeys', 'jobFactBasis',
  'jobRelations', 'activityMetrics', 'budgetUsage',
]);
export const PRIVATE_COLLECTIONS = new Set([
  'profiles', 'targets', 'profileCopies', 'jobs', 'observations', 'evaluations',
  'applications', 'runs', 'events', 'files', 'targetMembers', 'memberGroups',
  'runEvents', 'applicationEvents', 'runSnapshots', 'runCoverage', 'runIssues',
  'runEvaluationIds', 'activityUnits', 'reservations', 'activityUsage',
  'contentBodies', 'contentArticles', 'articleCache', 'contentLinks',
  'officialLinkCache', 'activityJobIds', 'conditionalCache', 'jobProjections',
  'sourceRotation', 'jobIdentityKeys', 'jobFactBasis', 'jobRelations',
  'activityMetrics', 'budgetUsage', 'identityAliasLinks', 'duplicateGroups', 'jobRedirects',
]);
export const QUERY_FIELDS = Object.freeze({
  id: 'id', ownerPackageId: 'owner_id', parentId: 'parent_id', path: 'part_path',
  jobId: 'job_id', runId: 'run_id', activityId: 'run_id',
  targetRevisionId: 'target_revision_id', profileRevisionId: 'profile_revision_id',
  observationId: 'observation_id', factContentHash: 'fact_hash',
  ruleVersion: 'rule_version', status: 'status', kind: 'kind',
  nextDueAt: 'next_due_at', resourceKey: 'resource_key', checkedAt: 'checked_at',
  sortAt: 'sort_at', title: 'title', company: 'company', jobType: 'job_type',
  score: 'score', recommendation: 'recommendation', openingStatus: 'opening_status',
  applicationStatus: 'application_status', sourceId: 'source_id', siteId: 'site_id',
  ordinal: 'ordinal', seq: 'event_seq', nameKey: 'name_key',
});
const literals = (values) => values.map(v => `'${v}'`).join(',');
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))
) STRICT;
CREATE TABLE IF NOT EXISTS rows (
  collection TEXT NOT NULL CHECK(collection IN (${literals(SQLITE_COLLECTIONS)})),
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 4096),
  owner_id TEXT REFERENCES package_keys(id) DEFERRABLE INITIALLY DEFERRED,
  record_id TEXT UNIQUE,
  parent_collection TEXT, parent_id TEXT, part_path TEXT,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
  value TEXT NOT NULL CHECK(json_valid(value)),
  job_id TEXT, run_id TEXT, target_revision_id TEXT, profile_revision_id TEXT,
  observation_id TEXT, fact_hash TEXT, rule_version TEXT, status TEXT, kind TEXT,
  next_due_at TEXT, resource_key TEXT, checked_at TEXT, sort_at TEXT,
  title TEXT, company TEXT, job_type TEXT, score REAL, recommendation TEXT,
  opening_status TEXT, application_status TEXT, source_id TEXT, site_id TEXT,
  event_seq INTEGER, name_key TEXT,
  PRIMARY KEY(collection,id), UNIQUE(collection,id,owner_id),
  FOREIGN KEY(parent_collection,parent_id) REFERENCES rows(collection,id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE IF NOT EXISTS package_keys (
  id TEXT PRIMARY KEY, collection TEXT NOT NULL DEFAULT 'packages' CHECK(collection='packages'),
  kind TEXT NOT NULL CHECK(kind IN ('profile','target','legacy_unassigned')),
  version_id TEXT NOT NULL, name_key TEXT NOT NULL, state TEXT NOT NULL,
  UNIQUE(kind,version_id),
  FOREIGN KEY(collection,id) REFERENCES rows(collection,id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS package_names ON package_keys(kind,name_key) WHERE state <> 'purged';
CREATE TABLE IF NOT EXISTS row_refs (
  collection TEXT NOT NULL, id TEXT NOT NULL, field TEXT NOT NULL,
  target_collection TEXT NOT NULL, target_id TEXT NOT NULL, owner_id TEXT,
  PRIMARY KEY(collection,id,field,target_collection,target_id),
  FOREIGN KEY(collection,id) REFERENCES rows(collection,id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(target_collection,target_id) REFERENCES rows(collection,id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(collection,id,owner_id) REFERENCES rows(collection,id,owner_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(target_collection,target_id,owner_id) REFERENCES rows(collection,id,owner_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE IF NOT EXISTS row_parts (
  collection TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL,
  child_collection TEXT NOT NULL, shape TEXT NOT NULL CHECK(shape IN ('map','array','value')),
  PRIMARY KEY(collection,id,path),
  FOREIGN KEY(collection,id) REFERENCES rows(collection,id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
  owner_id TEXT, topic TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('put','delete','meta','replace'))
) STRICT;
CREATE INDEX IF NOT EXISTS rows_owner ON rows(collection,owner_id,id);
CREATE INDEX IF NOT EXISTS rows_collection_heads ON rows(owner_id,target_revision_id,sort_at DESC,id) WHERE collection='runs' AND kind='collection_root';
CREATE INDEX IF NOT EXISTS rows_collection_heads_all ON rows(sort_at DESC,id) WHERE collection='runs' AND kind='collection_root';
CREATE INDEX IF NOT EXISTS rows_legacy_alias_routing ON rows(resource_key,owner_id,job_id) WHERE collection='jobIdentityKeys' AND kind='alias';
CREATE INDEX IF NOT EXISTS rows_parent ON rows(collection,parent_collection,parent_id,part_path,ordinal,id);
-- Foreign-key child lookups start with the referenced key, independently of a
-- business collection filter. These must be seekable during every row upsert.
CREATE INDEX IF NOT EXISTS rows_owner_fk ON rows(owner_id);
CREATE INDEX IF NOT EXISTS rows_parent_fk ON rows(parent_collection,parent_id);
CREATE INDEX IF NOT EXISTS row_refs_target_fk ON row_refs(target_collection,target_id,owner_id);
CREATE INDEX IF NOT EXISTS rows_part_owner ON rows(collection,owner_id,parent_id,part_path,ordinal,id);
CREATE INDEX IF NOT EXISTS rows_part_resource ON rows(collection,owner_id,parent_id,part_path,resource_key,id);
CREATE INDEX IF NOT EXISTS rows_job ON rows(collection,owner_id,job_id,sort_at,id);
CREATE INDEX IF NOT EXISTS rows_run ON rows(collection,owner_id,run_id,id);
CREATE INDEX IF NOT EXISTS rows_target ON rows(collection,owner_id,target_revision_id,job_id,id);
CREATE INDEX IF NOT EXISTS rows_identity_candidate ON rows(collection,owner_id,kind,resource_key,job_id);
CREATE INDEX IF NOT EXISTS rows_evaluation ON rows(collection,owner_id,job_id,target_revision_id,profile_revision_id,fact_hash,rule_version,id);
CREATE INDEX IF NOT EXISTS rows_due ON rows(collection,owner_id,status,next_due_at,id);
CREATE INDEX IF NOT EXISTS rows_status_sort ON rows(collection,owner_id,status,sort_at,id);
CREATE INDEX IF NOT EXISTS rows_cache ON rows(collection,owner_id,checked_at,id);
CREATE INDEX IF NOT EXISTS rows_source ON rows(collection,owner_id,source_id,site_id,id);
CREATE INDEX IF NOT EXISTS rows_events ON rows(collection,owner_id,run_id,event_seq,id);
CREATE INDEX IF NOT EXISTS rows_recommendation ON rows(collection,owner_id,recommendation,score,id);
CREATE INDEX IF NOT EXISTS changes_owner ON changes(owner_id,seq);
CREATE INDEX IF NOT EXISTS changes_job_owner ON changes(collection,owner_id,seq);
CREATE INDEX IF NOT EXISTS changes_job_id ON changes(collection,id,seq);
CREATE INDEX IF NOT EXISTS changes_job_collection ON changes(collection,seq);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_resource ON rows(owner_id,run_id,kind,resource_key)
  WHERE collection='reservations' AND kind IN ('detail_credit','attachment_credit') AND resource_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reservation_identity ON rows(run_id,json_extract(value,'$.reservationId'))
  WHERE collection='reservations';
CREATE UNIQUE INDEX IF NOT EXISTS run_event_sequence ON rows(parent_id,event_seq)
  WHERE collection='runEvents' AND event_seq IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS member_identity ON rows(owner_id,target_revision_id,job_id)
  WHERE collection='targetMembers';
CREATE UNIQUE INDEX IF NOT EXISTS version_metadata_names ON rows(kind,name_key)
  WHERE collection='versionMetadata';
CREATE UNIQUE INDEX IF NOT EXISTS profile_revision_number ON rows(json_extract(value,'$.profileId'),json_extract(value,'$.revision'))
  WHERE collection='profiles';
CREATE UNIQUE INDEX IF NOT EXISTS target_revision_number ON rows(json_extract(value,'$.targetId'),json_extract(value,'$.revision'))
  WHERE collection='targets';
CREATE UNIQUE INDEX IF NOT EXISTS single_value_part ON rows(collection,parent_collection,parent_id,part_path)
  WHERE collection IN ('runSnapshots','profileCopies');
CREATE TRIGGER IF NOT EXISTS private_owner_insert BEFORE INSERT ON rows
WHEN NEW.collection IN (${literals([...PRIVATE_COLLECTIONS])}) AND NEW.owner_id IS NULL
 AND (SELECT value FROM store_meta WHERE key='schemaVersion')='3'
BEGIN SELECT RAISE(ABORT,'private owner required'); END;
CREATE TRIGGER IF NOT EXISTS private_owner_update BEFORE UPDATE ON rows
WHEN NEW.collection IN (${literals([...PRIVATE_COLLECTIONS])}) AND NEW.owner_id IS NULL
 AND (SELECT value FROM store_meta WHERE key='schemaVersion')='3'
BEGIN SELECT RAISE(ABORT,'private owner required'); END;
CREATE TRIGGER IF NOT EXISTS submission_identity_update BEFORE UPDATE ON rows
WHEN OLD.collection='versionSubmissions'
 AND json_extract(OLD.value,'$.inputHash') IS NOT json_extract(NEW.value,'$.inputHash')
BEGIN SELECT RAISE(ABORT,'submission identity constraint'); END;
CREATE TRIGGER IF NOT EXISTS reservation_identity_update BEFORE UPDATE ON rows
WHEN OLD.collection='reservations' AND (
 json_extract(OLD.value,'$.reservationId') IS NOT json_extract(NEW.value,'$.reservationId') OR
 json_extract(OLD.value,'$.kind') IS NOT json_extract(NEW.value,'$.kind') OR
 json_extract(OLD.value,'$.requestUpperBound') IS NOT json_extract(NEW.value,'$.requestUpperBound') OR
 json_extract(OLD.value,'$.bytesUpperBound') IS NOT json_extract(NEW.value,'$.bytesUpperBound') OR
 json_extract(OLD.value,'$.costUpperBoundCny') IS NOT json_extract(NEW.value,'$.costUpperBoundCny') OR
 json_extract(OLD.value,'$.resourceKey') IS NOT json_extract(NEW.value,'$.resourceKey'))
BEGIN SELECT RAISE(ABORT,'reservation identity constraint'); END;
CREATE TRIGGER IF NOT EXISTS job_projection_generation_insert BEFORE INSERT ON rows
WHEN NEW.collection='jobProjections' AND json_extract(NEW.value,'$.version') <
  CAST((SELECT value FROM store_meta WHERE key='jobReadModelVersion') AS INTEGER)
BEGIN SELECT RAISE(ABORT,'job projection generation constraint'); END;
CREATE TRIGGER IF NOT EXISTS job_projection_generation_update BEFORE UPDATE ON rows
WHEN NEW.collection='jobProjections' AND json_extract(NEW.value,'$.version') <
  CAST((SELECT value FROM store_meta WHERE key='jobReadModelVersion') AS INTEGER)
BEGIN SELECT RAISE(ABORT,'job projection generation constraint'); END;
`;
