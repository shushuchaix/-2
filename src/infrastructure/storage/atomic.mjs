import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const renameDelays = [25, 50, 100, 200, 400, 800];
const transientWindowsCodes = new Set(["EPERM", "EACCES", "EBUSY"]);

async function replaceFile(
  from,
  to,
  { fsAdapter, platform, sleep, onRenameRecovery, beforeRename },
) {
  let retryCount = 0,
    retryDelayMs = 0,
    code;
  for (;;) {
    try {
      if(beforeRename)await beforeRename();
      await fsAdapter.rename(from, to);
      break;
    } catch (error) {
      if (
        platform !== "win32" ||
        !transientWindowsCodes.has(error.code) ||
        retryCount >= renameDelays.length
      ) {
        if (retryCount) error.retryCount = retryCount;
        throw error;
      }
      code = error.code;
      const delay = renameDelays[retryCount++];
      retryDelayMs += delay;
      await sleep(delay);
    }
  }
  if (retryCount && onRenameRecovery) {
    // Diagnostics must not turn a completed save into an apparent failure.
    try {
      await onRenameRecovery({ retryCount, code, retryDelayMs });
    } catch {}
  }
}

export async function writeAtomicJson(
  filename,
  value,
  options = {},
) {
  return writeAtomicJsonText(filename, JSON.stringify(value, null, 2), options);
}

/** Internal pre-serialized JSON path; durability is identical to writeAtomicJson. */
export async function writeAtomicJsonText(
  filename,
  serialized,
  options = {},
) {
  const token=await prepareAtomicJsonText(filename,serialized,options);
  try {
    return await publishPreparedAtomicJsonText(token);
  }finally{
    // The legacy wrapper retains its existing best-effort temp cleanup policy.
    // Maintenance callers use the prepared API directly and retain uncertain
    // artifacts instead of deleting a file with a changed physical identity.
    await discardPreparedAtomicJsonText(token,{legacyCleanup:true});
  }
}

const preparedFiles=new WeakMap();
const invalidPrepared=()=>Object.assign(Error('Prepared file identity is unavailable or changed.'),{code:'atomic_prepared_invalid'});
const stableIdentity=stat=>{
  const keys=['dev','ino','size','mtimeNs','ctimeNs'];
  if(keys.some(key=>stat?.[key]===undefined)||String(stat.ino)==='0')throw invalidPrepared();
  return Object.freeze(Object.fromEntries(keys.map(key=>[key,String(stat[key])])));
};
const equalIdentity=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
async function existingParent(filename,adapter){
  const dir=path.dirname(path.resolve(filename)),stat=await adapter.lstat(dir,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(await adapter.realpath(dir),dir)||
    stat.dev===undefined||stat.ino===undefined||String(stat.ino)==='0')throw invalidPrepared();
  return String(stat.dev)+':'+String(stat.ino);
}

/** Write and sync once outside a publication fence. The token has no writable
 * fields or exposed serialized body. Strict maintenance mode never mkdirs. */
export async function prepareAtomicJsonText(filename,serialized,{
  fsAdapter=fs,platform=process.platform,sleep=wait,onRenameRecovery,captureFileIdentity=false,
  requireExistingParent=false,requireFileIdentity=false,maxBytes,
}={}){
  if(typeof filename!=='string'||!filename||typeof serialized!=='string')throw TypeError('Expected filename and serialized JSON');
  const bytes=Buffer.byteLength(serialized);
  if(maxBytes!==undefined&&(!Number.isSafeInteger(maxBytes)||maxBytes<1||bytes>maxBytes))throw invalidPrepared();
  if(requireFileIdentity&&(!requireExistingParent||!captureFileIdentity))throw invalidPrepared();
  const state={filename,temp:filename+'.'+randomUUID()+'.tmp',fsAdapter,platform,sleep,onRenameRecovery,captureFileIdentity,
    requireExistingParent,requireFileIdentity,bytes,phase:'preparing',failure:null,identityHandle:null,beforeIdentity:null,parentIdentity:null};
  let handle,phase='mkdir';
  try{
    if(requireExistingParent)state.parentIdentity=await existingParent(filename,fsAdapter);
    else await fsAdapter.mkdir(path.dirname(filename),{recursive:true});
    phase='open';handle=await fsAdapter.open(state.temp,'wx');phase='write';await handle.writeFile(serialized,'utf8');
    phase='sync';await handle.sync();phase='close';await handle.close();handle=null;
    if(captureFileIdentity){
      try{state.identityHandle=await fsAdapter.open(state.temp,'r');state.beforeIdentity=await state.identityHandle.stat({bigint:true});
        if(requireFileIdentity)state.identity=stableIdentity(state.beforeIdentity);}
      catch(error){if(requireFileIdentity)throw error;}
    }
    if(requireExistingParent&&state.parentIdentity!==await existingParent(filename,fsAdapter))throw invalidPrepared();
    state.phase='prepared';const token=Object.freeze(Object.create(null));preparedFiles.set(token,state);return token;
  }catch(error){
    state.failure=error;error.storageOperation||='atomic.'+phase;
    if(handle)await handle.close().catch(()=>{});if(state.identityHandle)await state.identityHandle.close().catch(()=>{});
    // No caller received a token. In strict mode only the still-owned inode may
    // be removed; otherwise leave the uncertain artifact for managed recovery.
    try{
      if(!requireFileIdentity||state.identity&&equalIdentity(stableIdentity(await fsAdapter.lstat(state.temp,{bigint:true})),state.identity))await fsAdapter.unlink(state.temp);
    }catch{}
    throw error;
  }
}
export function preparedAtomicMetadata(token){
  const state=preparedFiles.get(token);if(!state||state.phase==='discarded')throw invalidPrepared();
  return Object.freeze({tempBasename:path.basename(state.temp),bytes:state.bytes,phase:state.phase,
    ...(state.identity?{identity:state.identity}:{})});
}
/** The caller performs its descriptor/file-intent CAS in beforePublish under
 * the formal file fence. Only lstat/identity and rename are performed here. */
