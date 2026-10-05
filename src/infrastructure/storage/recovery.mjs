import fs from 'node:fs/promises';import path from 'node:path';import {contentHash} from './repository.mjs';
export async function recoverWorkspace(repository) {
 const w=await repository.read(),interruptedRunIds=[],orphanSnapshots=[],issues=[];
 const names=await fs.readdir(path.join(repository.dataDir,'runs-v2')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 for(const run of Object.values(w.runs)){if(run.mode&&!run.snapshotRef&&['completed','partial','failed','cancelled'].includes(run.status))issues.push({code:'missing_snapshot',runId:run.runId,message:'Terminal v2 run has no snapshot reference'});if(['queued','running'].includes(run.status))interruptedRunIds.push(run.runId);if(run.snapshotRef){try{if(run.snapshotRef.path!=='runs-v2/'+run.runId+'.json')throw Error('Unsafe snapshot reference');const s=await repository.readRunSnapshot(run.runId);if(contentHash(s)!==run.snapshotRef.hash)throw Error('Snapshot hash mismatch');}catch(e){issues.push({code:e.code==='ENOENT'?'missing_snapshot':'invalid_snapshot',runId:run.runId,message:e.message});}}}
 for(const name of names.filter(n=>n.endsWith('.json'))){const id=name.slice(0,-5);if(!w.runs[id]?.snapshotRef)orphanSnapshots.push(id);}
 if(interruptedRunIds.length||issues.length||orphanSnapshots.length)await repository.mutateWorkspace(draft=>{for(const id of interruptedRunIds){draft.runs[id].status='interrupted';draft.runs[id].stage='interrupted';draft.runs[id].finishedAt=new Date(repository.clock.now()).toISOString();}
 for(const issue of [...issues,...orphanSnapshots.map(runId=>({code:'orphan_snapshot',runId}))])if(!draft.recoveryRecords.some(i=>contentHash(i)===contentHash(issue)))draft.recoveryRecords.push(issue);});
 return {interruptedRunIds,orphanSnapshots,issues};
}
