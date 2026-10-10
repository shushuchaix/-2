import {PACKAGE_KINDS, PACKAGE_STATES, UUID_RE, packageError} from './packages.mjs';
import {assertCollectionRun, assertCollectionSettings} from './collection.mjs';
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
export const PRIVATE_MAPS = ['jobs','observations','evaluations','runs','applications','events','files'];
export function packageRecords(w) {
  const result=[];
  for (const key of ['profiles','targets']) for (const list of Object.values(w[key]||{}))
    for(const r of list){
      result.push({collection:key, record:r});
      if(key==='targets'&&r.profileSnapshot)result.push({collection:'profiles', record:r.profileSnapshot,parentOwnerPackageId:r.ownerPackageId});
    }
  for (const key of PRIVATE_MAPS) for (const r of Object.values(w[key]||{})) {
    result.push({collection:key,record:r});
    if(key==='applications'||key==='runs')for(const event of r.events||[])result.push({collection:'events',record:event,parentOwnerPackageId:r.ownerPackageId});
  }
  for(const r of w.recoveryRecords||[])if(r.ownerPackageId)result.push({collection:'events',record:r});
  return result;
}
export function assertPackageOwnership(w) {
  if (!plain(w.packages)) throw Error('Invalid workspace packages');
  const versionIds=new Set();
  for(const [id,p] of Object.entries(w.packages)) {
    if(!plain(p)||p.packageId!==id||!UUID_RE.test(id)||!PACKAGE_KINDS.includes(p.kind)||!PACKAGE_STATES.includes(p.state)||typeof p.enabled!=='boolean'||typeof p.versionId!=='string'||typeof p.versionName!=='string')
      throw Error('Invalid package identity or state');
    if(versionIds.has(p.kind+':'+p.versionId))throw Error('Duplicate package version identity');
    versionIds.add(p.kind+':'+p.versionId);
    if(['trashed','purge_pending'].includes(p.state)&&(!UUID_RE.test(p.archiveId)||!Number.isFinite(Date.parse(p.archivedAt))||!Number.isFinite(Date.parse(p.purgeAt))))throw Error('Invalid package archive');
    if(p.state==='active'&&(p.archiveId!==null||p.archivedAt!==null||p.purgeAt!==null))throw Error('Invalid active package archive');
    assertCollectionSettings(p.collectionSettings);
  }
  for(const key of ['events','files'])if(!plain(w[key]))throw Error('Invalid workspace '+key);
  const ids=new Set();
  for(const {collection,record:r,parentOwnerPackageId} of packageRecords(w)) {
    if(!plain(r)||!UUID_RE.test(r.recordId)||!w.packages[r.ownerPackageId])throw Error('Invalid private record owner package: '+collection);
    if(parentOwnerPackageId&&r.ownerPackageId!==parentOwnerPackageId)throw Error('Embedded private record ownership mismatch');
    if(ids.has(r.recordId))throw Error('Duplicate private record identity');
    ids.add(r.recordId);
    if(w.packages[r.ownerPackageId].state==='purged'||w.packages[r.ownerPackageId].state==='purge_pending')throw Error('Private body retained in inaccessible package');
    for(const [field,map] of [['jobId','jobs'],['runId','runs'],['observationId','observations'],['applicationId','applications']]) {
      if(collection===map||!r[field])continue;
      const linked=w[map]?.[r[field]];
      if(!linked||linked.ownerPackageId!==r.ownerPackageId)throw packageError('package_scope_mismatch','Private reference ownership crosses a package: '+field);
    }
  }
  for(const [revisionId,members] of Object.entries(w.targetMembers||{})) {
    const target=Object.values(w.targets).flat().find(t=>t.revisionId===revisionId);
    for(const [jobId,m] of Object.entries(members)) {
      if(!target||w.jobs[jobId]?.ownerPackageId!==target.ownerPackageId)throw Error('Target member ownership mismatch');
      for(const ref of m.factRefs||[])if(w.observations[ref.observationId]?.ownerPackageId!==target.ownerPackageId)throw Error('Target fact ownership mismatch');
    }
  }
  for(const run of Object.values(w.runs||{}))assertCollectionRun(run,w);
}
export function countPackageRecords(w,packageId) {
  const counts=Object.fromEntries(['profiles','targets',...PRIVATE_MAPS].map(k=>[k,0]));
  for(const {collection,record} of packageRecords(w))if(record.ownerPackageId===packageId)counts[collection]++;
  return counts;
}