export async function publishPreparedAtomicJsonText(token,{beforePublish}={}){
  const state=preparedFiles.get(token);if(!state||state.phase!=='prepared')throw invalidPrepared();
  state.phase='consumed';let identity;
  try{
    if(state.requireExistingParent&&state.parentIdentity!==await existingParent(state.filename,state.fsAdapter))throw invalidPrepared();
    if(state.requireFileIdentity){
      const current=stableIdentity(await state.fsAdapter.lstat(state.temp,{bigint:true}));
      if(!equalIdentity(current,state.identity)||!equalIdentity(stableIdentity(await state.identityHandle.stat({bigint:true})),state.identity))throw invalidPrepared();
    }
    if(beforePublish!==undefined){if(typeof beforePublish!=='function')throw invalidPrepared();await beforePublish(preparedAtomicMetadata(token));}
    if(state.requireExistingParent&&state.parentIdentity!==await existingParent(state.filename,state.fsAdapter))throw invalidPrepared();
    if(state.requireFileIdentity&&!equalIdentity(stableIdentity(await state.fsAdapter.lstat(state.temp,{bigint:true})),state.identity))throw invalidPrepared();
    if(state.requireFileIdentity)state.beforeRename=async()=>{
      if(state.parentIdentity!==await existingParent(state.filename,state.fsAdapter)||
        !equalIdentity(stableIdentity(await state.fsAdapter.lstat(state.temp,{bigint:true})),state.identity)||
        !equalIdentity(stableIdentity(await state.identityHandle.stat({bigint:true})),state.identity))throw invalidPrepared();
    };
    await replaceFile(state.temp,state.filename,state);
    if(state.beforeIdentity){
      try{const after=await state.identityHandle.stat({bigint:true});
        if(['dev','ino','size','mtimeNs'].every(key=>state.beforeIdentity[key]!==undefined&&state.beforeIdentity[key]===after[key]))identity=after;
      }catch{}
    }
    state.phase='published';return state.captureFileIdentity?identity:undefined;
  }catch(error){state.failure=error;error.storageOperation||='atomic.rename';throw error;}
  finally{if(state.identityHandle){await state.identityHandle.close().catch(()=>{});state.identityHandle=null;}}
}
export async function discardPreparedAtomicJsonText(token,{legacyCleanup=false}={}){
  const state=preparedFiles.get(token);if(!state)return {removed:false,retainedUncertain:false};
  const result={removed:false,retainedUncertain:false};
  if(state.identityHandle){await state.identityHandle.close().catch(()=>{});state.identityHandle=null;}
  try{
    if(!legacyCleanup&&state.requireFileIdentity){
      const current=stableIdentity(await state.fsAdapter.lstat(state.temp,{bigint:true}));
      if(!equalIdentity(current,state.identity))throw invalidPrepared();
    }
    await state.fsAdapter.unlink(state.temp);result.removed=true;
  }catch(error){
    if(error.code!=='ENOENT'){result.retainedUncertain=true;if(!state.failure){error.storageOperation||='atomic.cleanup';throw error;}}
  }finally{state.phase='discarded';preparedFiles.delete(token);}
  return result;
}
