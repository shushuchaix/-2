import { JOB_READ_MODEL_VERSION } from '../../domain/job-read-model.mjs';

const invalid = () => Object.assign(Error('Invalid bounded job query.'), { code: 'sqlite_selection_invalid', status: 400 });
const instant = value => { const n = Number(new Date(value)); if (!Number.isFinite(n)) throw invalid(); return new Date(n).toISOString(); };
const useful = value => value !== undefined && value !== null && value !== '' && value !== 'all';
function pageOptions(filters) {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(filters.pageSize) || 50)));
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset > 100000) throw invalid();
  return { page, pageSize, offset };
}
function queryScope(filters, options) {
  const scope = options.scope || filters;
  if (filters.allTargets === true) {
    if (scope.packageId || scope.targetRevisionId || filters.packageId || filters.targetRevisionId) throw invalid();
    return { allTargets: true };
  }
  if (typeof scope.packageId !== 'string' || typeof scope.targetRevisionId !== 'string') throw invalid();
  return scope;
}

/** Internal fixed SQL only. The row store owns the snapshot, guards and connection. */
export function createSqliteJobQueries({ db, statement = sql => db.prepare(sql), countRows = () => {} }) {
  // Fixed domain dependencies. Ledger, run events and collection bookkeeping do
  // not invalidate a job page. A replace always invalidates every selected set.
  const jobCollections = ['jobs', 'observations', 'evaluations', 'applications', 'applicationEvents', 'targets', 'profileCopies', 'targetMembers', 'jobProjections', 'jobIdentityKeys', 'jobFactBasis', 'jobRelations', 'jobRedirects', 'duplicateGroups', 'identityAliasLinks'];
  function readJobHead({ ownerPackageId, allTargets } = {}) {
    if (allTargets === true ? ownerPackageId !== undefined : typeof ownerPackageId !== 'string' || !ownerPackageId || allTargets !== undefined) throw Object.assign(invalid(), { selectionKind: 'job_head', ownerType: typeof ownerPackageId, allTargetsType: typeof allTargets });
    const scoped = allTargets !== true;
    const branches = jobCollections.map(collection => `SELECT coalesce(max(seq),0) AS seq FROM changes WHERE collection='${collection}'${scoped ? ' AND owner_id=?' : ''}`);
    branches.push(`SELECT coalesce(max(seq),0) AS seq FROM changes WHERE collection='packages'${scoped ? ' AND id=?' : ''}`);
    branches.push("SELECT coalesce(max(seq),0) AS seq FROM changes WHERE collection='workspace'");
    const row = statement(`SELECT max(seq) AS head FROM (${branches.join(' UNION ALL ')})`).get(...(scoped ? Array(jobCollections.length + 1).fill(ownerPackageId) : []));
    countRows(1); return { head: row.head };
  }
  const periodFrom = `FROM rows p JOIN package_keys k ON k.id=p.owner_id
    JOIN json_each(p.value,'$.temporalPeriods') period
      ON json_extract(period.value,'$.from')<=? AND (json_extract(period.value,'$.until') IS NULL OR json_extract(period.value,'$.until')>?)
    LEFT JOIN rows duplicate_group ON duplicate_group.collection='jobRelations' AND duplicate_group.owner_id=p.owner_id
      AND duplicate_group.id=json_array('confirmed-group',json_extract(p.value,'$.confirmedDuplicateGroupId'))`;
  const duplicateStatus = `CASE WHEN json_extract(p.value,'$.duplicateStatus')='protected' OR duplicate_group.status='protected' THEN 'protected'
    WHEN json_extract(p.value,'$.duplicateStatus')='possible' OR duplicate_group.status='possible' THEN 'possible' ELSE 'normal' END`;
  function base(filters, options, applicationPage = false) {
    const scope = queryScope(filters, options), asOf = instant(options.asOf ?? Date.now());
    const clauses = ["p.collection='jobProjections'", 'json_extract(p.value,\'$.version\')=?', "k.kind='target'", "k.state='active'"], bindings = [asOf, asOf, JOB_READ_MODEL_VERSION];
    if (options.excludedOwnerPackageIds !== undefined) {
      if (!Array.isArray(options.excludedOwnerPackageIds) || options.excludedOwnerPackageIds.length > 100000 || options.excludedOwnerPackageIds.some(owner => typeof owner !== 'string')) throw invalid();
      clauses.push('NOT EXISTS(SELECT 1 FROM json_each(?) excluded WHERE excluded.value=p.owner_id)'); bindings.push(JSON.stringify(options.excludedOwnerPackageIds));
    }
    if (!scope.allTargets) { clauses.push('p.owner_id=?', 'p.target_revision_id=?'); bindings.push(scope.packageId, scope.targetRevisionId); }
    const filter = (sql, value) => { if (useful(value)) { clauses.push(sql); bindings.push(value); } };
    filter('p.kind=?', filters.kind);
    filter('p.job_type=?', filters.jobType);
    filter("json_extract(p.value,'$.lifecycle')=?", filters.lifecycle);
    filter(`(${duplicateStatus})=?`, filters.duplicateStatus);
    filter("json_extract(period.value,'$.openingStatus')=?", filters.openingStatus);
    filter("json_extract(p.value,'$.applicationTrackingStatus')=?", filters.applicationStatus || filters.status);
    if (useful(filters.sourceId)) { clauses.push("EXISTS(SELECT 1 FROM json_each(p.value,'$.sourceIds') s WHERE s.value=?)"); bindings.push(filters.sourceId); }
    if (filters.cities?.length) {
      if (!Array.isArray(filters.cities) || filters.cities.length > 100 || filters.cities.some(c => typeof c !== 'string')) throw invalid();
      clauses.push("EXISTS(SELECT 1 FROM json_each(p.value,'$.cities') c JOIN json_each(?) q ON q.value=c.value)"); bindings.push(JSON.stringify(filters.cities));
    }
    if (filters.since) { clauses.push('p.sort_at>=?'); bindings.push(instant(filters.since)); }
    if (filters.search) {
      if (typeof filters.search !== 'string' || filters.search.length > 2000) throw invalid();
      clauses.push("instr(json_extract(p.value,'$.searchText'),?)>0"); bindings.push(filters.search.toLowerCase());
    }
    if (useful(filters.qualification)) {
      clauses.push("json_extract(period.value,'$.qualification')=?"); bindings.push(filters.qualification);
    }
    if (useful(filters.recommendation)) {
      clauses.push("json_extract(period.value,'$.recommendation')=?"); bindings.push(filters.recommendation);
    }
    if (applicationPage) clauses.push("json_extract(p.value,'$.applicationId') IS NOT NULL");
    return { where: clauses.join(' AND '), bindings, asOf, scope };
  }
  function queryPage(filters = {}, options = {}, applicationPage = false) {
    const { page, pageSize, offset } = pageOptions(filters), q = base(filters, options, applicationPage);
    // Count and order one narrow eligibility set; read rich projection fields
    // only after LIMIT. The totals row also survives an empty/out-of-range page.
    const selected = statement(`WITH eligible AS MATERIALIZED (
      SELECT p.id AS job_id,p.owner_id,period.value AS period_value,
        coalesce(json_extract(period.value,'$.score'),0) AS score,p.sort_at,${duplicateStatus} AS duplicate_status
      ${periodFrom} WHERE ${q.where}
    ), page AS MATERIALIZED (
      SELECT * FROM eligible ORDER BY score DESC,sort_at DESC,job_id ASC LIMIT ? OFFSET ?
    ), totals AS (SELECT count(*) AS total FROM eligible)
      SELECT totals.total,page.job_id AS jobId,page.owner_id AS ownerPackageId,p.target_revision_id AS targetRevisionId,
      json_extract(p.value,'$.applicationId') AS applicationId, json_extract(p.value,'$.currentObservationId') AS currentObservationId,
      json_extract(p.value,'$.evaluationId') AS evaluationId,
      json_extract(page.period_value,'$.temporalStatus') AS temporalStatus, json_extract(page.period_value,'$.until') AS nextTemporalChangeAt,page.duplicate_status AS duplicateStatus
      FROM totals LEFT JOIN page ON 1=1
      LEFT JOIN rows p ON p.collection='jobProjections' AND p.id=page.job_id AND p.owner_id=page.owner_id
      ORDER BY page.score DESC,page.sort_at DESC,page.job_id ASC`)
      .all(...q.bindings, pageSize, offset);
    const total = selected[0].total;
    const rows = selected.filter(row => row.jobId !== null).map(({ total, ...row }) => row);
    const revision = JSON.parse(statement("SELECT value FROM store_meta WHERE key='revision'").get().value);
    const jobHead = readJobHead(q.scope.allTargets ? { allTargets: true } : { ownerPackageId: q.scope.packageId }).head;
    countRows(selected.length + 1);
    return { items: rows.map(row => ({ ...row })), total, page, pageSize, asOf: q.asOf, revision, jobHead, readOnly: q.scope.allTargets === true };
  }
  function findJobIdentityCandidates({ ownerPackageId, keys, recordIdentity, afterJobId = '', limit = 200 } = {}) {
    if (typeof ownerPackageId !== 'string' || !Array.isArray(keys) || keys.length > 4096 || !Number.isInteger(limit) || limit < 1 || limit > 200 || typeof afterJobId !== 'string' || keys.some(k => typeof k.kind !== 'string' || typeof k.resourceKey !== 'string')) throw invalid();
    if (recordIdentity && (typeof recordIdentity.company !== 'string' || typeof recordIdentity.title !== 'string' || !Array.isArray(recordIdentity.titleGrams) || recordIdentity.titleGrams.length > 20000 || recordIdentity.titleGrams.some(gram => typeof gram !== 'string') || recordIdentity.titleGrams.length !== recordIdentity.titleGramCount)) throw invalid();
    const rows = statement(`WITH matched AS MATERIALIZED (
      SELECT DISTINCT i.job_id AS jobId FROM json_each(?) q
      CROSS JOIN rows i INDEXED BY rows_identity_candidate
      WHERE i.collection='jobIdentityKeys' AND i.owner_id=? AND i.job_id>?
      AND json_extract(q.value,'$.kind')=i.kind AND json_extract(q.value,'$.resourceKey')=i.resource_key
      )
      SELECT matched.jobId FROM matched CROSS JOIN rows p INDEXED BY rows_owner
      WHERE p.collection='jobProjections' AND p.owner_id=? AND p.id=matched.jobId
      AND (? IS NULL OR ?='' OR json_extract(p.value,'$.identityCompany')='' OR json_extract(p.value,'$.identityCompany')=?)
      AND (? IS NULL OR ?='' OR json_extract(p.value,'$.identityTitle')='' OR json_extract(p.value,'$.identityTitle')=?
        OR (?<>'' AND json_extract(p.value,'$.identityCompany')=?
          AND (SELECT count(*) FROM json_each(p.value,'$.identityTitleGrams') full_gram
            WHERE full_gram.value IN (SELECT value FROM json_each(?)))*182>=82*(?+json_extract(p.value,'$.identityTitleGramCount'))))
      ORDER BY matched.jobId LIMIT ?`)
      .all(JSON.stringify(keys), ownerPackageId, afterJobId, ownerPackageId,
        recordIdentity?.company ?? null, recordIdentity?.company ?? '', recordIdentity?.company ?? '',
        recordIdentity?.title ?? null, recordIdentity?.title ?? '', recordIdentity?.title ?? '',
        recordIdentity?.company ?? '', recordIdentity?.company ?? '', JSON.stringify(recordIdentity?.titleGrams || []), recordIdentity?.titleGramCount ?? 0, limit + 1);
    const hasMore = rows.length > limit; if (hasMore) rows.pop(); countRows(rows.length);
    return { jobIds: rows.map(row => row.jobId), hasMore, nextCursor: hasMore ? rows.at(-1)?.jobId || null : null };
  }
  function readJobBodySignatures({ ownerPackageId, contentHashes } = {}) {
    if (typeof ownerPackageId !== 'string' || !Array.isArray(contentHashes) || contentHashes.length > 1000 || contentHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw invalid();
    const rows = statement(`SELECT q.value AS contentHash,
      (SELECT json_extract(i.value,'$.bodySignature.simHash') FROM rows i INDEXED BY rows_identity_candidate
       WHERE i.collection='jobIdentityKeys' AND i.owner_id=? AND i.kind='content_hash' AND i.resource_key=q.value LIMIT 1) AS simHash
      FROM json_each(?) q`).all(ownerPackageId, JSON.stringify([...new Set(contentHashes)]));
    countRows(rows.length);
    return { signatures: rows.filter(row => /^[a-f0-9]{16}$/.test(row.simHash || '')).map(row => ({ ...row })) };
  }
  function queryJobRelatedPage({ ownerPackageId, jobId, afterJobId = '', limit = 50 } = {}) {
    if (typeof ownerPackageId !== 'string' || typeof jobId !== 'string' || !jobId || jobId.length > 4096 || typeof afterJobId !== 'string' || afterJobId.length > 4096 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
    const cte = `WITH selected AS MATERIALIZED (
      SELECT p.id AS jobId,p.value AS projection,j.value AS job FROM rows p INDEXED BY rows_owner
      CROSS JOIN rows j INDEXED BY rows_owner
      WHERE p.collection='jobProjections' AND p.owner_id=? AND p.id=? AND j.collection='jobs' AND j.owner_id=p.owner_id AND j.id=p.id),
      related AS (
        SELECT m.job_id AS jobId FROM selected s CROSS JOIN rows m INDEXED BY rows_identity_candidate
          WHERE m.collection='jobRelations' AND m.owner_id=? AND m.kind='confirmed_group_member' AND m.resource_key=json_extract(s.projection,'$.confirmedDuplicateGroupId')
        UNION SELECT json_extract(r.value,'$.otherJobId') AS jobId FROM selected s CROSS JOIN rows r INDEXED BY rows_job
          WHERE r.collection='jobRelations' AND r.owner_id=? AND r.job_id=s.jobId AND r.kind IS NULL
        UNION SELECT ids.value AS jobId FROM selected s CROSS JOIN json_each(s.job,'$.duplicateGroupIds') refs
          CROSS JOIN rows g INDEXED BY rows_owner CROSS JOIN json_each(g.value,'$.jobIds') ids
          WHERE g.collection='duplicateGroups' AND g.owner_id=? AND g.id=refs.value)
      `;
    const where = `FROM related r WHERE r.jobId<>? AND EXISTS(SELECT 1 FROM rows j INDEXED BY rows_owner WHERE j.collection='jobs' AND j.owner_id=? AND j.id=r.jobId)`;
    const bindings = [ownerPackageId, jobId, ownerPackageId, ownerPackageId, ownerPackageId, jobId, ownerPackageId];
    const total = statement(cte + `SELECT count(*) AS n ${where}`).get(...bindings).n;
    const rows = statement(cte + `SELECT r.jobId ${where} AND r.jobId>? ORDER BY r.jobId LIMIT ?`).all(...bindings, afterJobId, limit + 1);
    const hasMore = rows.length > limit; if (hasMore) rows.pop(); countRows(rows.length + 1);
    return { jobIds: rows.map(row => row.jobId), total, hasMore, nextCursor: hasMore ? rows.at(-1).jobId : null };
  }
  function queryJobQuality({ ownerPackageId, runId, activityId, asOf = Date.now() } = {}) {
    if (typeof ownerPackageId !== 'string' || (runId !== undefined && typeof runId !== 'string') || (activityId !== undefined && typeof activityId !== 'string') || (runId && activityId)) throw invalid();
    // Start activity quality at its distinct members so empty roots never scan
    // their owner's projections. Keep the shared temporal and quality semantics.
    const members = activityId ? `members AS MATERIALIZED (
      SELECT DISTINCT a.job_id FROM rows a INDEXED BY rows_run
      WHERE a.collection='activityJobIds' AND a.owner_id=? AND a.run_id=?), ` : '';
    const qualityFrom = activityId ? periodFrom.replace('FROM rows p', 'FROM members member CROSS JOIN rows p') : periodFrom;
    const at = instant(asOf), result = statement(`WITH ${members}selected AS MATERIALIZED (
      SELECT p.id AS job_id,p.owner_id,json_extract(p.value,'$.bodyVerified') AS body_verified,
       json_extract(period.value,'$.qualification') AS qualification,json_extract(period.value,'$.recommended') AS recommended,
       json_extract(period.value,'$.openingStatus') AS opening_status,json_extract(period.value,'$.applicationStatus') AS application_status,
       json_extract(period.value,'$.temporalStatus') AS temporal_status,json_extract(period.value,'$.until') AS next_temporal_change_at
      ${qualityFrom} WHERE p.collection='jobProjections' AND p.owner_id=? AND k.state='active' AND p.fact_hash IS NOT NULL
      AND (? IS NULL OR p.job_id IN (SELECT o.job_id FROM rows o WHERE o.collection='observations' AND o.owner_id=? AND o.run_id=?))
      ${activityId ? 'AND p.job_id=member.job_id' : "AND (? IS NULL OR p.job_id IN (SELECT json_extract(a.value,'$') FROM rows a WHERE a.collection='activityJobIds' AND a.owner_id=? AND a.run_id=?))"})
      SELECT count(*) AS uniqueRecords,
       coalesce(sum(body_verified=1),0) AS bodyVerified,coalesce(sum(opening_status='open'),0) AS open,
       coalesce(sum(application_status='available'),0) AS applicationAvailable,
       coalesce(sum(qualification='pass'),0) AS qualificationPass,coalesce(sum(qualification='fail'),0) AS qualificationFail,
       coalesce(sum(qualification='unknown'),0) AS qualificationUnknown,
       coalesce(sum(opening_status IN ('historical','closed','expired')),0) AS historicalOrExpired,
       coalesce(sum(recommended=1 AND temporal_status='current'),0) AS validNewUnique,
       coalesce(sum(temporal_status='needs_recalculation'),0) AS temporalPendingCount,
       min(next_temporal_change_at) AS nextTemporalChangeAt,
       coalesce(sum(EXISTS(SELECT 1 FROM rows r JOIN selected other ON other.job_id=json_extract(r.value,'$.otherJobId')
         WHERE r.collection='jobRelations' AND r.owner_id=s.owner_id AND r.job_id=s.job_id AND json_extract(r.value,'$.relation')='possible')),0) AS suspectedDuplicates
      FROM selected s`).get(...(activityId ? [ownerPackageId, activityId] : []), at, at, ownerPackageId, runId || null, ownerPackageId, runId || null, ...(activityId ? [] : [activityId || null, ownerPackageId, activityId || null]));
    countRows(1); return { ...result, total: result.uniqueRecords, verifiedRecommendationCount: result.validNewUnique, openCount: result.open, asOf: at };
  }
  return Object.freeze({ queryJobPage: (filters, options) => queryPage(filters, options), queryApplicationPage: (filters, options) => queryPage(filters, options, true), findJobIdentityCandidates, readJobBodySignatures, queryJobQuality, readJobHead, queryJobRelatedPage });
}
