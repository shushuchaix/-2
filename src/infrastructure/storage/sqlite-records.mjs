import { assertWorkspace, createEmptyWorkspace } from '../../domain/contracts.mjs';
import { UUID_RE, PACKAGE_KINDS, PACKAGE_STATES } from '../../domain/packages.mjs';
import { assertCollectionSettings } from '../../domain/collection.mjs';
import { versionNameKey } from '../../domain/workspace-management.mjs';
import { PRIVATE_COLLECTIONS, SQLITE_COLLECTIONS } from './sqlite-schema.mjs';

export const rowKey = (...parts) => JSON.stringify(parts);
export const rowStoreError = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });
export const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
export const defineOwn = (object, key, value) => Object.defineProperty(object, key,
  {value,enumerable:true,writable:true,configurable:true});
export function assertJson(value, depth = 0) {
  if (depth > 80) throw rowStoreError('sqlite_invalid_json', 'JSON nesting exceeds the storage limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (Array.isArray(value)) {
    const keys=Reflect.ownKeys(value),enumerable=Object.keys(value);
    if(keys.length!==value.length+1 || enumerable.length!==value.length ||
      enumerable.some((key,index)=>key!==String(index)))
      throw rowStoreError('sqlite_invalid_json','Sparse arrays and non-JSON array properties are not stored.');
  } else if (!plain(value)) throw rowStoreError('sqlite_invalid_json', 'Only lossless JSON values can be stored.');
  const dataKeys=Reflect.ownKeys(value).filter(key=>!(Array.isArray(value)&&key==='length'));
  for(const key of dataKeys){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))
      throw rowStoreError('sqlite_invalid_json','Symbols, accessors and hidden properties are not lossless JSON.');
  }
  for (const entry of Object.values(value)) assertJson(entry, depth + 1);
}
const identityFields = {
  profiles: 'revisionId', targets: 'revisionId', profileCopies: 'revisionId',
  jobs: 'jobId', observations: 'observationId', evaluations: 'evaluationId',
  applications: 'applicationId', runs: 'runId',
};
const recordCollections = new Set(['profiles', 'targets', 'profileCopies', 'jobs', 'observations',
  'evaluations', 'applications', 'runs', 'events', 'files', 'runEvents', 'applicationEvents']);
export function validateRecord(collection, id, value, { schemaVersion, ownerPackageId } = {}) {
  if (!SQLITE_COLLECTIONS.includes(collection)) throw rowStoreError('sqlite_collection_invalid', 'Unknown collection.');
  if (typeof id !== 'string' || !id.length || id.length > 4096) throw rowStoreError('sqlite_id_invalid', 'Invalid row identity.');
  assertJson(value);
  if (schemaVersion === 3 && PRIVATE_COLLECTIONS.has(collection) && !UUID_RE.test(ownerPackageId || ''))
    throw rowStoreError('sqlite_owner_required', 'A private row requires an owner package.');
  if (plain(value) && value.ownerPackageId !== undefined && value.ownerPackageId !== ownerPackageId)
    throw rowStoreError('sqlite_owner_mismatch', 'Row ownership differs from its stored identity.');
  if (schemaVersion === 3 && (recordCollections.has(collection) || (collection === 'recoveryRecords' && ownerPackageId)) && (!plain(value) || !UUID_RE.test(value.recordId || '')))
    throw rowStoreError('sqlite_record_identity', 'A private entity requires a stable recordId.');
  if (identityFields[collection] && !(schemaVersion === 2 && collection === 'applications') && value[identityFields[collection]] !== id)
    throw rowStoreError('sqlite_record_identity', 'Record identity differs from its row key.');
  if (collection === 'jobs') {
    // Reuse the existing sparse historical canonical policy on one bounded row.
    const w = createEmptyWorkspace({ schemaVersion: 2 }); w.jobs[id] = value; assertWorkspace(w);
  }
  if (collection === 'packages') {
    if (!plain(value) || value.packageId !== id || !UUID_RE.test(id) ||
      !PACKAGE_KINDS.includes(value.kind) || !PACKAGE_STATES.includes(value.state) ||
      typeof value.versionId !== 'string' || typeof value.versionName !== 'string' || typeof value.enabled !== 'boolean')
      throw rowStoreError('sqlite_package_invalid', 'Invalid package identity or state.');
    if (value.state === 'active' && [value.archiveId, value.archivedAt, value.purgeAt].some(v => v !== null))
      throw rowStoreError('sqlite_package_invalid', 'Active package retains archive metadata.');
    if (['trashed', 'purge_pending'].includes(value.state) && (!UUID_RE.test(value.archiveId || '') ||
      !Number.isFinite(Date.parse(value.archivedAt)) || !Number.isFinite(Date.parse(value.purgeAt))))
      throw rowStoreError('sqlite_package_invalid', 'Invalid package archive metadata.');
    assertCollectionSettings(value.collectionSettings);
  }
  if (collection === 'versionMetadata' && (typeof value.versionName !== 'string' ||
    value.nameKey !== versionNameKey(value.versionName) || !['profile', 'target'].includes(value.kind)))
    throw rowStoreError('sqlite_version_name_invalid', 'Invalid normalized version name.');
  if (collection === 'reservations' && (!plain(value) || typeof value.reservationId !== 'string' ||
    !['reserved', 'settled', 'uncertain'].includes(value.status)))
    throw rowStoreError('sqlite_reservation_invalid', 'Invalid reservation row.');
}

