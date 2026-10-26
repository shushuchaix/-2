import { UUID_RE, PACKAGE_KINDS, PACKAGE_STATES } from '../../domain/packages.mjs';
import { rowStoreError } from './sqlite-records.mjs';

// This port is attached only to a live repository fence. SQL/JSON paths and
// collections are fixed here; it never returns a business value or arbitrary DTO.
export const PURGE_ENTITY_COLLECTIONS = Object.freeze(['profiles', 'targets', 'profileCopies',
  'jobs', 'observations', 'evaluations', 'runs', 'applications', 'events', 'files',
  'runEvents', 'applicationEvents', 'recoveryRecords']);
const PACKAGE_FIELDS = ['packageId', 'kind', 'versionId', 'versionName', 'nameKey',
  'enabled', 'state', 'archiveId', 'archivedAt', 'purgeAt'];
const bad = () => rowStoreError('sqlite_purge_metadata_invalid', 'Purge metadata identity or reference is invalid.');
const invalid = () => rowStoreError('sqlite_selection_invalid', 'Invalid fixed purge metadata selector.');
const literal = value => "'" + value + "'";
const collectionList = PURGE_ENTITY_COLLECTIONS.map(literal).join(',');
const own = (r, owner, records) => `${r}.owner_id NOT IN (SELECT value FROM json_each(${owner}))
  AND (${r}.record_id IS NULL OR ${r}.record_id NOT IN (SELECT value FROM json_each(${records})))`;

// Mirror applyDeletionLedger's actual embedded semantics: profile copies and run
// events survive with their parent; application events also have their own filter.
function visible(alias, owners, records) {
  const removed = own(alias, owners, records);
  const parent = `EXISTS (SELECT 1 FROM rows pp WHERE pp.collection=${alias}.parent_collection
    AND pp.id=${alias}.parent_id AND ${own('pp', owners, records)})`;
  return `(CASE WHEN ${alias}.collection IN ('profileCopies','runEvents') THEN ${parent}
    WHEN ${alias}.collection='applicationEvents' THEN ${parent} AND ${removed}
    ELSE ${removed} END)`;
}

const identityKey = `CASE r.collection WHEN 'profiles' THEN json_extract(r.value,'$.revisionId')
  WHEN 'targets' THEN json_extract(r.value,'$.revisionId') WHEN 'profileCopies' THEN json_extract(r.value,'$.revisionId')
  WHEN 'jobs' THEN json_extract(r.value,'$.jobId') WHEN 'observations' THEN json_extract(r.value,'$.observationId')
  WHEN 'evaluations' THEN json_extract(r.value,'$.evaluationId') WHEN 'runs' THEN json_extract(r.value,'$.runId')
  WHEN 'applications' THEN json_extract(r.value,'$.applicationId') ELSE r.id END`;
const referenceCollections = "('jobs','observations','evaluations','applications','runs','events','files','runEvents','applicationEvents','recoveryRecords')";
const refRules = [ ['jobId', 'jobs'], ['runId', 'runs'], ['observationId', 'observations'], ['applicationId', 'applications'] ];
const expectations = refRules.map(([field, collection]) => ({ field, collection: literal(collection),
  id: `json_extract(r.value,'$.${field}')`, when: `r.collection IN ${referenceCollections} AND r.collection<>${literal(collection)}
    AND json_type(r.value,'$.${field}')='text' AND length(json_extract(r.value,'$.${field}'))>0` }));
expectations.push({ field: 'collectionActivityId', collection: "'runs'", id: "json_extract(r.value,'$.collectionActivityId')",
  when: "r.collection='runs' AND json_extract(r.value,'$.collectionRole')='collection_slice' AND json_type(r.value,'$.collectionActivityId')='text' AND length(json_extract(r.value,'$.collectionActivityId'))>0" });
expectations.push({ field: 'parent', collection: 'r.parent_collection', id: 'r.parent_id',
  when: "r.parent_id IS NOT NULL AND r.parent_collection NOT IN ('packages','profileGroups','targetGroups','aliasGroups') AND r.collection<>'recoveryRecords'" });
