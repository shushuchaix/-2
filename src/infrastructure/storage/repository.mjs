import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertWorkspace,createEmptyWorkspace } from '../../domain/contracts.mjs';
import { writeAtomicJson } from './atomic.mjs';
import { withWorkspaceLock } from './lock.mjs';
export const contentHash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export async function openWorkspaceRepository({dataDir,fsAdapter=fs,clock={now:()=>Date.now()}}) {
 if(!dataDir)throw Error('Missing data directory');dataDir=path.resolve(dataDir);await fsAdapter.mkdir(dataDir,{recursive:true});
 const filename=path.join(dataDir,'workspace.v2.json');
 const read=async()=>{let raw;try{raw=await fsAdapter.readFile(filename,'utf8');}catch(e){if(e.code==='ENOENT')return createEmptyWorkspace();throw e;}let value;try{value=JSON.parse(raw);}catch(e){throw Error('Corrupt workspace JSON: '+e.message);}return assertWorkspace(value);};
 await read();let queue=Promise.resolve();
 const mutateWorkspace=fn=>{const operation=queue.then(()=>withWorkspaceLock(dataDir,async()=>{
 const current=await read();const draft=structuredClone(current);const result=await fn(draft);draft.revision=current.revision+1;assertWorkspace(draft);
 if(current.revision>0)await writeAtomicJson(path.join(dataDir,'workspace.v2.previous.json'),current,{fsAdapter});
 await writeAtomicJson(filename,draft,{fsAdapter});return {revision:draft.revision,result:structuredClone(result)};
 }));queue=operation.catch(()=>{});return operation;};
 const runPath=id=>{if(!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw Error('Invalid run id');return path.join(dataDir,'runs-v2',id+'.json');};
 return {dataDir,clock,read,mutateWorkspace,
 async writeRunSnapshot(id,snapshot){const p=runPath(id);return withWorkspaceLock(dataDir,async()=>{const raw=JSON.stringify(snapshot);try{const old=await fsAdapter.readFile(p,'utf8');if(contentHash(JSON.parse(old))!==contentHash(snapshot))throw Error('Run snapshot immutable');}catch(e){if(e.code!=='ENOENT')throw e;await writeAtomicJson(p,snapshot,{fsAdapter});}return {path:path.relative(dataDir,p),hash:contentHash(raw)};});},
 async readRunSnapshot(id){return JSON.parse(await fsAdapter.readFile(runPath(id),'utf8'));}};
}
