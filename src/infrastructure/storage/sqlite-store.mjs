import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertSupportedNodeRuntime } from '../runtime/requirements.mjs';
import { assertWorkspace, createEmptyWorkspace } from '../../domain/contracts.mjs';
import { versionNameKey } from '../../domain/workspace-management.mjs';
import { buildWorkspaceJobReadModels, JOB_READ_MODEL_VERSION } from '../../domain/job-read-model.mjs';
import { createSqliteJobQueries } from './sqlite-job-queries.mjs';
import { createSqliteCollectionQueries } from './sqlite-collection-queries.mjs';
import { createSqliteLegacyQueries } from './sqlite-legacy-queries.mjs';
import { createSqliteRecoveryQueries } from './sqlite-recovery-queries.mjs';
import { createSqlitePurgeQueries } from './sqlite-purge-queries.mjs';
import { buildCollectionProjectionRows, COLLECTION_PROJECTION_VERSION } from '../../domain/collection-projections.mjs';
import { PRIVATE_COLLECTIONS, QUERY_FIELDS, SCHEMA_SQL, SQLITE_COLLECTIONS, SQLITE_STORE_VERSION } from './sqlite-schema.mjs';
import { assertJson, defineOwn, flattenWorkspace, inflateWorkspace, plain, recordMetadata,
  rowKey, rowStoreError, SPLIT_PARTS, validateRecord } from './sqlite-records.mjs';
import { existingMaintenanceState, assertExistingDatabasePathSync, verifyExistingReadWriteDatabase } from './maintenance-existing.mjs';
import { PURGE_WORKER_JOURNAL, PURGE_REPLACEMENT_STAGES, assertPurgeDescriptor, assertPurgeJournal,
  assertPurgeLease, samePurgeDescriptor, isProtectedPurgeLease, purgeClaimError, purgeLimits } from '../maintenance/protocol.mjs';
import { hasLiveOwner } from './process-owner.mjs';

const MAX_PAGE = 200, MAX_IDS = 1000, MAX_SELECT = 64;
const enc = v => JSON.stringify(v);
const clone = v => v === undefined ? undefined : structuredClone(v);
const thenable = v => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
const safeInt = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const managedMeta = new Set(['storeVersion', 'schemaVersion', 'revision', 'topKeys', 'migrationSourceHash','jobReadModelVersion','collectionProjectionVersion',PURGE_WORKER_JOURNAL]);
const columnNames = ['owner_id','record_id','parent_collection','parent_id','part_path','ordinal',
  'job_id','run_id','target_revision_id','profile_revision_id','observation_id','fact_hash','rule_version',
  'status','kind','next_due_at','resource_key','checked_at','sort_at','title','company','job_type','score',
  'recommendation','opening_status','application_status','source_id','site_id','event_seq','name_key'];
const metadataNames = ['ownerPackageId','recordId','parentCollection','parentId','path','ordinal',
  'jobId','runId','targetRevisionId','profileRevisionId','observationId','factContentHash','ruleVersion',
  'status','kind','nextDueAt','resourceKey','checkedAt','sortAt','title','company','jobType','score',
  'recommendation','openingStatus','applicationStatus','sourceId','siteId','seq','nameKey'];
const fromDb = raw => ({ collection: raw.collection, id: raw.id, value: JSON.parse(raw.value),
  metadata: Object.fromEntries(metadataNames.map((key, i) => [key, raw[columnNames[i]]])) });
const routingOf = row => ({ ownerPackageId: row.metadata.ownerPackageId,
  parent: row.metadata.parentId === null ? undefined : { collection: row.metadata.parentCollection, id: row.metadata.parentId, path: row.metadata.path },
  ordinal: row.metadata.ordinal, runId: row.metadata.runId, targetRevisionId: row.metadata.targetRevisionId,
  jobId: row.metadata.jobId, profileRevisionId: row.metadata.profileRevisionId });
function syncResult(result) {
  if (thenable(result)) {
    // Consume a possible rejection; a late continuation still sees a closed tx.
    Promise.resolve(result).catch(() => {});
    throw rowStoreError('sqlite_async_transaction', 'Storage callbacks must finish synchronously.');
  }
  return result;
}
function normalizeError(error) {
  if (error.code?.startsWith('sqlite_')) return error;
  if (error.errcode === 5 || error.errcode === 6 || /database (?:is )?(?:locked|busy)/i.test(error.message))
    return rowStoreError('sqlite_busy', 'The database is busy; no successful commit is claimed.', error);
  if (error.code === 'ERR_SQLITE_ERROR' && /constraint|private owner required/i.test(error.message))
    return rowStoreError('sqlite_constraint', 'A database identity, reference, or ownership constraint was rejected.', error);
  return error;
}

/**
 * Internal synchronous row port. The official API subset is documented at:
 * https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html
 * The production repository must hold its common control/write fence around a
 * transaction; this connection does not pretend to atomically update control.
 */