for (const rule of expectations) rule.when=`coalesce((${rule.when}),0)`;
const matchesRef = rule => `(rr.field=${literal(rule.field)} AND rr.target_collection=${rule.collection} AND rr.target_id=${rule.id} AND (${rule.when}))`;
const referencesValid = `${expectations.map(rule => `(NOT (${rule.when}) OR EXISTS
  (SELECT 1 FROM row_refs rr JOIN rows rt ON rt.collection=rr.target_collection AND rt.id=rr.target_id
    WHERE rr.collection=r.collection AND rr.id=r.id AND rr.owner_id IS r.owner_id AND rt.owner_id IS r.owner_id AND ${matchesRef(rule)}))`).join(' AND ')}
  AND NOT EXISTS (SELECT 1 FROM row_refs rr WHERE rr.collection=r.collection AND rr.id=r.id
    AND (rr.owner_id IS NOT r.owner_id OR NOT (${expectations.map(matchesRef).join(' OR ')})))`;
const parentValid = `(CASE r.collection
  WHEN 'profiles' THEN r.parent_collection='profileGroups' AND r.parent_id IS json_extract(r.value,'$.profileId') AND r.part_path='profiles'
  WHEN 'targets' THEN r.parent_collection='targetGroups' AND r.parent_id IS json_extract(r.value,'$.targetId') AND r.part_path='targets'
  WHEN 'profileCopies' THEN r.parent_collection='targets' AND r.part_path='profileSnapshot' AND r.ordinal=0
  WHEN 'runEvents' THEN r.parent_collection='runs' AND r.part_path='events' AND r.id=json_array(r.parent_id,'events',CAST(r.ordinal AS TEXT))
  WHEN 'applicationEvents' THEN r.parent_collection='applications' AND r.part_path='events' AND r.id=json_array(r.parent_id,'events',CAST(r.ordinal AS TEXT))
  ELSE r.parent_collection IS NULL AND r.parent_id IS NULL AND r.part_path IS NULL END)
  AND (r.parent_id IS NULL OR EXISTS (SELECT 1 FROM rows rp WHERE rp.collection=r.parent_collection AND rp.id=r.parent_id
    AND (r.parent_collection IN ('profileGroups','targetGroups') OR rp.owner_id IS r.owner_id)))
  AND (r.collection NOT IN ('profileCopies','runEvents','applicationEvents') OR EXISTS
    (SELECT 1 FROM row_parts part WHERE part.collection=r.parent_collection AND part.id=r.parent_id AND part.path=r.part_path
      AND part.child_collection=r.collection AND part.shape=CASE WHEN r.collection='profileCopies' THEN 'value' ELSE 'array' END))`;
const identityValid = `json_type(r.value)='object' AND json_type(r.value,'$.recordId')='text'
  AND r.record_id IS json_extract(r.value,'$.recordId') AND r.owner_id IS json_extract(r.value,'$.ownerPackageId')
  AND ${identityKey} IS r.id AND (${parentValid}) AND (${referencesValid})`;
// Equivalent to the existing case-insensitive UUID-v4 contract, using only
// SQLite's fixed scalar string operations (no extension/REGEXP/JS body decode).
const uuid = field => `(typeof(${field})='text' AND length(${field})=36 AND length(CAST(${field} AS BLOB))=36
  AND substr(${field},9,1)='-' AND substr(${field},14,1)='-' AND substr(${field},19,1)='-' AND substr(${field},24,1)='-'
  AND substr(${field},15,1)='4' AND lower(substr(${field},20,1)) IN ('8','9','a','b')
  AND length(replace(${field},'-',''))=32 AND lower(replace(${field},'-','')) NOT GLOB '*[^0-9a-f]*')`;
const pairedIdentity = `r.owner_id IS NOT NULL AND r.record_id IS NOT NULL
  AND json_type(r.value,'$.ownerPackageId')='text' AND json_type(r.value,'$.recordId')='text'
  AND r.owner_id IS json_extract(r.value,'$.ownerPackageId') AND r.record_id IS json_extract(r.value,'$.recordId')
  AND ${uuid('r.owner_id')} AND ${uuid('r.record_id')}`;