const str = v => typeof v === 'string' ? v : null;
export function recordMetadata(collection, id, value, routing = {}) {
  const v = plain(value) ? value : {}, f = v.canonical || v.fields || v.record || v;
  const parent = routing.parent ?? (['profiles','targets'].includes(collection) ? {
    collection:collection === 'profiles' ? 'profileGroups' : 'targetGroups',
    id:v[collection === 'profiles' ? 'profileId' : 'targetId'],path:collection,
  } : null);
  const runId = v.runId || routing.runId || (routing.parent?.collection === 'runs' ? routing.parent.id : null);
  return {
    ownerPackageId: routing.ownerPackageId ?? v.ownerPackageId ?? null,
    recordId: recordCollections.has(collection) || (collection === 'recoveryRecords' && (routing.ownerPackageId || v.ownerPackageId)) ? v.recordId ?? null : null,
    parentCollection: parent?.collection ?? null, parentId: parent?.id ?? null,
    path: parent?.path ?? null, ordinal: routing.ordinal ?? 0,
    jobId: str(collection==='activityJobIds'&&typeof value==='string'?value:v.jobId ?? routing.jobId), runId: str(runId),
    targetRevisionId: str(v.targetRevisionId ?? v.targetSnapshot?.revisionId ?? routing.targetRevisionId),
    profileRevisionId: str(v.profileRevisionId ?? routing.profileRevisionId),
    observationId: str(v.observationId), factContentHash: str(v.factContentHash),
    ruleVersion: str(v.ruleVersion), status: str(collection==='packages'?v.state:v.collectionRole === 'collection_root' ? v.collectionProgress?.status : v.status),
    kind: str(collection==='jobRedirects'?'job_redirect':v.kind ?? v.collectionRole), nextDueAt: str(v.nextDueAt), resourceKey: str(collection==='jobRedirects'?v.toJobId:collection==='runEvaluationIds'&&typeof value==='string'?value:v.resourceKey),
    checkedAt: str(v.checkedAt), sortAt: str(v.observedAt ?? v.createdAt ?? v.lastSeen ?? f.publishedAt),
    title: str(f.title), company: str(f.company), jobType: str(f.jobType),
    score: typeof v.score === 'number' && Number.isFinite(v.score) ? v.score : null,
    recommendation: str(v.recommendation), openingStatus: str(v.openingStatus ?? f.openingStatus),
    applicationStatus: str(v.applicationStatus ?? f.applicationStatus), sourceId: str(f.sourceId),
    siteId: str(f.siteId), seq: Number.isSafeInteger(v.seq) && v.seq >= 0 ? v.seq : null,
    nameKey: str(v.nameKey),
  };
}