export function openSqliteRowStore({ filename, busyTimeoutMs = 250, guard, onProjection, faultInjector, existingMaintenanceBinding } = {}) {
  assertSupportedNodeRuntime();
  const { DatabaseSync, backup: sqliteBackup } = createRequire(import.meta.url)('node:sqlite');
  if (typeof filename !== 'string' || !filename || !safeInt(busyTimeoutMs) || busyTimeoutMs > 30000)
    throw rowStoreError('sqlite_options_invalid', 'A file and bounded busy timeout are required.');
  const maintenanceState=existingMaintenanceBinding===undefined?null:existingMaintenanceState(existingMaintenanceBinding);
  const modePath=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  if(maintenanceState&&modePath(filename)!==modePath(path.join(maintenanceState.dataDir,'workspace.sqlite')))throw purgeClaimError();
  if(!maintenanceState&&filename!==':memory:')fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true});
  let db;
  try{
    if(maintenanceState)assertExistingDatabasePathSync(existingMaintenanceBinding);
    db=new DatabaseSync(filename,{timeout:busyTimeoutMs,enableForeignKeyConstraints:true,
      enableDoubleQuotedStringLiterals:false,allowExtension:false});
    if(maintenanceState){assertExistingDatabasePathSync(existingMaintenanceBinding);verifyExistingReadWriteDatabase(db,existingMaintenanceBinding);}
  }catch(error){db?.close();if(maintenanceState)throw purgeClaimError('purge_existing_store_required');throw error;}
  let closed = false, active = false, operation = false;
  const metrics = { statements: 0, prepares:0,statementCacheHits:0, rowsRead: 0, rowsWritten: 0, decodedRows: 0, decodedBytes: 0,
    decodedPrivateRows:0,decodedPrivateBytes:0,
    purgeIdentityGuardStatements:0,purgeIdentityGuardMs:0,
    metaRowsRead: 0, metaDecodedBytes: 0,
    transactionReadMs:0,transactionStageMs:0,transactionWriteRowsMs:0,transactionRefsMs:0,transactionCommitMs:0,
    serializedRows: 0, serializedBytes: 0, transactions: 0, commits: 0, rollbacks: 0,
    maintenanceExports: 0, maintenanceImports: 0,
    maintenanceFlattenMs:0,maintenanceBuildMs:0,maintenanceWriteRowsMs:0,maintenanceRefsMs:0,maintenanceCommitMs:0 };
  const statementCache=new Map(),statementCacheLimit=256;
  const statement=sql=>{
    metrics.statements++;
    const cached=statementCache.get(sql);
    if(cached){metrics.statementCacheHits++;statementCache.delete(sql);statementCache.set(sql,cached);return cached;}
    const prepared=db.prepare(sql);metrics.prepares++;statementCache.set(sql,prepared);
    if(statementCache.size>statementCacheLimit)statementCache.delete(statementCache.keys().next().value);
    return prepared;
  };
  const decode = raw => {
    if (!raw) return null;
    metrics.rowsRead++; metrics.decodedRows++; metrics.decodedBytes += Buffer.byteLength(raw.value);
    if(PRIVATE_COLLECTIONS.has(raw.collection)||(raw.collection==='recoveryRecords'&&raw.owner_id)){
      metrics.decodedPrivateRows++;metrics.decodedPrivateBytes+=Buffer.byteLength(raw.value);
    }
    return fromDb(raw);
  };
  const encode = value => { const text = enc(value); metrics.serializedRows++; metrics.serializedBytes += Buffer.byteLength(text); return text; };
  const assertOpen = () => { if (closed) throw rowStoreError('sqlite_closed', 'The row store is closed.'); };
  const metaRaw = key => { const r = statement('SELECT value FROM store_meta WHERE key=?').get(key);
    if(r){metrics.rowsRead++;metrics.metaRowsRead++;metrics.metaDecodedBytes+=Buffer.byteLength(r.value);}
    return r ? JSON.parse(r.value) : undefined; };
  const writeMeta = (key, value) => {
    statement('INSERT INTO store_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, encode(value)); metrics.rowsWritten++;
  };
  try {
    // Refuse unknown/future files before changing journal mode or creating a table.
    // Repeat under the writer lock: another first opener may initialize and even
    // import data after this connection observed an empty file.
    const inspectFormat=()=>{
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='store_meta'").get();
    if (existing) {
      const version = metaRaw('storeVersion');
      if (version !== SQLITE_STORE_VERSION) throw rowStoreError('sqlite_store_version', 'Unsupported row store format.');
      if (![2,3].includes(metaRaw('schemaVersion'))) throw rowStoreError('sqlite_workspace_version','Unsupported stored workspace format.');
      if (!safeInt(metaRaw('revision'))) throw rowStoreError('sqlite_meta_invalid','Invalid stored workspace revision.');
    } else if (db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get())
      throw rowStoreError('sqlite_store_unrecognized','The file is not an empty or recognized business database.');
    return Boolean(existing);
    };
    inspectFormat();
    // PRAGMA values are fixed literals, never interpolated input. FULL is a hard gate.
    db.exec(maintenanceState?'PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;':
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
    const pragmas = Object.fromEntries(['journal_mode','synchronous','foreign_keys','secure_delete']
      .map(key => [key, Object.values(db.prepare(`PRAGMA ${key}`).get())[0]]));
    if ((filename !== ':memory:' && pragmas.journal_mode !== 'wal') || pragmas.synchronous !== 2 ||
      pragmas.foreign_keys !== 1 || pragmas.secure_delete !== 1)
      throw rowStoreError('sqlite_pragma_invalid', 'The database durability or reference settings were not applied.');
    if(maintenanceState){
      // Already initialized and inspected under the repository's file fence.
      // In this mode there is deliberately no DDL, migration, journal-mode
      // switch, marker write or fallback to normal initialization.
      verifyExistingReadWriteDatabase(db,existingMaintenanceBinding);
      assertExistingDatabasePathSync(existingMaintenanceBinding);
    }else{
    db.exec('BEGIN IMMEDIATE');
    try {
      const initialized=inspectFormat();
      db.exec(SCHEMA_SQL);
      if (!initialized) {
        writeMeta('storeVersion', SQLITE_STORE_VERSION); writeMeta('schemaVersion', 3); writeMeta('revision', 0);
        writeMeta('topKeys', ['schemaVersion','revision','packages','profiles','targets','jobs','observations','evaluations',
          'applications','runs','events','files','sourceHealth','identityAliases','duplicateGroups','recoveryRecords','migration','settings']);
      }
      db.exec('COMMIT');
    } catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    }
  } catch (error) { db.close(); throw normalizeError(error); }

  const rawRow = (collection, id) => statement('SELECT * FROM rows WHERE collection=? AND id=?').get(collection, id);
  function invokeGuard(input) {
    if(input.phase==='read'&&faultInjector)syncResult(faultInjector('beforeRead',{phase:'read',ownerPackageIds:input.ownerPackageIds||[]}));
    if (!guard) return;
    let live=true;
    const check=()=>{if(!live)throw rowStoreError('sqlite_guard_closed','This synchronous guard invocation has ended.');};
    const readPort=Object.freeze({
      getMeta:key=>{check();validateMetaKey(key);return clone(metaRaw(key));},
      getRow:({collection,id})=>{check();validateCollection(collection);if(typeof id!=='string'||id.length>4096)throw rowStoreError('sqlite_id_invalid','Invalid guard row identity.');return clone(decode(rawRow(collection,id))?.value ?? null);},
    });
    try{syncResult(guard(Object.freeze(clone(input)),readPort));}finally{live=false;}
  }
  function validateCollection(collection) {
    if (!SQLITE_COLLECTIONS.includes(collection)) throw rowStoreError('sqlite_collection_invalid', 'Unknown collection.');
  }
  function validateSelector(input, { maintenance = false } = {}) {
    if (!plain(input)) throw rowStoreError('sqlite_selection_invalid', 'A fixed collection selector is required.');
    const allowed = new Set(['collection','ownerPackageId','ownerPackageIds','ids','where','limit','offset','orderBy','direction','afterId','readParts','total']);
    if (Object.keys(input).some(k => !allowed.has(k))) throw rowStoreError('sqlite_selection_invalid', 'Unknown selector option.');
    validateCollection(input.collection);
    const s = clone(input);
    if (s.ownerPackageId !== undefined && typeof s.ownerPackageId !== 'string') throw rowStoreError('sqlite_selection_invalid', 'Invalid owner.');
    if (s.ownerPackageIds !== undefined && (!Array.isArray(s.ownerPackageIds) || s.ownerPackageIds.length > 100 ||
      !s.ownerPackageIds.length || s.ownerPackageIds.some(v => typeof v !== 'string')))
      throw rowStoreError('sqlite_selection_invalid', 'At most 100 explicit owners are allowed.');
    if (s.ownerPackageId !== undefined && s.ownerPackageIds !== undefined) throw rowStoreError('sqlite_selection_invalid', 'Choose one owner selector.');
    if (!maintenance && PRIVATE_COLLECTIONS.has(s.collection) && s.ownerPackageId === undefined && !s.ownerPackageIds)
      throw rowStoreError('sqlite_scope_required', 'An ordinary private query requires explicit owners.');
    if (s.ids !== undefined && (!Array.isArray(s.ids) || s.ids.length > MAX_IDS || s.ids.some(id => typeof id !== 'string' || !id.length || id.length > 4096)))
      throw rowStoreError('sqlite_selection_invalid', 'At most 1000 explicit row identities are allowed.');
    const max = maintenance ? 1000 : MAX_PAGE;
    s.limit ??= s.ids ? Math.max(1, s.ids.length) : MAX_PAGE;
    if (!safeInt(s.limit, 1) || s.limit > (s.ids ? MAX_IDS : max)) throw rowStoreError('sqlite_selection_invalid', 'The row limit is not bounded.');
    s.offset ??= 0;
    if (!safeInt(s.offset) || s.offset > 100000) throw rowStoreError('sqlite_selection_invalid', 'Use a maintenance cursor for deeper traversal.');
    if (s.orderBy !== undefined && !Object.hasOwn(QUERY_FIELDS, s.orderBy)) throw rowStoreError('sqlite_selection_invalid', 'Unknown sort field.');
    if (s.direction !== undefined && !['asc','desc'].includes(s.direction)) throw rowStoreError('sqlite_selection_invalid', 'Unknown sort direction.');
    if (s.afterId !== undefined && (typeof s.afterId !== 'string' || s.orderBy || s.direction === 'desc' || s.offset)) throw rowStoreError('sqlite_selection_invalid', 'A row cursor uses default ascending identity order.');
    if (s.readParts !== undefined && (!Array.isArray(s.readParts) || s.readParts.length > 24)) throw rowStoreError('sqlite_selection_invalid', 'Part selection exceeds its bound.');
    return s;
  }
  function sqlSelection(s) {
    const clauses = ['collection=?'], bindings = [s.collection];
    if (s.ownerPackageId !== undefined) { clauses.push('owner_id=?'); bindings.push(s.ownerPackageId); }
    if (s.ownerPackageIds) { clauses.push(`owner_id IN (${s.ownerPackageIds.map(() => '?').join(',')})`); bindings.push(...s.ownerPackageIds); }
    if (s.ids) { clauses.push(s.ids.length ? `id IN (${s.ids.map(() => '?').join(',')})` : '0'); bindings.push(...s.ids); }
    if (s.afterId !== undefined) { clauses.push('id>?'); bindings.push(s.afterId); }
    if (s.where !== undefined) {
      if (!plain(s.where) || Object.keys(s.where).length > 16) throw rowStoreError('sqlite_selection_invalid', 'Invalid fixed index filter.');
      for (const [key, condition] of Object.entries(s.where)) {
        if (!Object.hasOwn(QUERY_FIELDS,key)) throw rowStoreError('sqlite_selection_invalid', 'Unknown filter field.');
        const col = QUERY_FIELDS[key];
        if (condition === null) { clauses.push(`${col} IS NULL`); continue; }
        if (plain(condition)) {
          if (Object.keys(condition).length !== 1) throw rowStoreError('sqlite_selection_invalid', 'One comparison is allowed per field.');
          const [op, value] = Object.entries(condition)[0];
          if (op === 'in') {
            if (!Array.isArray(value) || value.length > 100 || value.some(v => !['string','number'].includes(typeof v)))
              throw rowStoreError('sqlite_selection_invalid', 'Invalid finite index value set.');
            clauses.push(value.length ? `${col} IN (${value.map(() => '?').join(',')})` : '0'); bindings.push(...value);
          } else {
            const operators = { lt:'<', lte:'<=', gt:'>', gte:'>=' };
            const compare = Object.hasOwn(operators,op) ? operators[op] : null;
            if (!compare || !['string','number'].includes(typeof value)) throw rowStoreError('sqlite_selection_invalid', 'Invalid index comparison.');
            clauses.push(`${col}${compare}?`); bindings.push(value);
          }
        } else {
          if (!['string','number'].includes(typeof condition) || (typeof condition === 'number' && !Number.isFinite(condition)))
            throw rowStoreError('sqlite_selection_invalid', 'Index values must be SQL scalar values.');
          clauses.push(`${col}=?`); bindings.push(condition);
        }
      }
    }
    return { where: clauses.join(' AND '), bindings };
  }
  function selectRows(input, options = {}) {
    const s = validateSelector(input, options), q = sqlSelection(s);
    const direction = s.direction === 'desc' ? 'DESC' : 'ASC', order = QUERY_FIELDS[s.orderBy || 'id'];
    const raw = statement(`SELECT * FROM rows WHERE ${q.where} ORDER BY ${order} ${direction},id ${direction} LIMIT ? OFFSET ?`)
      .all(...q.bindings, s.limit + 1, s.offset);
    const hasMore = raw.length > s.limit; if (hasMore) raw.pop();
    const records = raw.map(decode);
    const total = s.total === false ? undefined : statement(`SELECT count(*) AS n FROM rows WHERE ${q.where}`).get(...q.bindings).n;
    return { selector: s, records, total, hasMore, nextCursor: hasMore && !s.orderBy && s.direction !== 'desc' ? records.at(-1)?.id ?? null : null };
  }
  function assertReady(maintenance = false) {
    assertOpen();
    if (operation) throw rowStoreError('sqlite_nested_transaction','Use only the declared transaction port inside a storage callback.');
    if (!maintenance && metaRaw('schemaVersion') !== 3) throw rowStoreError('sqlite_legacy_maintenance_only', 'Legacy rows are only available to explicit import/export maintenance.');
  }
  function buildView(selection, options = {}) {
    if (!plain(selection) || !Array.isArray(selection.select) || selection.select.length > MAX_SELECT)
      throw rowStoreError('sqlite_selection_invalid', 'A view needs at most 64 explicit selectors.');
    const rows = {}, indexes = {}, pageInfo = [], loaded = new Map(), declarations = [];
    const insert = row => { rows[row.collection] ||= {};indexes[row.collection] ||= {};defineOwn(rows[row.collection],row.id,clone(row.value));defineOwn(indexes[row.collection],row.id,clone(row.metadata));loaded.set(rowKey(row.collection,row.id), row); };
    for (const selector of selection.select) {
      const result = selectRows(selector, options); declarations.push(result.selector);
      result.records.forEach(insert);
      pageInfo.push({ collection: selector.collection, total: result.total, hasMore: result.hasMore, nextCursor: result.nextCursor });
      for (const requested of result.selector.readParts || []) {
        const part = typeof requested === 'string' ? { path: requested } : requested;
        if (!plain(part) || typeof part.path !== 'string') throw rowStoreError('sqlite_selection_invalid', 'A part requires its fixed path.');
        const definition = SPLIT_PARTS[selector.collection]?.find(([p]) => p === part.path);
        if (!definition) throw rowStoreError('sqlite_part_invalid', 'Unknown detached part.');
        for (const parent of result.records) {
          const childSelector = { collection: definition[1], ownerPackageId: parent.metadata.ownerPackageId ??
            (parent.collection === 'packages' ? parent.id : undefined),
            where: { parentId: parent.id, path: part.path }, limit: part.limit ?? MAX_PAGE,
            ...(part.ids ? { ids: part.ids } : {}), total: false };
          const child = selectRows(childSelector, options); child.records.forEach(insert); declarations.push(child.selector);
          pageInfo.push({ collection: definition[1], parentId: parent.id, path: part.path, hasMore: child.hasMore, nextCursor: child.nextCursor });
        }
      }
    }
    const meta = {};
    const declaredMeta=selection.metaKeys ?? [];
    if(!Array.isArray(declaredMeta)||declaredMeta.length>64||new Set(declaredMeta).size!==declaredMeta.length)
      throw rowStoreError('sqlite_selection_invalid','Declare at most 64 unique metadata keys.');
    const metaKeys=new Set([...declaredMeta]);
    for (const key of metaKeys) { validateMetaKey(key); defineOwn(meta,key,clone(metaRaw(key))); }
    return { value: { rows, indexes, meta, pageInfo }, loaded, declarations, metaKeys };
  }
  function validateMetaKey(key) {
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(key)) throw rowStoreError('sqlite_meta_invalid', 'Invalid metadata key.');
  }
  function checkDeclarations(collection, id, owner, declarations, loaded) {
    const existing=loaded.get(rowKey(collection,id));
    if(existing)return owner === undefined ? existing.metadata.ownerPackageId : owner;
    if(owner === undefined && PRIVATE_COLLECTIONS.has(collection)){
      const matches=declarations.filter(s=>s.collection===collection&&s.ids?.includes(id));
      if(!matches.length)throw rowStoreError('sqlite_undeclared_write','Declare each row identity before accessing it.');
      const owners=new Set(matches.flatMap(s=>s.ownerPackageIds || (s.ownerPackageId ? [s.ownerPackageId] : [])));
      if(owners.size!==1)throw rowStoreError('sqlite_scope_required','A missing private identity requires one unambiguous declared owner.');
      owner=[...owners][0];
    }
    if (!declarations.some(s => s.collection === collection && s.ids?.includes(id) &&
      (s.ownerPackageId === undefined || s.ownerPackageId === owner) &&
      (!s.ownerPackageIds || s.ownerPackageIds.includes(owner))))
      throw rowStoreError('sqlite_undeclared_write', 'Declare each new or missing row identity before writing it.');
    return owner;
  }
  const writeRowSql = `INSERT INTO rows(collection,id,value,${columnNames.join(',')}) VALUES (${Array(3 + columnNames.length).fill('?').join(',')})
    ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,${columnNames.map(c => `${c}=excluded.${c}`).join(',')}`;
  function validateRowForWrite(row, schemaVersion) {
    validateRecord(row.collection,row.id,row.value,{ schemaVersion, ownerPackageId: row.metadata.ownerPackageId });
    const partDefinitions=Object.entries(SPLIT_PARTS).flatMap(([parentCollection,definitions])=>definitions.map(definition=>({parentCollection,definition})));
    const detached=partDefinitions.filter(p=>p.definition[1] === row.collection);
    if(detached.length){
      const match=detached.find(p=>p.parentCollection===row.metadata.parentCollection && p.definition[0]===row.metadata.path);
      if(!match || !row.metadata.parentId || (row.collection==='conditionalCache' && row.metadata.parentId!==row.metadata.ownerPackageId))
        throw rowStoreError('sqlite_part_invalid','A detached child requires its fixed parent and path.');
      const shape=match.definition[2];
      if(row.collection==='profileCopies'){
        if(!plain(row.value)||row.id!==row.value.revisionId||row.metadata.ordinal!==0)
          throw rowStoreError('sqlite_part_invalid','A profile copy requires its own revision identity and scalar ordinal.');
      }else{
        let identity;try{identity=JSON.parse(row.id);}catch{}
        if(!Array.isArray(identity)||identity.length!==3||identity.some(v=>typeof v!=='string')||
          rowKey(...identity)!==row.id||identity[0]!==row.metadata.parentId||identity[1]!==row.metadata.path)
          throw rowStoreError('sqlite_part_invalid','A detached child requires its complete canonical rowKey.');
        const key=identity[2];
        if(shape==='value'&&(key!=='value'||row.metadata.ordinal!==0))
          throw rowStoreError('sqlite_part_invalid','A scalar part has exactly one canonical identity.');
        if(shape==='array'&&(!/^(0|[1-9]\d*)$/.test(key)||!safeInt(Number(key))||String(Number(key))!==key||row.metadata.ordinal!==Number(key)))
          throw rowStoreError('sqlite_part_invalid','An array part requires its canonical ordinal identity.');
        if((row.collection==='reservations'&&row.value.reservationId!==key)||(row.collection==='activityUnits'&&row.value.unitId!==key))
          throw rowStoreError('sqlite_part_invalid','A detached map identity differs from its entity identity.');
      }
    }
  }
  function writeRow(row, schemaVersion) {
    validateRowForWrite(row,schemaVersion);
    if (row.collection === 'packages') {
      const v = row.value;
      statement(`INSERT INTO package_keys(id,kind,version_id,name_key,state) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,version_id=excluded.version_id,name_key=excluded.name_key,state=excluded.state`)
        .run(row.id,v.kind,v.versionId,versionNameKey(v.versionName),v.state);
    }
    statement(writeRowSql).run(row.collection,row.id,encode(row.value),...metadataNames.map(k => row.metadata[k] ?? null)); metrics.rowsWritten++;
    if (row.metadata.parentId && row.metadata.path) {
      const part = SPLIT_PARTS[row.metadata.parentCollection]?.find(([p,c]) => p === row.metadata.path && c === row.collection);
      if (part) statement(`INSERT INTO row_parts(collection,id,path,child_collection,shape) VALUES (?,?,?,?,?)
        ON CONFLICT(collection,id,path) DO NOTHING`).run(row.metadata.parentCollection,row.metadata.parentId,part[0],part[1],part[2]);
    }
  }
  function referenceRows(row,{hasRow=(collection,id)=>Boolean(rawRow(collection,id))}={}) {
    const { collection, id, value: v, metadata: m } = row;
    const refs = [];
    const add = (field, collection, targetId) => { if (typeof targetId === 'string' && targetId) refs.push({ field, collection, id: targetId }); };
    if (plain(v) && ['jobs','observations','evaluations','applications','runs','events','files','runEvents','applicationEvents','recoveryRecords'].includes(collection)) {
      // An ownerless orphan diagnostic names an unregistered file, not a run
      // entity. Owned diagnostics and every other reference retain their FKs.
      for (const [field,map] of [['jobId','jobs'],['runId','runs'],['observationId','observations'],['applicationId','applications']])
        if (collection !== map && !(collection === 'recoveryRecords' && m.ownerPackageId === null && v.code === 'orphan_snapshot' && field === 'runId')) add(field,map,v[field]);
      if (collection === 'runs' && v.collectionRole === 'collection_slice') add('collectionActivityId','runs',v.collectionActivityId);
    }
    if (collection === 'targetMembers') {
      add('targetRevisionId','targets',m.targetRevisionId); add('jobId','jobs',m.jobId);
      for (const ref of v.factRefs || []) add('factRefs','observations',ref.observationId);
      if (v.currentObservationId != null && !(v.factRefs || []).some(ref => ref.observationId === v.currentObservationId))
        throw rowStoreError('sqlite_member_invalid','Current observation is not in the member fact references.');
    }
    if (collection === 'memberGroups') add('targetRevisionId','targets',m.targetRevisionId);
    if (['jobProjections','jobIdentityKeys','jobFactBasis','jobRelations'].includes(collection)) {
      add('jobId','jobs',m.jobId); if (collection === 'jobRelations') add('otherJobId','jobs',v.otherJobId);
    }
    if (['activityMetrics','budgetUsage'].includes(collection)) add('runId','runs',m.runId);
    if (['runEvaluationIds','activityJobIds'].includes(collection)) add('value',collection === 'activityJobIds' ? 'jobs' : 'evaluations',v);
    if (m.parentId && !['packages','profileGroups','targetGroups','aliasGroups'].includes(m.parentCollection) && PRIVATE_COLLECTIONS.has(collection)) add('parent',m.parentCollection,m.parentId);
    if (collection === 'versionMetadata') add('revision',v.kind === 'profile' ? 'profiles' : 'targets',id);
    if (collection === 'jobRedirects') add('toJobId',hasRow('jobs',v.toJobId) ? 'jobs' : 'jobRedirects',v.toJobId);
    if (collection === 'duplicateGroups') for (const jobId of v.jobIds || []) add('jobIds','jobs',jobId);
    if (collection === 'identityAliasLinks') add('jobId',hasRow('jobs',v) ? 'jobs' : 'jobRedirects',v);
    return refs;
  }
  function updateRefs(row) {
    statement('DELETE FROM row_refs WHERE collection=? AND id=?').run(row.collection,row.id);
    for (const ref of referenceRows(row)) statement('INSERT INTO row_refs VALUES (?,?,?,?,?,?)')
      .run(row.collection,row.id,ref.field,ref.collection,ref.id,row.metadata.ownerPackageId);
  }
  function transaction(selection, action) {
    assertReady();
    if (active || operation) throw rowStoreError('sqlite_nested_transaction', 'Nested storage operations are not allowed.');
    if (typeof action !== 'function') throw rowStoreError('sqlite_callback_invalid', 'A synchronous callback is required.');
    operation = true; let committed = false, live = true;
    try {
      // A writer reserves its lock before reading the declared set. Other
      // connections cannot invalidate a budget/name decision before COMMIT.
      db.exec('BEGIN IMMEDIATE'); active = true; metrics.transactions++;
      let phaseStart=performance.now();
      const view = buildView(selection), dirty = new Map(), deleted = new Map(), metaWrites = new Map(), declaredParts=new Map();
      metrics.transactionReadMs+=performance.now()-phaseStart;
      const revision = metaRaw('revision');
      if (!safeInt(revision) || revision >= Number.MAX_SAFE_INTEGER) throw rowStoreError('sqlite_sequence_exhausted','Revision exhausted its safe range.');
      const ensureLive = () => { if (!live) throw rowStoreError('sqlite_transaction_closed','This transaction has ended.'); };
      const changes=()=>{
        const result=[...dirty.values()].map(r=>({collection:r.collection,id:r.id,ownerPackageId:r.metadata.ownerPackageId,
          before:clone(view.loaded.get(rowKey(r.collection,r.id))?.value??null),after:clone(r.value)}))
          .concat([...deleted.values()].map(r=>({collection:r.collection,id:r.id,ownerPackageId:r.metadata.ownerPackageId,before:clone(r.value),after:null})));
        for(const part of declaredParts.values()){
          const key=rowKey(part.collection,part.id),row=dirty.get(key)||view.loaded.get(key);
          if(!deleted.has(key)&&!result.some(r=>r.collection===part.collection&&r.id===part.id))result.push({collection:part.collection,id:part.id,ownerPackageId:row.metadata.ownerPackageId,before:clone(row.value),after:clone(row.value)});
        }
        return result;
      };
      const tx = Object.freeze({
        view: clone(view.value),
        getRow(input) {
          ensureLive(); validateCollection(input.collection); const key = rowKey(input.collection,input.id);
          checkDeclarations(input.collection,input.id,input.ownerPackageId,view.declarations,view.loaded);
          if (deleted.has(key)) return null;
          const row = dirty.get(key) || view.loaded.get(key);
          if (row && input.ownerPackageId !== undefined && row.metadata.ownerPackageId !== input.ownerPackageId)
            throw rowStoreError('sqlite_owner_mismatch','Requested owner does not own this row.');
          return clone(row?.value ?? null);
        },
        putRow(input) {
          ensureLive(); const { collection,id,value } = input; validateCollection(collection); assertJson(value);
          const key = rowKey(collection,id), old = view.loaded.get(key), prior = dirty.get(key) || old;
          const routing = { ...(prior ? routingOf(prior) : {}), ...input };
          const requestedOwner=input.ownerPackageId ?? (plain(value) ? value.ownerPackageId : undefined) ?? prior?.metadata.ownerPackageId;
          const declaredOwner=checkDeclarations(collection,id,requestedOwner,view.declarations,view.loaded);
          if(routing.ownerPackageId === undefined)routing.ownerPackageId=declaredOwner;
          const metadata = recordMetadata(collection,id,value,routing);
          const existing = prior || decode(rawRow(collection,id));
          if (existing && (metadata.ownerPackageId !== existing.metadata.ownerPackageId || metadata.recordId !== existing.metadata.recordId))
            throw rowStoreError('sqlite_identity_immutable','Owner and stable record identity require a separately authorized maintenance protocol.');
          if (existing && collection === 'packages' && (value.kind !== existing.value.kind || value.versionId !== existing.value.versionId))
            throw rowStoreError('sqlite_identity_immutable','Package version identity is immutable.');
          if (existing && !prior) throw rowStoreError('sqlite_undeclared_write','An existing row was outside the declared read scope.');
          for (const [partPath,,shape] of SPLIT_PARTS[collection] || []) {
            const embedded=partPath.split('.').reduce((v,k) => v && Object.hasOwn(v,k) ? v[k] : undefined,value);
            if ((shape === 'array' && Array.isArray(embedded)) || (shape !== 'array' && plain(embedded)))
              throw rowStoreError('sqlite_part_write_required','Detached parts must be written through their own declared rows.');
          }
          validateRecord(collection,id,value,{ schemaVersion:3,ownerPackageId:metadata.ownerPackageId });
          deleted.delete(key);
          if (old && encode(old.value) === encode(value) && enc(old.metadata) === enc(metadata)) dirty.delete(key);
          else dirty.set(key,{ collection,id,value:clone(value),metadata });
        },
        ensurePart(input){
          ensureLive();
          if(!plain(input)||Object.keys(input).some(key=>!['collection','id','path'].includes(key)))throw rowStoreError('sqlite_part_invalid','Only a declared fixed parent part can be registered.');
          const {collection,id,path}=input;validateCollection(collection);
          const key=rowKey(collection,id),row=dirty.get(key)||view.loaded.get(key);
          if(!row||deleted.has(key))throw rowStoreError('sqlite_undeclared_write','Declare and write the parent before registering its empty part.');
          checkDeclarations(collection,id,row.metadata.ownerPackageId,view.declarations,view.loaded);
          const definition=SPLIT_PARTS[collection]?.find(([field])=>field===path);
          if(!definition)throw rowStoreError('sqlite_part_invalid','The part path is outside the fixed storage contract.');
          const old=statement('SELECT child_collection,shape FROM row_parts WHERE collection=? AND id=? AND path=?').get(collection,id,path);
          if(old){metrics.rowsRead++;if(old.child_collection!==definition[1]||old.shape!==definition[2])throw rowStoreError('sqlite_part_invalid','The stored part definition is inconsistent.');return;}
          declaredParts.set(rowKey(collection,id,path),{collection,id,path,childCollection:definition[1],shape:definition[2]});
        },
        deleteRow({ collection,id,ownerPackageId }) {
          ensureLive(); checkDeclarations(collection,id,ownerPackageId,view.declarations,view.loaded);
          const key = rowKey(collection,id), row = view.loaded.get(key);
          if (row && ownerPackageId !== undefined && row.metadata.ownerPackageId !== ownerPackageId)
            throw rowStoreError('sqlite_owner_mismatch','Delete scope differs from the stored owner.');
          dirty.delete(key);for(const [partKey,part]of declaredParts)if(part.collection===collection&&part.id===id)declaredParts.delete(partKey); if (row) deleted.set(key,row);
        },
        getMeta(key) { ensureLive(); if (!view.metaKeys.has(key)) throw rowStoreError('sqlite_undeclared_write','Declare metadata keys before reading or writing them.'); return clone(metaWrites.has(key) ? metaWrites.get(key) : view.value.meta[key]); },
        setMeta(key,value) {
          ensureLive(); validateMetaKey(key); if (managedMeta.has(key) || !view.metaKeys.has(key)) throw rowStoreError('sqlite_meta_managed','Metadata key is managed or was not declared.');
          assertJson(value); if (Buffer.byteLength(enc(value)) > 16384) throw rowStoreError('sqlite_meta_invalid','Metadata values are bounded to 16KiB.');
          if (enc(view.value.meta[key]) !== enc(value)) metaWrites.set(key,clone(value));else metaWrites.delete(key);
        },
        deleteMeta(key) {
          ensureLive();validateMetaKey(key);if(managedMeta.has(key)||!view.metaKeys.has(key))throw rowStoreError('sqlite_meta_managed','Metadata key is managed or was not declared.');
          if(view.value.meta[key]===undefined)metaWrites.delete(key);else metaWrites.set(key,undefined);
        },
      });
      phaseStart=performance.now();
      invokeGuard({ phase:'write', ownerPackageIds:[...new Set(view.declarations.flatMap(s => s.ownerPackageIds || (s.ownerPackageId ? [s.ownerPackageId] : [])))], revision });
      // Isolate the result before COMMIT: a clone failure must not disguise a
      // successful durable write as a pre-commit error.
      const result = clone(syncResult(action(tx)));
      if (onProjection) syncResult(onProjection(tx,Object.freeze(changes())));
      const changed = changes();
      invokeGuard({ phase:'commit', revision, ownerPackageIds:[...new Set(changed.map(c => c.ownerPackageId).filter(Boolean))],
        recordIds:changed.map(c => (c.after || c.before)?.recordId).filter(Boolean),
        changes:changed.map(({ collection,id,ownerPackageId }) => ({ collection,id,ownerPackageId })) });
      metrics.transactionStageMs+=performance.now()-phaseStart;
      const protectedJournal=readPurgeWorkerJournal();
      for(const row of [...dirty.values(),...deleted.values()])if(row.collection==='operationLeases'&&
        (Object.hasOwn(row.value||{},'purgeClaim')||isProtectedPurgeLease({...decode(rawRow('operationLeases',row.id))?.value,operationId:row.id},protectedJournal)))
        throw purgeClaimError();
      faultInjector && syncResult(faultInjector('beforeWrite',{ revision }));
      phaseStart=performance.now();
      for (const row of deleted.values()) { statement('DELETE FROM rows WHERE collection=? AND id=?').run(row.collection,row.id); metrics.rowsWritten++; }
      for (const row of dirty.values()) writeRow(row,3);
      for(const part of declaredParts.values()){statement('INSERT INTO row_parts VALUES (?,?,?,?,?) ON CONFLICT(collection,id,path) DO NOTHING').run(part.collection,part.id,part.path,part.childCollection,part.shape);metrics.rowsWritten++;}
      metrics.transactionWriteRowsMs+=performance.now()-phaseStart;
      phaseStart=performance.now();
      for (const row of dirty.values()) updateRefs(row);
      metrics.transactionRefsMs+=performance.now()-phaseStart;
      for (const owner of new Set([...dirty.values()].flatMap(r => r.collection === 'packages' ? [r.id] : r.metadata.ownerPackageId ? [r.metadata.ownerPackageId] : []))) {
        if (statement("SELECT 1 AS invalid FROM package_keys WHERE id=? AND state IN ('purged','purge_pending') AND EXISTS (SELECT 1 FROM rows WHERE owner_id=?)").get(owner,owner))
          throw rowStoreError('sqlite_inaccessible_body','An inaccessible package cannot retain private rows.');
      }
      for (const [key,value] of metaWrites) {
        if(value === undefined){statement('DELETE FROM store_meta WHERE key=?').run(key);metrics.rowsWritten++;}
        else writeMeta(key,value);
      }
      const nextRevision = changed.length || metaWrites.size ? revision + 1 : revision;
      if (nextRevision !== revision) {
        const topKeys=metaRaw('topKeys'),nextTopKeys=[...topKeys];
        const topFor={profileGroups:'profiles',targetGroups:'targets',memberGroups:'targetMembers',targetMembers:'targetMembers',
          aliasGroups:'identityAliases',identityAliasLinks:'identityAliases',versionCounters:'versionCounters'};
        for(const row of dirty.values()){
          const top=topFor[row.collection] || (['packages','profiles','targets','jobs','observations','evaluations','applications','runs','events','files','sourceHealth',
            'duplicateGroups','jobRedirects','versionMetadata','versionSubmissions','dedupOperations','operationLeases','recoveryRecords','settings'].includes(row.collection) ? row.collection : null);
          if(top && !nextTopKeys.includes(top))nextTopKeys.push(top);
          if(row.collection==='workspaceFields'){
            let identity;try{identity=JSON.parse(row.id);}catch{}
            if(Array.isArray(identity)&&identity[0]==='extension'&&typeof identity[1]==='string'&&!nextTopKeys.includes(identity[1]))nextTopKeys.push(identity[1]);
          }
        }
        if(nextTopKeys.length!==topKeys.length)writeMeta('topKeys',nextTopKeys);
        writeMeta('revision',nextRevision);
        for (const c of changed) statement('INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES (?,?,?,?,?,?)')
          .run(nextRevision,c.collection,c.id,c.ownerPackageId,c.collection,c.after === null ? 'delete' : 'put');
        for (const key of metaWrites.keys()) statement('INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES (?,?,?,?,?,?)')
          .run(nextRevision,'store_meta',key,null,'meta','meta');
      }
      faultInjector && syncResult(faultInjector('beforeCommit',{ revision:nextRevision }));
      phaseStart=performance.now();db.exec('COMMIT');metrics.transactionCommitMs+=performance.now()-phaseStart; committed = true; metrics.commits++; live = false;
      try { faultInjector && syncResult(faultInjector('afterCommit',{ revision:nextRevision })); }
      catch (cause) { throw Object.assign(rowStoreError('sqlite_post_commit','The transaction committed, but post-commit reporting failed.',cause),{ committed:true,revision:nextRevision }); }
      return { result, revision:nextRevision, changes:changed.map(({collection,id,ownerPackageId,after}) => ({collection,id,ownerPackageId,action:after === null ? 'delete' : 'put'})) };
    } catch (error) {
      if (!committed && db.isTransaction) { db.exec('ROLLBACK'); metrics.rollbacks++; }
      throw normalizeError(error);
    } finally { live = false; active = false; operation = false; }
  }

  function exportWorkspace() {
    assertReady(true); if (operation) throw rowStoreError('sqlite_nested_transaction','Maintenance cannot run inside another operation.');
    operation = true;
    try {
      db.exec('BEGIN');
      const records = statement('SELECT * FROM rows ORDER BY collection,id').all().map(decode);
      const parts = statement('SELECT collection,id,path,child_collection AS childCollection,shape FROM row_parts').all();
      const workspace = inflateWorkspace(records,parts,{ schemaVersion:metaRaw('schemaVersion'),revision:metaRaw('revision'),topKeys:metaRaw('topKeys') });
      assertWorkspace(workspace); db.exec('COMMIT'); metrics.maintenanceExports++; return workspace;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw normalizeError(error); }
    finally { operation = false; }
  }
  function importWorkspace(workspace, { replace = false, allowLegacy = false, migrationSourceHash } = {}) {
    assertReady(true); if (operation) throw rowStoreError('sqlite_nested_transaction','Maintenance cannot run inside another operation.');
    let maintenancePhase=performance.now();
    const flat = flattenWorkspace(workspace);
    const protectedJournal=readPurgeWorkerJournal();
    if(protectedJournal&&protectedJournal.state!=='retired'||flat.schemaVersion===3&&flat.rows.some(row=>row.collection==='operationLeases'&&Object.hasOwn(row.value||{},'purgeClaim'))||
      statement("SELECT 1 AS present FROM rows WHERE collection='operationLeases' AND json_type(value,'$.purgeClaim') IS NOT NULL LIMIT 1").get())throw purgeClaimError();
    metrics.maintenanceFlattenMs+=performance.now()-maintenancePhase;
    if (migrationSourceHash !== undefined && (replace || typeof migrationSourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(migrationSourceHash)))
      throw rowStoreError('sqlite_migration_identity','Only an initial import may set its verified source hash.');
    if (flat.schemaVersion !== 3 && !allowLegacy) throw rowStoreError('sqlite_legacy_maintenance_only','Legacy import requires explicit authorization.');
    operation = true; let committed = false;
    try {
      db.exec('BEGIN IMMEDIATE'); metrics.transactions++;
      if (!replace && (statement('SELECT count(*) AS n FROM rows').get().n || statement('SELECT count(*) AS n FROM changes').get().n))
        throw rowStoreError('sqlite_import_nonempty','Initial import requires a fresh store; use explicit replace maintenance.');
      const nextRevision=replace ? Math.max(metaRaw('revision')+1,flat.revision) : flat.revision;
      if(!safeInt(nextRevision))throw rowStoreError('sqlite_sequence_exhausted','Replacement cannot advance beyond the safe revision range.');
      invokeGuard({ phase:replace ? 'replace' : 'import',schemaVersion:flat.schemaVersion,
        ownerPackageIds:flat.rows.filter(r => r.collection === 'packages').map(r => r.id),
        recordIds:flat.rows.map(r => r.metadata.recordId).filter(Boolean) });
      faultInjector && syncResult(faultInjector('beforeImport',{ replace }));
      if (replace) { db.exec('DELETE FROM row_refs; DELETE FROM row_parts; DELETE FROM rows; DELETE FROM package_keys;'); }
      writeMeta('schemaVersion',flat.schemaVersion);
      maintenancePhase=performance.now();
      for (const row of flat.rows) writeRow(row,flat.schemaVersion);
      metrics.maintenanceWriteRowsMs+=performance.now()-maintenancePhase;
      // Schema2 is an import-only historical graph; its dangling references are
      // preserved for the ownership normalizer. Schema3 always receives real FKs.
      maintenancePhase=performance.now();
      if(flat.schemaVersion===3)for (const row of flat.rows) updateRefs(row);
      metrics.maintenanceRefsMs+=performance.now()-maintenancePhase;
      if(flat.schemaVersion===3){
        maintenancePhase=performance.now();
        const asOf=Date.now(),derived=[...buildWorkspaceJobReadModels(workspace,{asOf}),...buildCollectionProjectionRows(workspace,{asOf})];
        metrics.maintenanceBuildMs+=performance.now()-maintenancePhase;
        for(const input of derived){
          const row={collection:input.collection,id:input.id,value:input.value,
            metadata:recordMetadata(input.collection,input.id,input.value,input)};
          maintenancePhase=performance.now();writeRow(row,3);metrics.maintenanceWriteRowsMs+=performance.now()-maintenancePhase;
          maintenancePhase=performance.now();updateRefs(row);metrics.maintenanceRefsMs+=performance.now()-maintenancePhase;
        }
        writeMeta('jobReadModelVersion',JOB_READ_MODEL_VERSION);
        writeMeta('collectionProjectionVersion',COLLECTION_PROJECTION_VERSION);
      }
      for (const p of flat.parts) statement('INSERT INTO row_parts VALUES (?,?,?,?,?) ON CONFLICT(collection,id,path) DO NOTHING').run(p.collection,p.id,p.path,p.childCollection,p.shape);
      writeMeta('revision',nextRevision); writeMeta('topKeys',flat.topKeys);
      if (migrationSourceHash !== undefined) writeMeta('migrationSourceHash',migrationSourceHash);
      statement('INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES (?,?,?,?,?,?)').run(nextRevision,'workspace','*',null,'maintenance', 'replace');
      faultInjector && syncResult(faultInjector('beforeCommit',{ revision:nextRevision }));
      maintenancePhase=performance.now();db.exec('COMMIT');metrics.maintenanceCommitMs+=performance.now()-maintenancePhase; committed = true; metrics.commits++; metrics.maintenanceImports++;
      try { faultInjector && syncResult(faultInjector('afterCommit',{ revision:nextRevision })); }
      catch (cause) { throw Object.assign(rowStoreError('sqlite_post_commit','Import committed, but post-commit reporting failed.',cause),{committed:true,revision:nextRevision}); }
      return { schemaVersion:flat.schemaVersion,revision:nextRevision,rows:flat.rows.length };
    } catch (error) { if (!committed && db.isTransaction) { db.exec('ROLLBACK'); metrics.rollbacks++; } throw normalizeError(error); }
    finally { operation = false; }
  }
  function rebuildReadModels({asOf=Date.now()}={}) {
    assertReady();
    const workspace=exportWorkspace(),started=performance.now();
    const derived=[...buildWorkspaceJobReadModels(workspace,{asOf}),...buildCollectionProjectionRows(workspace,{asOf})];
    metrics.maintenanceBuildMs+=performance.now()-started;
    operation=true;let committed=false;
    try {
      db.exec('BEGIN IMMEDIATE');metrics.transactions++;
      invokeGuard({phase:'replace',schemaVersion:3,ownerPackageIds:Object.keys(workspace.packages)});
      faultInjector&&syncResult(faultInjector('beforeReadModelWrite'));
      const derivedCollections="('jobProjections','jobIdentityKeys','jobFactBasis','jobRelations','budgetUsage','activityMetrics')";
      db.exec('DELETE FROM row_refs WHERE collection IN '+derivedCollections+';DELETE FROM rows WHERE collection IN '+derivedCollections);
      // v4 adds reverse redirect routing. This cold publication changes metadata
      // only; retained business JSON and migration source hashes stay exact.
      const routing=statement("UPDATE rows SET kind='job_redirect',resource_key=json_extract(value,'$.toJobId') WHERE collection='jobRedirects' AND (kind IS NOT 'job_redirect' OR resource_key IS NOT json_extract(value,'$.toJobId'))").run();
      metrics.rowsWritten+=Number(routing.changes);
      for(const input of derived){
        const row={collection:input.collection,id:input.id,value:input.value,metadata:recordMetadata(input.collection,input.id,input.value,input)};
        let phase=performance.now();writeRow(row,3);metrics.maintenanceWriteRowsMs+=performance.now()-phase;
        phase=performance.now();updateRefs(row);metrics.maintenanceRefsMs+=performance.now()-phase;
      }
      const revision=metaRaw('revision')+1;
      if(!safeInt(revision))throw rowStoreError('sqlite_sequence_exhausted','Read model rebuild cannot advance its revision.');
      writeMeta('jobReadModelVersion',JOB_READ_MODEL_VERSION);writeMeta('collectionProjectionVersion',COLLECTION_PROJECTION_VERSION);writeMeta('revision',revision);
      statement('INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES (?,?,?,?,?,?)').run(revision,'workspace','*',null,'read_models','replace');
      faultInjector&&syncResult(faultInjector('beforeCommit',{revision}));
      const phase=performance.now();db.exec('COMMIT');metrics.maintenanceCommitMs+=performance.now()-phase;committed=true;metrics.commits++;
      try{faultInjector&&syncResult(faultInjector('afterCommit',{revision}));}catch(cause){throw Object.assign(rowStoreError('sqlite_post_commit','Read model rebuild committed; reporting failed.',cause),{committed:true,revision});}
      return {revision,rows:derived.length,jobVersion:JOB_READ_MODEL_VERSION,collectionVersion:COLLECTION_PROJECTION_VERSION};
    }catch(error){if(!committed&&db.isTransaction){db.exec('ROLLBACK');metrics.rollbacks++;}throw normalizeError(error);}
    finally{operation=false;}
  }
  function readPurgeWorkerJournal(){
    assertOpen();const value=metaRaw(PURGE_WORKER_JOURNAL);
    return value===undefined?null:clone(assertPurgeJournal(value));
  }
  function coordinationTransaction(action){
    assertReady();operation=true;let committed=false;
    try{
      if(maintenanceState)assertExistingDatabasePathSync(existingMaintenanceBinding);
      db.exec('BEGIN IMMEDIATE');metrics.transactions++;
      const revision=metaRaw('revision'),journal=readPurgeWorkerJournal();
      invokeGuard({phase:'write',revision,ownerPackageIds:[]});
      const result=action({revision,journal});
      if(!result.changed){db.exec('COMMIT');committed=true;metrics.commits++;return result.value;}
      const nextRevision=revision+1;if(!safeInt(nextRevision))throw purgeClaimError();
      assertPurgeJournal(result.journal);writeMeta(PURGE_WORKER_JOURNAL,result.journal);writeMeta('revision',nextRevision);
      for(const change of result.changes||[])statement('INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES (?,?,?,?,?,?)')
        .run(nextRevision,change.collection,change.id,null,'purge_coordination',change.action);
      statement('INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES (?,?,?,?,?,?)')
        .run(nextRevision,'store_meta',PURGE_WORKER_JOURNAL,null,'purge_coordination','meta');
      faultInjector&&syncResult(faultInjector('beforePurgeCoordinationCommit',{revision:nextRevision}));
      db.exec('COMMIT');committed=true;metrics.commits++;
      try{if(maintenanceState)assertExistingDatabasePathSync(existingMaintenanceBinding);
        faultInjector&&syncResult(faultInjector('afterPurgeCoordinationCommit',{revision:nextRevision}));}
      catch(cause){throw Object.assign(rowStoreError('sqlite_post_commit','Purge coordination committed; reporting failed.',cause),
        {committed:true,revision:nextRevision});}
      return {...result.value,revision:nextRevision,journal:clone(result.journal)};
    }catch(error){if(!committed&&db.isTransaction){db.exec('ROLLBACK');metrics.rollbacks++;}throw normalizeError(error);}
    finally{operation=false;}
  }
  function reservePurgeWorkerJournal(descriptor,{expectedSequence=null,previousDescriptor=null}={}){
    assertPurgeDescriptor(descriptor);
    return coordinationTransaction(({journal})=>{
      if(journal&&samePurgeDescriptor(journal.descriptor,descriptor))return {changed:false,value:{journal}};
      if(journal){
        if(journal.state!=='retired'||journal.sequence!==expectedSequence||!samePurgeDescriptor(journal.descriptor,previousDescriptor))throw purgeClaimError();
        if(rawRow('operationLeases',journal.descriptor.leaseOperationId))throw purgeClaimError();
      }else if(expectedSequence!==null)throw purgeClaimError();
      const next={version:1,descriptor:clone(descriptor),sequence:(journal?.sequence||0)+1,state:'dispatch_reserved',
        workerPid:null,leaseToken:null,stage:'prepared',publicationReceipt:null};
      return {changed:true,journal:next,value:{journal:next}};
    });
  }
  function acquirePurgeWorkerLease(descriptor,{leaseToken,createdAt}={}){
    if(!maintenanceState||!samePurgeDescriptor(maintenanceState.descriptor,descriptor))throw purgeClaimError();
    return coordinationTransaction(({journal,revision})=>{
      if(!journal||!samePurgeDescriptor(journal.descriptor,descriptor))throw purgeClaimError();
      const stored=decode(rawRow('operationLeases',descriptor.leaseOperationId))?.value;
      if(stored){
        assertPurgeLease(stored,descriptor,{workerPid:process.pid});
        if(!['claimed','running'].includes(journal.state)||journal.workerPid!==process.pid||journal.leaseToken!==stored.token)throw purgeClaimError();
        return {changed:false,value:{lease:stored,journal,revision}};
      }
      if(journal.state!=='dispatch_reserved'||journal.workerPid!==null||journal.leaseToken!==null)throw purgeClaimError();
      const rows=statement("SELECT id,value FROM rows WHERE collection='operationLeases' ORDER BY id LIMIT 201").all(),
        runs=statement("SELECT json_extract(value,'$.ownerPid') AS ownerPid FROM rows WHERE collection='runs' AND json_extract(value,'$.status') IN ('queued','running') LIMIT 201").all();
      if(rows.length>200||runs.length>200||runs.some(hasLiveOwner))throw purgeClaimError();
      const dead=[];
      for(const row of rows){const value=JSON.parse(row.value);
        if(isProtectedPurgeLease({...value,operationId:row.id},journal)||hasLiveOwner(value))throw purgeClaimError();dead.push(row.id);}
      for(const id of dead){statement("DELETE FROM rows WHERE collection='operationLeases' AND id=?").run(id);metrics.rowsWritten++;}
      const lease={operationId:descriptor.leaseOperationId,kind:'permanent-delete',token:leaseToken,ownerPid:process.pid,
        targetRevisionId:null,profileRevisionId:null,createdAt,scope:null,packageIds:[descriptor.packageId],
        purgeClaim:Object.fromEntries(['taskId','packageId','generation','dispatchId'].map(key=>[key,descriptor[key]]))};
      assertPurgeLease(lease,descriptor,{workerPid:process.pid});
      if(typeof createdAt!=='string'||!Number.isFinite(Date.parse(createdAt)))throw purgeClaimError();
      writeRow({collection:'operationLeases',id:lease.operationId,value:lease,metadata:recordMetadata('operationLeases',lease.operationId,lease)},3);
      const topKeys=metaRaw('topKeys');if(!topKeys.includes('operationLeases'))writeMeta('topKeys',[...topKeys,'operationLeases']);
      const next={...journal,sequence:journal.sequence+1,state:'claimed',workerPid:process.pid,leaseToken:lease.token};
      return {changed:true,journal:next,value:{lease,journal:next},changes:[
        ...dead.map(id=>({collection:'operationLeases',id,action:'delete'})),{collection:'operationLeases',id:lease.operationId,action:'put'}]};
    });
  }
  function updatePurgeWorkerJournal(descriptor,{expectedSequence,state,stage,workerPid,leaseToken,allowDeadOwner=false}={}){
    assertPurgeDescriptor(descriptor);
    return coordinationTransaction(({journal})=>{
      if(!journal||!samePurgeDescriptor(journal.descriptor,descriptor)||journal.sequence!==expectedSequence)throw purgeClaimError();
      if(state==='running'){
        if(!maintenanceState||!['claimed','running'].includes(journal.state)||workerPid!==process.pid||journal.workerPid!==process.pid)throw purgeClaimError();
        assertPurgeLease(decode(rawRow('operationLeases',descriptor.leaseOperationId))?.value,descriptor,{workerPid:process.pid,token:leaseToken});
      }else if(state==='release_observed'){
        if(journal.state==='release_observed'&&!rawRow('operationLeases',descriptor.leaseOperationId)&&journal.leaseToken===leaseToken)
          return {changed:false,value:{journal}};
        if(!['claimed','running'].includes(journal.state))throw purgeClaimError();
        const lease=decode(rawRow('operationLeases',descriptor.leaseOperationId))?.value;
        assertPurgeLease(lease,descriptor,{workerPid:journal.workerPid,token:leaseToken});
        if(lease.ownerPid===process.pid){if(!maintenanceState||!samePurgeDescriptor(maintenanceState.descriptor,descriptor))throw purgeClaimError();}
        else if(!allowDeadOwner||hasLiveOwner(lease))throw purgeClaimError();
        if(allowDeadOwner&&(journal.publicationReceipt!==null||!['prepared','body'].includes(journal.stage)))throw purgeClaimError();
        statement("DELETE FROM rows WHERE collection='operationLeases' AND id=?").run(descriptor.leaseOperationId);metrics.rowsWritten++;
      }else if(state==='retired'){
        if(!['release_observed','dispatch_reserved'].includes(journal.state)||rawRow('operationLeases',descriptor.leaseOperationId))throw purgeClaimError();
      }else throw purgeClaimError();
      const next={...journal,sequence:journal.sequence+1,state,...(stage?{stage}:{})};assertPurgeJournal(next);
      return {changed:true,journal:next,value:{journal:next},changes:state==='release_observed'?
        [{collection:'operationLeases',id:descriptor.leaseOperationId,action:'delete'}]:[]};
    });
  }
  function assertPurgeInputBounds(limits){
    assertReady();
    const row=statement('SELECT count(*) AS n,coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM rows').get(),
      refs=statement('SELECT count(*) AS n FROM row_refs').get().n,parts=statement('SELECT count(*) AS n FROM row_parts').get().n;
    if(row.n>limits.sourceRows||row.bytes>limits.sourceBytes||refs>limits.references||parts>limits.parts)throw purgeClaimError('purge_input_limit');
    return {rows:row.n,bytes:row.bytes,references:refs,parts};
  }
  const purgeDataVersion=()=>Object.values(statement('PRAGMA data_version').get())[0];
  function exportPurgeWorkspaceSnapshot(limits={}){
    if(!maintenanceState)throw purgeClaimError();limits=purgeLimits(limits);assertPurgeInputBounds(limits);
    // SQLite's per-connection data_version also rejects another connection's
    // committed writes which failed to advance the application's revision.
    // https://sqlite.org/pragma.html#pragma_data_version
    const before=purgeDataVersion(),workspace=exportWorkspace(),after=purgeDataVersion();
    if(!safeInt(before)||before!==after)throw purgeClaimError('purge_state_changed');
    return {workspace,dataVersion:after};
  }
  const preparedPurgePlans=new WeakMap();
  function preparePurgeReplacement(workspace,{descriptor,leaseToken,expectedSequence,controlIdentity,sourceDataVersion,stage,asOf=Date.now(),limits={}}={}){
    assertReady();limits=purgeLimits(limits);
    if(!maintenanceState||!samePurgeDescriptor(maintenanceState.descriptor,descriptor)||!PURGE_REPLACEMENT_STAGES.includes(stage)||
      typeof controlIdentity!=='string'||!/^[a-f0-9]{64}$/.test(controlIdentity))throw purgeClaimError();
    const input=assertPurgeInputBounds(limits),journal=readPurgeWorkerJournal(),sourceRevision=metaRaw('revision');
    if(!journal||!samePurgeDescriptor(journal.descriptor,descriptor)||journal.state!=='running'||
      journal.sequence!==expectedSequence||journal.workerPid!==process.pid||journal.leaseToken!==leaseToken||workspace.revision!==sourceRevision||
      !safeInt(sourceDataVersion)||purgeDataVersion()!==sourceDataVersion)throw purgeClaimError();
    assertPurgeLease(decode(rawRow('operationLeases',descriptor.leaseOperationId))?.value,descriptor,{workerPid:process.pid,token:leaseToken});
    const flat=flattenWorkspace(workspace);
    if(flat.schemaVersion!==3)throw purgeClaimError();
    const rows=flat.rows.filter(row=>row.collection!=='operationLeases'),
      derived=[...buildWorkspaceJobReadModels(workspace,{asOf}),...buildCollectionProjectionRows(workspace,{asOf})];
    for(const row of derived)rows.push({collection:row.collection,id:row.id,value:row.value,
      metadata:recordMetadata(row.collection,row.id,row.value,row)});
    if(rows.length>limits.sourceRows||flat.parts.length>limits.parts)throw purgeClaimError('purge_input_limit');
    const identities=new Map();
    for(const row of rows){const key=rowKey(row.collection,row.id);if(identities.has(key))throw purgeClaimError();identities.set(key,row);}
    const packed=[],packageKeys=[],parts=[],references=[];let bytes=0;
    const count=tuple=>{bytes+=Buffer.byteLength(JSON.stringify(tuple));if(bytes>limits.packedBytes)throw purgeClaimError('purge_input_limit');return Object.freeze(tuple);};
    const hasRow=(collection,id)=>identities.has(rowKey(collection,id));
    for(const row of rows){
      validateRowForWrite(row,3);
      if(row.metadata.parentId&&!hasRow(row.metadata.parentCollection,row.metadata.parentId))throw purgeClaimError();
      if(row.metadata.ownerPackageId&&!hasRow('packages',row.metadata.ownerPackageId))throw purgeClaimError();
      const value=encode(row.value);packed.push(count([row.collection,row.id,value,...metadataNames.map(key=>row.metadata[key]??null)]));
      if(row.collection==='packages')packageKeys.push(count([row.id,row.value.kind,row.value.versionId,versionNameKey(row.value.versionName),row.value.state]));
      for(const ref of referenceRows(row,{hasRow})){
        const target=identities.get(rowKey(ref.collection,ref.id));
        if(!target||row.metadata.ownerPackageId&&target.metadata.ownerPackageId!==row.metadata.ownerPackageId)throw purgeClaimError();
        references.push(count([row.collection,row.id,ref.field,ref.collection,ref.id,row.metadata.ownerPackageId]));
        if(references.length>limits.references)throw purgeClaimError('purge_input_limit');
      }
    }
    for(const part of flat.parts)parts.push(count([part.collection,part.id,part.path,part.childCollection,part.shape]));
    const topKeys=encode(flat.topKeys);bytes+=Buffer.byteLength(topKeys);if(bytes>limits.packedBytes)throw purgeClaimError('purge_input_limit');
    const token=Object.freeze(Object.create(null));
    assertExistingDatabasePathSync(existingMaintenanceBinding);
    preparedPurgePlans.set(token,Object.freeze({descriptor:Object.freeze(clone(descriptor)),leaseToken,expectedSequence,controlIdentity,
      stage,sourceRevision,sourceDataVersion,input:Object.freeze(input),packed:Object.freeze(packed),packageKeys:Object.freeze(packageKeys),
      parts:Object.freeze(parts),references:Object.freeze(references),topKeys,bytes,limits}));
    return token;
  }
  function publishPreparedPurgeReplacement(token,{controlIdentity}={}){
    assertReady();const plan=preparedPurgePlans.get(token);preparedPurgePlans.delete(token);
    if(!plan||!maintenanceState||controlIdentity!==plan.controlIdentity)throw purgeClaimError('purge_state_changed');
    assertExistingDatabasePathSync(existingMaintenanceBinding);
    const verify=()=>{
      const journal=readPurgeWorkerJournal(),revision=metaRaw('revision');
      if(revision!==plan.sourceRevision||purgeDataVersion()!==plan.sourceDataVersion||!journal||!samePurgeDescriptor(journal.descriptor,plan.descriptor)||journal.state!=='running'||
        journal.sequence!==plan.expectedSequence||journal.workerPid!==process.pid||journal.leaseToken!==plan.leaseToken||
        metaRaw('schemaVersion')!==3||metaRaw('storeVersion')!==SQLITE_STORE_VERSION||metaRaw('jobReadModelVersion')!==JOB_READ_MODEL_VERSION||
        metaRaw('collectionProjectionVersion')!==COLLECTION_PROJECTION_VERSION)throw purgeClaimError('purge_state_changed');
      assertPurgeLease(decode(rawRow('operationLeases',plan.descriptor.leaseOperationId))?.value,plan.descriptor,{workerPid:process.pid,token:plan.leaseToken});
      return {journal,revision};
    };
    verify();operation=true;let committed=false;
    try{
      db.exec('BEGIN IMMEDIATE');metrics.transactions++;const {journal,revision}=verify(),nextRevision=revision+1;
      if(!safeInt(nextRevision))throw purgeClaimError();
      invokeGuard({phase:'replace',schemaVersion:3,ownerPackageIds:[plan.descriptor.packageId],recordIds:[]});
      faultInjector&&syncResult(faultInjector('beforeImport',{replace:true,prepared:true}));
      db.exec("DELETE FROM row_refs WHERE collection<>'operationLeases'; DELETE FROM row_parts WHERE collection<>'operationLeases'; DELETE FROM rows WHERE collection<>'operationLeases'; DELETE FROM package_keys;");
      for(const tuple of plan.packageKeys)statement('INSERT INTO package_keys(id,kind,version_id,name_key,state) VALUES (?,?,?,?,?)').run(...tuple);
      for(const tuple of plan.packed){statement(writeRowSql).run(...tuple);metrics.rowsWritten++;}
      for(const tuple of plan.parts)statement('INSERT INTO row_parts VALUES (?,?,?,?,?) ON CONFLICT(collection,id,path) DO NOTHING').run(...tuple);
      for(const tuple of plan.references)statement('INSERT INTO row_refs VALUES (?,?,?,?,?,?)').run(...tuple);
      // Business JSON is already final SQL text. Never stringify or rebuild it
      // while holding this publication fence. Coordination rows remain in place.
      statement('UPDATE store_meta SET value=? WHERE key=?').run(plan.topKeys,'topKeys');
      const publicationReceipt={stage:plan.stage,baseRevision:revision,committedRevision:nextRevision},
        next={...journal,sequence:journal.sequence+1,stage:plan.stage,publicationReceipt};
      writeMeta(PURGE_WORKER_JOURNAL,next);writeMeta('revision',nextRevision);
      statement('INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES (?,?,?,?,?,?)')
        .run(nextRevision,'workspace','*',null,'maintenance','replace');
      faultInjector&&syncResult(faultInjector('beforeCommit',{revision:nextRevision}));
      db.exec('COMMIT');committed=true;metrics.commits++;metrics.maintenanceImports++;
      try{assertExistingDatabasePathSync(existingMaintenanceBinding);faultInjector&&syncResult(faultInjector('afterCommit',{revision:nextRevision}));}
      catch(cause){throw Object.assign(rowStoreError('sqlite_post_commit','Prepared purge publication committed; reporting failed.',cause),
        {committed:true,revision:nextRevision,publicationReceipt});}
      return {revision:nextRevision,journal:clone(next),publicationReceipt,rows:plan.packed.length};
    }catch(error){if(!committed&&db.isTransaction){db.exec('ROLLBACK');metrics.rollbacks++;}throw normalizeError(error);}
    finally{operation=false;}
  }
  const api = {
    filename,
    getMeta(key) { assertReady(true); validateMetaKey(key); return clone(metaRaw(key)); },
    getRow(input) {
      assertReady(); const s = validateSelector({ collection:input.collection, ids:[input.id], ...(input.ownerPackageId !== undefined ? {ownerPackageId:input.ownerPackageId} : {}),total:false });
      invokeGuard({phase:'read',ownerPackageIds:s.ownerPackageId ? [s.ownerPackageId] : []});
      return clone(selectRows(s).records[0]?.value ?? null);
    },
    getRecord(input) {
      assertReady(); const s = validateSelector({collection:input.collection,ids:[input.id],...(input.ownerPackageId !== undefined ? {ownerPackageId:input.ownerPackageId} : {}),total:false});
      invokeGuard({phase:'read',ownerPackageIds:s.ownerPackageId ? [s.ownerPackageId] : []});
      const row = selectRows(s).records[0]; return row ? {id:row.id,value:clone(row.value),indexes:clone(row.metadata)} : null;
    },
    readView(selection) {
      assertReady(); invokeGuard({phase:'read',ownerPackageIds:selection.select?.flatMap(s => s.ownerPackageIds || (s.ownerPackageId ? [s.ownerPackageId] : [])) || []});
      return readConsistent(() => buildView(selection).value);
    },
    queryRows(input) {
      assertReady(); return readConsistent(() => { const result = selectRows(input); invokeGuard({phase:'read',ownerPackageIds:[...new Set(result.records.map(r => r.metadata.ownerPackageId).filter(Boolean))]});
        return { rows:result.records.map(r => ({id:r.id,value:clone(r.value),indexes:clone(r.metadata)})),total:result.total,hasMore:result.hasMore,nextCursor:result.nextCursor }; });
    },
    queryIds(input) {
      assertReady(); return readConsistent(() => {
        const s=validateSelector(input),q=sqlSelection(s),direction=s.direction === 'desc' ? 'DESC' : 'ASC',order=QUERY_FIELDS[s.orderBy || 'id'];
        invokeGuard({phase:'read',ownerPackageIds:s.ownerPackageIds || (s.ownerPackageId ? [s.ownerPackageId] : [])});
        const raw=statement(`SELECT id FROM rows WHERE ${q.where} ORDER BY ${order} ${direction},id ${direction} LIMIT ? OFFSET ?`).all(...q.bindings,s.limit+1,s.offset);
        const hasMore=raw.length>s.limit;if(hasMore)raw.pop();metrics.rowsRead+=raw.length;
        const total=s.total === false ? undefined : statement(`SELECT count(*) AS n FROM rows WHERE ${q.where}`).get(...q.bindings).n;
        return {ids:raw.map(r=>r.id),total,hasMore,nextCursor:hasMore && !s.orderBy && s.direction !== 'desc' ? raw.at(-1)?.id ?? null : null};
      });
    },
    aggregateRows({collection,ownerPackageId,ownerPackageIds,where,groupBy,operation:aggregate='count',field,limit=MAX_PAGE}) {
      assertReady(); const s=validateSelector({collection,...(ownerPackageId ? {ownerPackageId} : {}),...(ownerPackageIds ? {ownerPackageIds} : {}),where,limit}),q=sqlSelection(s);
      if (!['count','sum','min','max'].includes(aggregate) || (aggregate !== 'count' && !['score','ordinal','seq'].includes(field)) || (groupBy && !Object.hasOwn(QUERY_FIELDS,groupBy)))
        throw rowStoreError('sqlite_selection_invalid','Unknown fixed aggregate.');
      invokeGuard({phase:'read',ownerPackageIds:ownerPackageIds || (ownerPackageId ? [ownerPackageId] : [])});
      const group=groupBy ? QUERY_FIELDS[groupBy] : null,expression=aggregate === 'count' ? 'count(*)' : `${aggregate}(${QUERY_FIELDS[field]})`;
      const values=statement(`SELECT ${group ? `${group} AS key,` : ''}${expression} AS value FROM rows WHERE ${q.where}${group ? ` GROUP BY ${group} ORDER BY ${group}` : ''} LIMIT ?`).all(...q.bindings,limit+1);
      const hasMore=values.length>limit;if(hasMore)values.pop();metrics.rowsRead+=values.length;return {groups:values.map(v=>({...v})),hasMore};
    },
    scanRows(input) {
      assertReady(true); const result = selectRows({...input,total:false},{maintenance:true}); invokeGuard({phase:'maintenance_read',ownerPackageIds:[...new Set(result.records.map(r => r.metadata.ownerPackageId).filter(Boolean))]});
      return {rows:result.records.map(r => ({id:r.id,value:clone(r.value),routing:routingOf(r)})),hasMore:result.hasMore,nextCursor:result.nextCursor};
    },
    transaction, exportWorkspace, importWorkspace, rebuildReadModels,
    readPurgeWorkerJournal,reservePurgeWorkerJournal,updatePurgeWorkerJournal,
    ...(maintenanceState?{acquirePurgeWorkerLease,preparePurgeReplacement,publishPreparedPurgeReplacement,assertPurgeInputBounds,exportPurgeWorkspaceSnapshot}:{}),
    exportPackage(packageId){
      assertReady();if(typeof packageId!=='string'||!packageId)throw rowStoreError('sqlite_scope_required','Package export requires one owner.');
      return readConsistent(()=>{
        const records=statement("SELECT * FROM rows WHERE owner_id=? OR (collection='packages' AND id=?) OR (collection IN ('profileGroups','targetGroups','aliasGroups') AND id IN (SELECT parent_id FROM rows WHERE owner_id=?)) ORDER BY collection,id").all(packageId,packageId,packageId).map(decode);
        const parts=statement('SELECT p.collection,p.id,p.path,p.child_collection AS childCollection,p.shape FROM row_parts p JOIN rows r ON r.collection=p.collection AND r.id=p.id WHERE r.owner_id=? OR (r.collection=\'packages\' AND r.id=?)').all(packageId,packageId);
        const keys=[...Object.keys(createEmptyWorkspace()),'versionMetadata','targetMembers','jobRedirects'];
        const value=inflateWorkspace(records,parts,{schemaVersion:3,revision:metaRaw('revision'),topKeys:keys});
        assertWorkspace(value);return clone(value);
      });
    },
    readOperationState({limit=200}={}) {
      assertReady();if(!safeInt(limit,1)||limit>200)throw rowStoreError('sqlite_selection_invalid','Operation state is bounded.');
      return readConsistent(()=>{
        const leases=statement("SELECT id,value FROM rows WHERE collection='operationLeases' ORDER BY id LIMIT ?").all(limit+1);
        const runs=statement("SELECT id AS runId,owner_id AS ownerPackageId,target_revision_id AS targetRevisionId,json_extract(value,'$.ownerPid') AS ownerPid,json_extract(value,'$.status') AS status FROM rows WHERE collection='runs' AND json_extract(value,'$.status') IN ('queued','running') ORDER BY id LIMIT ?").all(limit+1);
        const hasMore=leases.length>limit||runs.length>limit;if(leases.length>limit)leases.pop();if(runs.length>limit)runs.pop();
        metrics.rowsRead+=leases.length+runs.length;
        for(const lease of leases){metrics.decodedRows++;metrics.decodedBytes+=Buffer.byteLength(lease.value);}
        // Historical ordinary leases may omit their JSON operationId: the map
        // key remains their authority. Derive that missing field only in this
        // read projection, never repair the stored row or mask an explicit
        // conflict. Raw maintenance claim validation remains strict.
        const values=leases.map(row=>{
          const value=JSON.parse(row.value);
          if(!plain(value)||Object.hasOwn(value,'operationId')&&value.operationId!==row.id)throw purgeClaimError();
          return Object.hasOwn(value,'operationId')?value:{...value,operationId:row.id};
        });
        return {leases:values,runs:runs.map(row=>({...row})),hasMore};
      });
    },
    replaceWorkspace: (workspace, options = {}) => importWorkspace(workspace,{...options,replace:true}),
    readChanges({afterSeq = 0,ownerPackageId,limit = MAX_PAGE} = {}) {
      assertReady(); if (!safeInt(afterSeq) || !safeInt(limit,1) || limit > MAX_PAGE) throw rowStoreError('sqlite_selection_invalid','Invalid bounded change cursor.');
      return readConsistent(()=>{
      const raw = statement(`SELECT seq,revision,collection,id,owner_id AS ownerPackageId,topic,action FROM changes
        WHERE seq>?${ownerPackageId ? ' AND (owner_id=? OR owner_id IS NULL)' : ''} ORDER BY seq LIMIT ?`).all(...(ownerPackageId ? [afterSeq,ownerPackageId,limit] : [afterSeq,limit]));
      const head = statement('SELECT coalesce(max(seq),0) AS seq FROM changes').get().seq;
      metrics.rowsRead+=raw.length+1;
      return {changes:clone(raw),head,nextCursor:raw.at(-1)?.seq ?? afterSeq};
      });
    },
    metrics({reset = false} = {}) { const value = {...clone(metrics),cachedStatements:statementCache.size,statementCacheLimit}; if (reset) for (const key of Object.keys(metrics)) metrics[key] = 0; return value; },
    pragmas() { assertOpen(); return Object.fromEntries(['journal_mode','synchronous','foreign_keys','secure_delete'].map(key => [key,Object.values(statement(`PRAGMA ${key}`).get())[0]])); },
    integrityCheck() { assertOpen(); return {integrity:statement('PRAGMA integrity_check').all().map(r => r.integrity_check),foreignKeys:statement('PRAGMA foreign_key_check').all().map(r => ({...r}))}; },
    checkpoint() { assertOpen(); if (operation) throw rowStoreError('sqlite_nested_transaction','Checkpoint requires an idle connection.'); const r = statement('PRAGMA wal_checkpoint(TRUNCATE)').get(); return {busy:r.busy,log:r.log,checkpointed:r.checkpointed,complete:r.busy === 0}; },
    compact() {
      assertOpen(); if (operation) throw rowStoreError('sqlite_nested_transaction','Compaction requires an idle connection.');
      const before = api.checkpoint(); if (!before.complete) return {complete:false,busy:true,phase:'checkpoint',checkpoint:before};
      try { db.exec('VACUUM'); } catch (error) { const e = normalizeError(error); if (e.code === 'sqlite_busy') return {complete:false,busy:true,phase:'vacuum'}; throw e; }
      const after = api.checkpoint(); return {complete:after.complete,busy:!after.complete,phase:'complete',checkpoint:after};
    },
    async backup(destination) {
      assertOpen(); if (operation || typeof destination !== 'string' || !destination || path.resolve(destination) === path.resolve(filename))
        throw rowStoreError('sqlite_backup_invalid','An idle connection and a separate backup destination are required.');
      operation=true;
      try {const pages = await sqliteBackup(db,destination); return {pages,destination};}
      finally {operation=false;}
    },
    close() { if (closed) return; if (operation) throw rowStoreError('sqlite_busy','Cannot close an active storage operation.'); statementCache.clear();db.close(); closed = true; },
  };
  const recoveryQueries=createSqliteRecoveryQueries({statement,countRows:n=>{metrics.rowsRead+=n;}});
  for(const method of ['queryRecoveryRunHeads','queryRecoveryRecordKeys'])api[method]=(input={})=>{
    assertReady();return readConsistent(()=>clone(recoveryQueries[method](input)));
  };
  const purgeQueries=createSqlitePurgeQueries({statement,countRows:n=>{metrics.rowsRead+=n;}});
  api.assertPurgePlanningIdentity=()=>{
    assertReady();const started=performance.now();metrics.purgeIdentityGuardStatements++;
    try{return readConsistent(()=>purgeQueries.assertPurgePlanningIdentity());}
    finally{metrics.purgeIdentityGuardMs+=performance.now()-started;}
  };
  api.queryPurgePlanningPage=(input,control)=>{
    assertReady();return readConsistent(()=>clone(purgeQueries.queryPurgePlanningPage(input,control)));
  };
  api.countPurgePlanningRecords=(packageId,control)=>{
    assertReady();return readConsistent(()=>clone(purgeQueries.countPurgePlanningRecords(packageId,control)));
  };
  api.readPurgeLeaseRevision=operationId=>{
    assertReady();return readConsistent(()=>purgeQueries.readPurgeLeaseRevision(operationId));
  };
  const jobQueries=createSqliteJobQueries({db,statement,countRows:n=>{metrics.rowsRead+=n;}});
  for(const method of ['queryJobPage','queryApplicationPage','findJobIdentityCandidates','queryJobQuality','readJobBodySignatures','readJobHead','queryJobRelatedPage'])api[method]=(input,options={})=>{
    assertReady();return readConsistent(()=>{
      if(metaRaw('jobReadModelVersion')!==JOB_READ_MODEL_VERSION)throw rowStoreError('job_projection_not_ready','Job read models require explicit maintenance.');
      const owner=options.scope?.packageId||input?.ownerPackageId;
      invokeGuard({phase:'read',ownerPackageIds:owner?[owner]:[]});
      return clone(jobQueries[method](input,options));
    });
  };
  const collectionQueries=createSqliteCollectionQueries({db,statement,countRows:n=>{metrics.rowsRead+=n;},countDecoded:raw=>{metrics.decodedRows++;metrics.decodedBytes+=Buffer.byteLength(raw);}});
  for(const method of ['queryCollectionSnapshot','queryRunHeads','queryCollectionSlicePage'])api[method]=(input={})=>{
    assertReady();return readConsistent(()=>{
      if(metaRaw('jobReadModelVersion')!==JOB_READ_MODEL_VERSION||metaRaw('collectionProjectionVersion')!==COLLECTION_PROJECTION_VERSION)throw rowStoreError('collection_projection_not_ready','Collection read models require explicit maintenance.');
      const owner=input.scope?.packageId;
      invokeGuard({phase:'read',ownerPackageIds:owner?[owner]:[]});
      return clone(collectionQueries[method](input));
    });
  };
  const legacyQueries=createSqliteLegacyQueries({db,statement,countRows:n=>{metrics.rowsRead+=n;}});
  for(const method of ['discoverLegacyOwners','queryLegacyApplicationPage','queryLegacyTrackingSummary','queryLegacyTrackingPage','queryLegacyRunTargets','findLegacyApplicationIds','queryDiagnosticRunScopes'])api[method]=(input={},options={})=>{
    assertReady();return readConsistent(()=>{
      invokeGuard({phase:'read',ownerPackageIds:options.scope?.packageId?[options.scope.packageId]:input.ownerPackageId?[input.ownerPackageId]:[]});
      return clone(legacyQueries[method](input,options));
    });
  };
  function readConsistent(action) {
    operation=true;
    try {db.exec('BEGIN');const value=action();db.exec('COMMIT');return value;}
    catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw normalizeError(error);}
    finally {operation=false;}
  }
  return Object.freeze(api);
}