const globalIdentityMismatch = `SELECT EXISTS (SELECT 1 FROM rows r
  WHERE r.collection IN (${collectionList}) AND NOT coalesce(
    CASE WHEN r.collection='recoveryRecords' AND r.owner_id IS NULL
      AND (json_type(r.value,'$.ownerPackageId') IS NULL OR json_type(r.value,'$.ownerPackageId')='null')
      THEN r.record_id IS NULL ELSE (${pairedIdentity}) END,0)) AS mismatch`;

export function createSqlitePurgeQueries({ statement, countRows }) {
  function pageInput(input) {
    if (!input || Object.getPrototypeOf(input)!==Object.prototype ||
      Object.keys(input).some(k=>!['section','packageId','after','limit'].includes(k))) throw invalid();
    const { section, packageId, after, limit=200 }=input;
    if (!['packages','recordHeads','runHeads','fileHeads'].includes(section) || !Number.isSafeInteger(limit) || limit<1 || limit>200) throw invalid();
    if (section==='packages' ? packageId!==undefined : !UUID_RE.test(packageId||'')) throw invalid();
    if (after!==undefined && (!after || Object.getPrototypeOf(after)!==Object.prototype ||
      Object.keys(after).length!==2 || !Object.hasOwn(after,'collection') || !Object.hasOwn(after,'id') ||
      typeof after.id!=='string' || !after.id || after.id.length>4096 ||
      !(section==='recordHeads'?PURGE_ENTITY_COLLECTIONS:section==='packages'?['packages']:section==='runHeads'?['runs']:['files']).includes(after.collection))) throw invalid();
    return {section,packageId,after,limit};
  }
  function exclusions(control) {
    return { owners:JSON.stringify(Object.keys(control.deletionLedger)),
      records:JSON.stringify([...new Set(Object.values(control.deletionLedger).flatMap(e=>e.recordIds))]) };
  }
  function finish(raw, limit, map) {
    const hasMore=raw.length>limit;if(hasMore)raw.pop();countRows(raw.length);
    return {rows:raw.map(map),hasMore,nextCursor:hasMore?{collection:raw.at(-1).collection,id:raw.at(-1).id}:null};
  }
  function assertHead(row) {
    if (row.identityValid!==1 || !UUID_RE.test(row.recordId||'') || !UUID_RE.test(row.ownerPackageId||'')) throw bad();
    return {collection:row.collection,id:row.id,recordId:row.recordId,ownerPackageId:row.ownerPackageId};
  }
  return {
    assertPurgePlanningIdentity() {
      // Health/no-mismatch means SQLite must scan the entity JSON identity
      // scalars. One returned boolean is not constant scan or physical I/O cost.
      const row=statement(globalIdentityMismatch).get();countRows(1);
      if(row.mismatch!==0)throw bad();
    },
    readPurgeLeaseRevision(operationId) {
      if(typeof operationId!=='string'||!operationId||operationId.length>4096)throw invalid();
      const row=statement("SELECT max(revision) AS revision FROM changes WHERE collection='operationLeases' AND id=? AND action='put'")
        .get(operationId);countRows(1);return row.revision;
    },
    queryPurgePlanningPage(input, control) {
      const {section,packageId,after,limit}=pageInput(input);
      if (section==='packages') {
        const fields=PACKAGE_FIELDS.flatMap((k,i)=>[`json_type(r.value,'$.${k}') AS t${i}`,`json_extract(r.value,'$.${k}') AS v${i}`]);
        const raw=statement(`SELECT r.collection,r.id,k.kind AS keyKind,k.version_id AS keyVersion,k.state AS keyState,
          ${fields.join(',')} FROM rows r LEFT JOIN package_keys k ON k.id=r.id
          WHERE r.collection='packages' AND r.id>? ORDER BY r.id LIMIT ?`).all(after?.id||'',limit+1);
        return finish(raw,limit,row=>{
          const p={};for(const [i,key]of PACKAGE_FIELDS.entries())if(row['t'+i]!==null){
            const type=row['t'+i],v=row['v'+i];if(!['text','null','true','false'].includes(type))throw bad();
            p[key]=type==='true'?true:type==='false'?false:v;
          }
          if(p.packageId!==row.id || !UUID_RE.test(p.packageId||'') || !PACKAGE_KINDS.includes(p.kind) || !PACKAGE_STATES.includes(p.state) ||
            typeof p.versionId!=='string'||typeof p.versionName!=='string'||typeof p.enabled!=='boolean'||row.keyKind!==p.kind||row.keyVersion!==p.versionId||row.keyState!==p.state)throw bad();
          if(p.state==='active'&&[p.archiveId,p.archivedAt,p.purgeAt].some(v=>v!==null))throw bad();
          if(['trashed','purge_pending'].includes(p.state)&&(!UUID_RE.test(p.archiveId||'')||!Number.isFinite(Date.parse(p.archivedAt))||!Number.isFinite(Date.parse(p.purgeAt))))throw bad();
          const ledger=control.deletionLedger[p.packageId];if(ledger?.phase==='purged')return null;
          return ledger?{...p,state:'purge_pending',archiveId:ledger.archiveId,archivedAt:ledger.archivedAt,purgeAt:ledger.purgeAt}:p;
        });
      }
      const {owners,records}=exclusions(control),bindings=[];
      const collection=section==='recordHeads'?`r.collection IN (${collectionList})`:section==='runHeads'?"r.collection='runs'":"r.collection='files'";
      const owner=section==='fileHeads'?'1=1':'r.owner_id=?';if(section!=='fileHeads')bindings.push(packageId);
      // One composite cursor across fixed collections; same ids in two collections cannot drop a page.
      const cursor=after?' AND (r.collection>? OR (r.collection=? AND r.id>?))':'';
      if(after)bindings.push(after.collection,after.collection,after.id);
      const visibility=visible('r','?','?');
      // visible repeats the two parameters for parent and own predicates.
      const visibilityBindings=[owners,records,owners,records,owners,records,owners,records];
      const extra=section==='runHeads'?`,json_extract(r.value,'$.status') AS status,json_type(r.value,'$.snapshotRef') AS snapshotType,
        json_extract(r.value,'$.snapshotRef.path') AS snapshotPath,json_extract(r.value,'$.snapshotRef.hash') AS snapshotHash`:
        section==='fileHeads'?`,json_extract(r.value,'$.snapshotRecordId') AS snapshotRecordId,json_extract(r.value,'$.path') AS filePath,
        json_extract(r.value,'$.hash') AS fileHash,json_extract(r.value,'$.runId') AS runId`:'';
      const raw=statement(`SELECT r.collection,r.id,r.record_id AS recordId,r.owner_id AS ownerPackageId,
        (${identityValid}) AS identityValid ${extra} FROM rows r WHERE ${collection} AND ${owner}${cursor}
        AND ${visibility} ORDER BY r.collection,r.id LIMIT ?`).all(...bindings,...visibilityBindings,limit+1);
      return finish(raw,limit,row=>{
        const head=assertHead(row);
        if(section==='runHeads'){
          if(row.snapshotType!==null&&!['null','object'].includes(row.snapshotType))throw bad();
          return {...head,status:row.status,...(row.snapshotType==='object'?{snapshotRef:{path:row.snapshotPath,hash:row.snapshotHash}}:{})};
        }
        if(section==='fileHeads')return {...head,snapshotRecordId:row.snapshotRecordId,path:row.filePath,hash:row.fileHash,runId:row.runId};
        return head;
      });
    },
    countPurgePlanningRecords(packageId, control) {
      if(!UUID_RE.test(packageId||''))throw invalid();
      const {owners,records}=exclusions(control),counts=Object.fromEntries(['profiles','targets','jobs','observations','evaluations','runs','applications','events','files'].map(k=>[k,0]));
      for(const collection of PURGE_ENTITY_COLLECTIONS){
        const n=statement(`SELECT count(*) AS n FROM rows r WHERE r.collection=? AND r.owner_id=? AND ${visible('r','?','?')}`)
          .get(collection,packageId,owners,records,owners,records,owners,records,owners,records).n;
        countRows(1);counts[collection==='profileCopies'?'profiles':['runEvents','applicationEvents','recoveryRecords'].includes(collection)?'events':collection]+=n;
      }
      return counts;
    },
  };
}