// These parts are independent records; hot root reads never parse their bodies.
export const SPLIT_PARTS = Object.freeze({
  packages: [['collectionCache', 'conditionalCache', 'map']],
  targets: [['profileSnapshot', 'profileCopies', 'value']],
  applications: [['events', 'applicationEvents', 'array']],
  runs: [
    ['events', 'runEvents', 'array'], ['targetSnapshot', 'runSnapshots', 'value'],
    ['profileSnapshot', 'runSnapshots', 'value'], ['coverage', 'runCoverage', 'array'],
    ['issues', 'runIssues', 'array'], ['evaluationIds', 'runEvaluationIds', 'array'],
    ['collectionProgress.units', 'activityUnits', 'map'],
    ['collectionProgress.ledger.reservations', 'reservations', 'map'],
    ['collectionProgress.ledger.usage', 'activityUsage', 'map'],
    ['collectionProgress.pendingBodies', 'contentBodies', 'map'],
    ['collectionProgress.pendingArticles', 'contentArticles', 'map'],
    ['collectionProgress.articleCache', 'articleCache', 'map'],
    ['collectionProgress.pendingOfficialLinks', 'contentLinks', 'map'],
    ['collectionProgress.officialLinkCache', 'officialLinkCache', 'map'],
    ['collectionProgress.newJobIds', 'activityJobIds', 'array'],
    ['jobIds', 'activityJobIds', 'array'],
  ],
});
export function hasPath(value, dotted) {
  const keys = dotted.split('.'); let current = value;
  for (const key of keys) { if (!plain(current) || !Object.hasOwn(current, key)) return false; current = current[key]; }
  return true;
}
export function pathValue(value, dotted) { return dotted.split('.').reduce((v, key) => v?.[key], value); }
export function setPath(value, dotted, next) {
  const keys = dotted.split('.'); let current = value;
  for (const key of keys.slice(0, -1)) {
    if (!plain(current[key])) Object.defineProperty(current, key, { value: {}, writable: true, enumerable: true, configurable: true });
    current = current[key];
  }
  Object.defineProperty(current, keys.at(-1), { value: next, writable: true, enumerable: true, configurable: true });
}
export function deletePath(value, dotted) {
  const keys = dotted.split('.'), parent = keys.slice(0, -1).reduce((v, key) => v?.[key], value);
  if (parent) delete parent[keys.at(-1)];
}
const directMaps = ['packages', 'jobs', 'observations', 'evaluations', 'applications', 'runs', 'events',
  'files', 'sourceHealth', 'duplicateGroups', 'jobRedirects', 'versionMetadata', 'versionSubmissions',
  'dedupOperations', 'operationLeases'];
const structuredKeys = new Set([...directMaps, 'profiles', 'targets', 'targetMembers', 'identityAliases',
  'recoveryRecords', 'versionCounters', 'settings', 'schemaVersion', 'revision']);

/** Full conversion is used only by explicit import/export maintenance. */
export function flattenWorkspace(workspace) {
  assertJson(workspace); assertWorkspace(workspace);
  const rows = [], parts = [];
  const owners = new Map(Object.entries(workspace.jobs).map(([id, v]) => [id, v.ownerPackageId]));
  const revisions = new Map();
  for (const key of ['profiles', 'targets']) for (const list of Object.values(workspace[key]))
    for (const v of list) revisions.set(v.revisionId, v.ownerPackageId);
  const add = (collection, id, original, routing = {}) => {
    const value = structuredClone(original), metadata = recordMetadata(collection, id, original, routing);
    const owner = metadata.ownerPackageId;
    for (const [partPath, childCollection, shape] of SPLIT_PARTS[collection] || []) {
      if (!hasPath(value, partPath)) continue;
      const child = pathValue(value, partPath);
      // Null/unknown historical representations stay intact; there is no lossy coercion.
      if ((shape === 'map' && !plain(child)) || (shape === 'array' && !Array.isArray(child)) ||
        (shape === 'value' && !plain(child))) continue;
      parts.push({ collection, id, path: partPath, childCollection, shape });
      const entries = shape === 'value' ? [['value', child]] : Object.entries(child);
      for (const [index, [childId, childValue]] of entries.entries()) {
        const key = childCollection === 'profileCopies' ? childValue.revisionId : rowKey(id, partPath, childId);
        add(childCollection, key, childValue, {
          ownerPackageId: owner ?? (collection === 'packages' ? id : null),
          parent: { collection, id, path: partPath }, ordinal: index,
          targetRevisionId: metadata.targetRevisionId,
          runId: collection === 'runs' ? id : routing.runId,
        });
      }
      deletePath(value, partPath);
    }
    rows.push({ collection, id, value, metadata });
  };
  for (const key of directMaps) for (const [id, v] of Object.entries(workspace[key] || {}))
    add(key, id, v, { ownerPackageId: v.ownerPackageId ?? revisions.get(id) ??
      (key === 'duplicateGroups' ? owners.get(v.jobIds?.[0]) : undefined) ?? null });
  for (const key of ['profiles', 'targets']) for (const [parentId, list] of Object.entries(workspace[key])) {
    add(key === 'profiles' ? 'profileGroups' : 'targetGroups', parentId, {});
    list.forEach((v, ordinal) => add(key, v.revisionId, v, { ordinal, parent: { collection: key === 'profiles' ? 'profileGroups' : 'targetGroups', id: parentId, path: key } }));
  }
  for (const [revisionId, members] of Object.entries(workspace.targetMembers || {})) {
    add('memberGroups', revisionId, {}, { ownerPackageId: revisions.get(revisionId), targetRevisionId: revisionId });
    for (const [jobId, member] of Object.entries(members)) add('targetMembers', rowKey(revisionId, jobId), member,
      { ownerPackageId: revisions.get(revisionId), targetRevisionId: revisionId, jobId,
        parent: { collection: 'memberGroups', id: revisionId, path: 'targetMembers' } });
  }
  for (const [alias, ids] of Object.entries(workspace.identityAliases || {})) {
    add('aliasGroups', alias, {});
    ids.forEach((id, ordinal) => add('identityAliasLinks', rowKey(alias, ordinal), id,
      { ordinal, jobId: id, ownerPackageId: owners.get(id) ?? workspace.jobRedirects?.[id]?.ownerPackageId,
        parent: { collection: 'aliasGroups', id: alias, path: 'identityAliases' } }));
  }
  for (const [kind, counters] of Object.entries(workspace.versionCounters || {})) {
    add('workspaceFields', rowKey('counterKind', kind), { kind, empty: Object.keys(counters).length === 0 });
    for (const [parentId, value] of Object.entries(counters)) add('versionCounters', rowKey(kind, parentId), value);
  }
  (workspace.recoveryRecords || []).forEach((v, ordinal) => add('recoveryRecords', String(ordinal), v, { ordinal, ownerPackageId: v.ownerPackageId ?? null }));
  for (const [id, v] of Object.entries(workspace.settings || {})) add('settings', id, v);
  for (const [key, value] of Object.entries(workspace)) if (!structuredKeys.has(key)) add('workspaceFields', rowKey('extension', key), value);
  return { rows, parts, schemaVersion: workspace.schemaVersion, revision: workspace.revision,
    topKeys: Object.keys(workspace) };
}

