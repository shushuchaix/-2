import {randomUUID} from 'node:crypto';
import {job} from './fixtures.mjs';
export async function seedUnassignedClosure(f,{targetSnapshot=null,managedSnapshot=false}={}){
 const packageId=randomUUID(),recordId=randomUUID(),jobId='j-'+randomUUID(),applicationId='a-'+recordId,runId='r-'+randomUUID(),observationId='o-'+randomUUID();
 await f.repository.withMaintenanceTransaction(async tx=>{
  const w=structuredClone(tx.workspace),control=structuredClone(tx.control);control.identityIndex.package['synthetic-unassigned:'+packageId]=packageId;
  w.packages[packageId]={packageId,kind:'legacy_unassigned',versionId:'legacy-'+packageId+'@1',versionName:'合成待归属',enabled:true,state:'active',archiveId:null,archivedAt:null,purgeAt:null};
  w.jobs[jobId]={recordId:randomUUID(),ownerPackageId:packageId,jobId,kind:'job',canonical:job(),sourceRefs:[],identityAliases:['synthetic-legacy'],firstSeen:'2026-10-09T00:00:00.000Z',lastSeen:'2026-10-09T00:00:00.000Z',targetFirstSeen:{},lifecycle:'observed',lifecycleEvidence:[],deadlinePassed:false,duplicateGroupIds:[]};
  w.runs[runId]={recordId:randomUUID(),ownerPackageId:packageId,runId,targetSnapshot,status:'completed',createdAt:'2026-10-09T00:00:00.000Z',events:[{recordId:randomUUID(),ownerPackageId:packageId,runId,seq:1,type:'done'}],lastSeq:1,snapshotRef:null};
  w.observations[observationId]={recordId:randomUUID(),ownerPackageId:packageId,observationId,jobId,runId,fields:job(),observedAt:'2026-10-09T00:00:00.000Z'};
  w.applications[applicationId]={recordId,ownerPackageId:packageId,applicationId,jobId,runId,status:'applied',note:'合成历史投递',resumeRevisionId:null,appliedAt:null,followUpAt:null,events:[{recordId:randomUUID(),ownerPackageId:packageId,type:'note',note:'合成历史事件'}]};
  w.identityAliases['synthetic-legacy']=[jobId];await tx.commitControl(control);await tx.commitWorkspace(w);
  if(managedSnapshot){const snapshotRecordId=randomUUID(),fileId=randomUUID(),snapshot={recordId:snapshotRecordId,ownerPackageId:packageId,run:structuredClone(w.runs[runId]),jobs:[structuredClone(w.jobs[jobId])],observations:[structuredClone(w.observations[observationId])],applications:[structuredClone(w.applications[applicationId])],profile:null};const ref=await tx.writeSnapshot(runId,snapshot);const next=structuredClone(tx.workspace);next.runs[runId].snapshotRef=ref;next.files[fileId]={recordId:fileId,fileId,snapshotRecordId,ownerPackageId:packageId,runId,path:ref.path,hash:ref.hash,kind:'run_snapshot'};await tx.commitWorkspace(next);}
 });
 return {recordId,packageId,applicationId,jobId,runId,observationId};
}
