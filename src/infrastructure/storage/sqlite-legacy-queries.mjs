// Fixed compatibility queries. Only the storage assembler receives the connection.
const invalid = () => Object.assign(Error('Invalid legacy row query.'), { code: 'sqlite_selection_invalid', status: 400 });
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const pageOf = input => {
  const page = Number(input.page || 1), pageSize = Number(input.pageSize || 50), offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200 || !Number.isSafeInteger(offset) || offset > 100000) throw invalid();
  return { page, pageSize, offset };
};
const excluded = options => JSON.stringify(options.excludedOwnerPackageIds || []);

export function createSqliteLegacyQueries({ db, statement = sql => db.prepare(sql), countRows = () => {} }) {
  const applicationSeedLookup = `WITH RECURSIVE identities(id) AS (
    SELECT value FROM json_each(?)
    UNION SELECT d.id FROM identities i CROSS JOIN rows d INDEXED BY rows_identity_candidate
      WHERE d.collection='jobRedirects' AND d.owner_id=? AND d.kind='job_redirect' AND d.resource_key=i.id
    UNION SELECT k.resource_key FROM identities i CROSS JOIN rows k INDEXED BY rows_job
        WHERE k.collection='jobIdentityKeys' AND k.owner_id=? AND k.job_id=i.id AND k.kind='alias'
    UNION SELECT l.parent_id FROM identities i CROSS JOIN rows l INDEXED BY rows_job
        WHERE l.collection='identityAliasLinks' AND l.owner_id=? AND l.job_id=i.id AND l.parent_collection='aliasGroups' AND l.part_path='identityAliases'
    ), seeds(seed) AS (
      SELECT id FROM identities
      UNION SELECT value FROM json_each(?)
    ) SELECT DISTINCT s.parent_id AS applicationId FROM seeds k CROSS JOIN rows s INDEXED BY rows_identity_candidate
      WHERE s.collection='jobRelations' AND s.owner_id=? AND s.kind='legacy_application_seed' AND s.resource_key=k.seed`;
  const seedBindings = (owner, jobIds, seeds = []) => [JSON.stringify(jobIds), owner, owner, owner, JSON.stringify(seeds), owner];
  function findLegacyApplicationIds(input = {}, options = {}) {
    const owner=options.scope?.packageId||input.ownerPackageId,jobIds=input.jobIds||[],seeds=input.seeds||[],limit=input.limit||200,afterId=input.afterId||'';
    if(!text(owner)||!Array.isArray(jobIds)||jobIds.length>1000||jobIds.some(id=>!text(id))||!Array.isArray(seeds)||seeds.length>4096||seeds.some(id=>!text(id))||!Number.isSafeInteger(limit)||limit<1||limit>200||typeof afterId!=='string')throw invalid();
    const rows=statement(`SELECT applicationId FROM (${applicationSeedLookup}) WHERE applicationId>? ORDER BY applicationId LIMIT ?`).all(...seedBindings(owner,jobIds,seeds),afterId,limit+1);
    const hasMore=rows.length>limit;if(hasMore)rows.pop();countRows(rows.length);
    return {applicationIds:rows.map(row=>row.applicationId),hasMore,nextCursor:hasMore?rows.at(-1).applicationId:null};
  }
  function discoverLegacyOwners({ kind = 'default', id } = {}, options = {}) {
    if (!['default', 'target', 'revision', 'run', 'application', 'job'].includes(kind) || (kind !== 'default' && !text(id))) throw invalid();
    let from, bindings = [], active = ['default', 'target'].includes(kind);
    if (kind === 'default') from = 'SELECT id AS ownerPackageId FROM package_keys';
    else if (kind === 'revision') { from = 'SELECT id AS ownerPackageId FROM package_keys WHERE version_id=?'; bindings = [id]; }
    else if (kind === 'target') { from = "SELECT owner_id AS ownerPackageId FROM rows WHERE collection='targets' AND parent_collection='targetGroups' AND parent_id=?"; bindings = [id]; }
    else if (kind === 'job') {
      const direct=statement("SELECT owner_id FROM rows WHERE collection IN ('jobs','jobRedirects') AND id=? ORDER BY collection DESC LIMIT 1").get(id);
      countRows(direct?1:0);
      if(direct){from='SELECT ? AS ownerPackageId';bindings=[direct.owner_id];active=false;}
      else {
      from = `SELECT owner_id AS ownerPackageId FROM rows WHERE collection='identityAliasLinks' AND parent_collection='aliasGroups' AND parent_id=? AND part_path='identityAliases'
        UNION SELECT owner_id FROM rows WHERE collection='jobIdentityKeys' AND kind='alias' AND resource_key=?`;
      bindings = [id, id]; active = true;
      }
    } else { from = `SELECT owner_id AS ownerPackageId FROM rows WHERE collection='${kind === 'run' ? 'runs' : 'applications'}' AND id=?`; bindings = [id]; }
    const rows = statement(`WITH candidates AS (${from}) SELECT k.id AS ownerPackageId,k.version_id AS targetRevisionId,k.state
      FROM candidates c JOIN package_keys k ON k.id=c.ownerPackageId WHERE k.kind='target' ${active ? "AND k.state='active'" : ''}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) deleted WHERE deleted.value=k.id) GROUP BY k.id ORDER BY k.id LIMIT 2`).all(...bindings, excluded(options));
    countRows(rows.length); return { owners: rows.map(row => ({ ...row })) };
  }

  // UNION deduplicates the reachable identity set, including duplicate alias
  // channels. Cycles terminate without a terminal job and remain missing.
  const associations = selected => `WITH RECURSIVE overlay AS MATERIALIZED (
      SELECT ? AS owner,json_extract(q.value,'$.jobId') AS jobId,json_extract(q.value,'$.aliases') AS aliases FROM json_each(?) q
    ), selected AS MATERIALIZED (${selected}), seeds AS (
      SELECT a.id AS applicationId,a.owner_id AS owner,json_each.value AS id FROM selected a
      CROSS JOIN json_each(CASE WHEN json_array_length(a.value,'$.legacyJobIds')>0 THEN json_extract(a.value,'$.legacyJobIds') ELSE json_array(a.job_id) END)
    ), walk(applicationId,owner,id) AS (
      SELECT applicationId,owner,id FROM seeds
      UNION
      SELECT w.applicationId,w.owner,json_extract(d.value,'$.toJobId')
      FROM walk w CROSS JOIN rows d INDEXED BY rows_owner WHERE d.collection='jobRedirects' AND d.owner_id=w.owner AND d.id=w.id
      UNION
      SELECT w.applicationId,w.owner,l.job_id
      FROM walk w CROSS JOIN rows l INDEXED BY rows_part_owner WHERE l.collection='identityAliasLinks' AND l.owner_id=w.owner AND l.parent_collection='aliasGroups' AND l.parent_id=w.id AND l.part_path='identityAliases'
        AND NOT EXISTS(SELECT 1 FROM rows d WHERE d.collection='jobRedirects' AND d.owner_id=w.owner AND d.id=w.id)
        AND NOT EXISTS(SELECT 1 FROM rows j WHERE j.collection='jobs' AND j.owner_id=w.owner AND j.id=w.id)
        AND NOT EXISTS(SELECT 1 FROM overlay o WHERE o.owner=w.owner AND o.jobId=w.id)
      UNION
      SELECT w.applicationId,w.owner,l.job_id
      FROM walk w CROSS JOIN rows l INDEXED BY rows_identity_candidate WHERE l.collection='jobIdentityKeys' AND l.owner_id=w.owner AND l.kind='alias' AND l.resource_key=w.id
        AND NOT EXISTS(SELECT 1 FROM rows d WHERE d.collection='jobRedirects' AND d.owner_id=w.owner AND d.id=w.id)
        AND NOT EXISTS(SELECT 1 FROM rows j WHERE j.collection='jobs' AND j.owner_id=w.owner AND j.id=w.id)
        AND NOT EXISTS(SELECT 1 FROM overlay o WHERE o.owner=w.owner AND o.jobId=w.id)
      UNION
      SELECT w.applicationId,w.owner,o.jobId FROM walk w CROSS JOIN overlay o CROSS JOIN json_each(o.aliases) alias
        WHERE o.owner=w.owner AND alias.value=w.id
        AND NOT EXISTS(SELECT 1 FROM rows d WHERE d.collection='jobRedirects' AND d.owner_id=w.owner AND d.id=w.id)
        AND NOT EXISTS(SELECT 1 FROM rows j WHERE j.collection='jobs' AND j.owner_id=w.owner AND j.id=w.id)
        AND NOT EXISTS(SELECT 1 FROM overlay direct WHERE direct.owner=w.owner AND direct.jobId=w.id)
    ), resolved AS (
      SELECT DISTINCT w.applicationId,w.owner,w.id FROM walk w CROSS JOIN rows j INDEXED BY rows_owner WHERE j.collection='jobs' AND j.owner_id=w.owner AND j.id=w.id
        AND NOT EXISTS(SELECT 1 FROM rows d WHERE d.collection='jobRedirects' AND d.owner_id=w.owner AND d.id=w.id)
      UNION SELECT w.applicationId,w.owner,w.id FROM walk w CROSS JOIN overlay o WHERE o.owner=w.owner AND o.jobId=w.id
        AND NOT EXISTS(SELECT 1 FROM rows d WHERE d.collection='jobRedirects' AND d.owner_id=w.owner AND d.id=w.id)
    ), associated AS (
      SELECT s.id AS applicationId,s.owner_id AS ownerPackageId,s.version_id AS targetRevisionId,s.job_id AS originalApplicationId,
        (SELECT count(*) FROM resolved r WHERE r.applicationId=s.id AND r.owner=s.owner_id) AS candidateCount,
        coalesce((SELECT json_group_array(id) FROM (SELECT id FROM resolved r WHERE r.applicationId=s.id AND r.owner=s.owner_id ORDER BY id)),'[]') AS jobIds
      FROM selected s
    ) `;
  function queryLegacyApplicationPage(input = {}, options = {}) {
    const scope = options.scope || (input.allTargets ? null : input.scope || input);
    if (!input.allTargets && (!text(scope?.packageId) || !text(scope?.targetRevisionId))) throw invalid();
    if (input.allTargets && (input.packageId || input.targetRevisionId || options.scope)) throw invalid();
    if (input.applicationIds !== undefined && (!Array.isArray(input.applicationIds) || input.applicationIds.length > 200 || input.applicationIds.some(id => !text(id)))) throw invalid();
    const { page, pageSize, offset } = pageOf(input), ids = input.applicationIds ? JSON.stringify(input.applicationIds) : null;
    const status = input.applicationStatus || input.status, search = String(input.search || '').toLowerCase();
    const overlay=options.identityOverlay||[];
    if(!Array.isArray(overlay)||overlay.length>5000||overlay.some(item=>!text(item.jobId)||!Array.isArray(item.aliases)||item.aliases.length>4096||item.aliases.some(alias=>!text(alias)))||(overlay.length&&!scope))throw invalid();
    const predicates=["a.collection='applications'","k.kind='target'","k.state='active'"],bindings=[scope?.packageId||null,JSON.stringify(overlay)];
    if(scope){predicates.push('a.owner_id=?','k.version_id=?');bindings.push(scope.packageId,scope.targetRevisionId);}
    if(ids!==null){predicates.push('a.id IN (SELECT value FROM json_each(?))');bindings.push(ids);}
    if(input.jobId){if(!scope||!text(input.jobId))throw invalid();predicates.push(`a.id IN (${applicationSeedLookup})`);bindings.push(...seedBindings(scope.packageId,[input.jobId]));}
    if(status&&status!=='all'){predicates.push('a.status=?');bindings.push(status);}
    if(search){predicates.push("instr(lower(coalesce(a.job_id,'')||' '||coalesce(json_extract(a.value,'$.note'),'')),?)>0");bindings.push(search);}
    predicates.push('NOT EXISTS(SELECT 1 FROM json_each(?) deleted WHERE deleted.value=a.owner_id)');bindings.push(excluded(options));
    const selected=`SELECT a.id,a.owner_id,a.job_id,a.value,k.version_id FROM rows a JOIN package_keys k ON k.id=a.owner_id WHERE ${predicates.join(' AND ')}`;
    const query=associations(selected);
    const where = `WHERE ${input.includeResolved ? '1' : 'candidateCount<>1'} ${input.jobId ? 'AND EXISTS(SELECT 1 FROM json_each(a.jobIds) j WHERE j.value=?)' : ''}`;
    if (input.jobId) { if (!text(input.jobId)) throw invalid(); bindings.push(input.jobId); }
    const total = statement(query + `SELECT count(*) AS n FROM associated a ${where}`).get(...bindings).n;
    const rows = statement(query + `SELECT * FROM associated a ${where} ORDER BY a.applicationId LIMIT ? OFFSET ?`).all(...bindings, pageSize, offset);
    countRows(rows.length + 1);
    return { items: rows.map(row => ({ applicationId: row.applicationId, ownerPackageId: row.ownerPackageId, targetRevisionId: row.targetRevisionId,
      association: { status: row.candidateCount === 1 ? 'single' : row.candidateCount ? 'ambiguous' : 'missing', jobIds: JSON.parse(row.jobIds), originalApplicationId: row.originalApplicationId } })),
      total, page, pageSize, hasMore: offset + rows.length < total, readOnly: input.allTargets === true };
  }

  function queryLegacyTrackingSummary(input = {}, options = {}) {
    const owner = options.scope?.packageId || input.ownerPackageId;
    if (!text(owner)) throw invalid();
    const rows = statement(`SELECT coalesce(json_extract(p.value,'$.applicationTrackingStatus'),'new') AS status,count(*) AS n,
      coalesce(sum(json_extract(p.value,'$.lifecycle')='notRecentlySeen'),0) AS lifecycleStale,
      coalesce(sum(coalesce(json_extract(p.value,'$.applicationTrackingStatus'),'new') IN ('new','seen') AND
        (SELECT count(DISTINCT o.run_id) FROM rows o INDEXED BY rows_job WHERE o.collection='observations' AND o.owner_id=p.owner_id AND o.job_id=p.job_id)>=5),0) AS seenStale,
      max(p.sort_at) AS updatedAt FROM rows p WHERE p.collection='jobProjections' AND p.owner_id=? GROUP BY 1`).all(owner);
    const runs = statement("SELECT count(*) AS n FROM rows WHERE collection='runs' AND owner_id=? AND coalesce(kind,'')<>'collection_root'").get(owner).n;
    countRows(rows.length + 1); return { statuses: rows.map(row => ({ ...row })), runs };
  }
  function queryLegacyTrackingPage(input = {}, options = {}) {
    const owner = options.scope?.packageId || input.ownerPackageId;
    if (!text(owner)) throw invalid();
    const { page, pageSize, offset } = pageOf(input), status = input.status || null;
    if (input.jobIds && (!Array.isArray(input.jobIds) || input.jobIds.length > 200 || input.jobIds.some(id => !text(id)))) throw invalid();
    const ids = input.jobIds ? JSON.stringify(input.jobIds) : null, bindings = ids===null?[owner]:[ids,owner];
    const predicates=["j.collection='jobs'",'j.owner_id=?'];
    if(ids!==null)predicates.push('j.id=requested.value');
    if(status){predicates.push("coalesce(json_extract(p.value,'$.applicationTrackingStatus'),'new')=?");bindings.push(status);}
    const source=ids===null?'rows j':'json_each(?) requested CROSS JOIN rows j INDEXED BY rows_owner';
    const from = `FROM ${source} LEFT JOIN rows p ON p.collection='jobProjections' AND p.owner_id=j.owner_id AND p.id=j.id WHERE ${predicates.join(' AND ')}`;
    const total = statement(`SELECT count(*) AS n ${from}`).get(...bindings).n;
    const rows = statement(`SELECT j.id AS jobId,json_extract(p.value,'$.applicationId') AS applicationId,json_extract(p.value,'$.evaluationId') AS evaluationId,
      (SELECT count(DISTINCT o.run_id) FROM rows o INDEXED BY rows_job WHERE o.collection='observations' AND o.owner_id=j.owner_id AND o.job_id=j.id) AS seenCount,
      (SELECT json_group_array(json_object('at',sort_at,'score',score)) FROM
        (SELECT e.sort_at,e.score FROM rows e INDEXED BY rows_job WHERE e.collection='evaluations' AND e.owner_id=j.owner_id AND e.job_id=j.id ORDER BY e.sort_at DESC,e.id)) AS scoreHistory
      ${from} ORDER BY j.sort_at DESC,j.id ASC LIMIT ? OFFSET ?`).all(...bindings, pageSize, offset);
    countRows(rows.length + 1); return { items: rows.map(row => ({ ...row, scoreHistory: JSON.parse(row.scoreHistory) })), total, page, pageSize };
  }
  function queryLegacyRunTargets(input = {}, options = {}) {
    const owner=options.scope?.packageId||input.ownerPackageId;
    if(!text(owner)||!Array.isArray(input.runIds)||input.runIds.length>200||input.runIds.some(id=>!text(id)))throw invalid();
    const rows=statement(`SELECT r.id AS runId,json_extract(s.value,'$.revisionId') AS targetRevisionId,
      json_extract(s.value,'$.roles') AS roles,json_extract(s.value,'$.cities') AS cities FROM json_each(?) requested
      JOIN rows r ON r.collection='runs' AND r.owner_id=? AND r.id=requested.value
      JOIN rows s ON s.collection='runSnapshots' AND s.owner_id=r.owner_id AND s.parent_collection='runs' AND s.parent_id=r.id AND s.part_path='targetSnapshot'`)
      .all(JSON.stringify(input.runIds),owner);
    countRows(rows.length);return {items:rows.map(row=>({...row,roles:JSON.parse(row.roles||'[]'),cities:JSON.parse(row.cities||'[]')}))};
  }
  function queryDiagnosticRunScopes(input = {}, options = {}) {
    const scope=options.scope;
    if(!Array.isArray(input.runIds)||input.runIds.length>200||input.runIds.some(id=>!text(id)))throw invalid();
    if(scope&&(!text(scope.packageId)||!text(scope.targetRevisionId)))throw invalid();
    const rows=statement(`SELECT r.id AS runId,r.owner_id AS ownerPackageId,k.version_id AS targetRevisionId
      FROM json_each(?) requested CROSS JOIN rows r
      JOIN package_keys k ON k.id=r.owner_id
      WHERE r.collection='runs' AND r.id=requested.value AND k.kind='target' AND k.state='active'
      AND r.target_revision_id=k.version_id ${scope?'AND r.owner_id=? AND k.version_id=?':''}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) excluded WHERE excluded.value=r.owner_id)
      ORDER BY r.id`).all(JSON.stringify(input.runIds),...(scope?[scope.packageId,scope.targetRevisionId]:[]),excluded(options));
    countRows(rows.length);return {items:rows.map(row=>({...row}))};
  }
  return Object.freeze({ discoverLegacyOwners, queryLegacyApplicationPage, queryLegacyTrackingSummary, queryLegacyTrackingPage, queryLegacyRunTargets, findLegacyApplicationIds, queryDiagnosticRunScopes });
}