export function inflateWorkspace(records, parts, { schemaVersion, revision, topKeys }) {
  const byCollection = new Map();
  for (const row of records) {
    const group = byCollection.get(row.collection) || new Map(); group.set(row.id, row); byCollection.set(row.collection, group);
  }
  const all = name => [...(byCollection.get(name)?.values() || [])].sort((a, b) => a.metadata.ordinal - b.metadata.ordinal || a.id.localeCompare(b.id));
  const values = new Map(records.map(r => [rowKey(r.collection, r.id), structuredClone(r.value)]));
  for (const part of parts) {
    const parent = values.get(rowKey(part.collection, part.id));
    if (!parent) continue;
    const children = all(part.childCollection).filter(r => r.metadata.parentCollection === part.collection && r.metadata.parentId === part.id && r.metadata.path === part.path);
    let value;
    if (part.shape === 'value') value = children.length ? values.get(rowKey(part.childCollection, children[0].id)) : null;
    else if (part.shape === 'array') value = children.map(r => values.get(rowKey(part.childCollection, r.id)));
    else value = Object.fromEntries(children.map(r => [JSON.parse(r.id).at(-1), values.get(rowKey(part.childCollection, r.id))]));
    setPath(parent, part.path, value);
  }
  const result = {};
  for (const key of topKeys) {
    if (key === 'schemaVersion') defineOwn(result,key,schemaVersion);
    else if (key === 'revision') defineOwn(result,key,revision);
    else if (directMaps.includes(key)) defineOwn(result,key,Object.fromEntries(all(key).map(r => [r.id, values.get(rowKey(key, r.id))])));
    else if (['profiles', 'targets'].includes(key)) defineOwn(result,key,Object.fromEntries(all(key === 'profiles' ? 'profileGroups' : 'targetGroups').map(group => [group.id,
      all(key).filter(r => r.metadata.parentId === group.id).map(r => values.get(rowKey(key, r.id)))])));
    else if (key === 'targetMembers') defineOwn(result,key,Object.fromEntries(all('memberGroups').map(group => [group.id,
      Object.fromEntries(all('targetMembers').filter(r => r.metadata.targetRevisionId === group.id).map(r => [r.metadata.jobId, r.value]))])));
    else if (key === 'identityAliases') defineOwn(result,key,Object.fromEntries(all('aliasGroups').map(group => [group.id,
      all('identityAliasLinks').filter(r => r.metadata.parentId === group.id).map(r => r.value)])));
    else if (key === 'recoveryRecords') defineOwn(result,key,all('recoveryRecords').map(r => r.value));
    else if (key === 'settings') defineOwn(result,key,Object.fromEntries(all('settings').map(r => [r.id, r.value])));
    else if (key === 'versionCounters') {
      result[key] = {};
      for (const r of all('workspaceFields')) if (r.id.startsWith('["counterKind",')) defineOwn(result[key],r.value.kind,{});
      for (const r of all('versionCounters')) { const [kind, id] = JSON.parse(r.id); if(!Object.hasOwn(result[key],kind))defineOwn(result[key],kind,{});defineOwn(result[key][kind],id,r.value); }
    } else {
      const id = rowKey('workspaceFields', rowKey('extension', key));
      defineOwn(result,key,values.has(id) ? values.get(id) : key === 'migration' ? null : undefined);
    }
  }
  return result;
}
