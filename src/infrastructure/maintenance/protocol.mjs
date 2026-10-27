import { UUID_RE, packageError } from '../../domain/packages.mjs';

// These are internal coordination records, never a business workspace field or
// a renderer capability. The later process host uses the same fixed descriptor.
export const PURGE_WORKER_JOURNAL = 'purgeWorkerJournal';
export const PURGE_WORKER_STATES = Object.freeze(['starting','running','retry_wait','stopped','completed']);
export const PURGE_JOURNAL_STATES = Object.freeze(['dispatch_reserved','claimed','running','release_observed','retired']);
export const PURGE_REPLACEMENT_STAGES = Object.freeze(['body','final']);
export const PURGE_OUTCOMES = Object.freeze(['purge_worker_failed','purge_sqlite_busy','purge_claim_conflict',
  'purge_worker_stopped','purge_boot_failed','purge_input_limit','purge_timeout','purge_state_changed','purge_file_failed']);
export const DEFAULT_PURGE_LIMITS = Object.freeze({controlBytes:16*1024*1024,markerBytes:64*1024,
  sourceRows:250000,sourceBytes:192*1024*1024,packedBytes:384*1024*1024,
  references:2000000,parts:500000,managedFileBytes:192*1024*1024,
  managedFiles:2048,managedTotalBytes:1024*1024*1024,stageMs:30000,taskMs:120000,frameBytes:16384});

export const purgeClaimError = (code='purge_claim_conflict') =>
  packageError(code,'永久清理授权或断点状态尚未核实，任务保留待处理。',409);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(v));
const shape=(v,required,optional=[])=>plain(v)&&required.every(k=>Object.hasOwn(v,k))&&
  Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const positive=v=>Number.isSafeInteger(v)&&v>0;
const uint=v=>Number.isSafeInteger(v)&&v>=0;
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v;
const operationId=v=>typeof v==='string'&&v.startsWith('op-')&&UUID_RE.test(v.slice(3));
const descriptorKeys=['taskId','packageId','generation','dispatchId','leaseOperationId'];

export function assertPurgeDescriptor(value){
  if(!shape(value,descriptorKeys)||!UUID_RE.test(value.taskId||'')||!UUID_RE.test(value.packageId||'')||
    !positive(value.generation)||!UUID_RE.test(value.dispatchId||'')||!operationId(value.leaseOperationId))throw purgeClaimError();
  return value;
}
export function samePurgeDescriptor(a,b){
  return Boolean(a&&b&&descriptorKeys.every(key=>a[key]===b[key]));
}
export function purgeDescriptor(task){
  const w=task?.worker;
  return assertPurgeDescriptor({taskId:task?.operationId,packageId:task?.packageId,generation:w?.generation,
    dispatchId:w?.dispatchId,leaseOperationId:w?.leaseOperationId});
}
function assertRetirement(value){
  if(!shape(value,['sequence','stage'])||!uint(value.sequence)||!['prepared','complete'].includes(value.stage))throw purgeClaimError();
}
function assertPreviousRetirement(value){
  if(!shape(value,['descriptor','sequence'])||!(value.sequence===null||positive(value.sequence)))throw purgeClaimError();
  assertPurgeDescriptor(value.descriptor);
}
export function assertPurgeWorker(value,{task}={}){
  const required=['formatVersion','generation','dispatchId','leaseOperationId','state','dispatcherPid','workerPid',
    'claimStartedAt','startedAt','lastOutcome','nextRetryAt'];
  if(!shape(value,required,['journalSequence','retirement','previousRetirement'])||value.formatVersion!==1||
    !positive(value.generation)||!UUID_RE.test(value.dispatchId||'')||!operationId(value.leaseOperationId)||
    !PURGE_WORKER_STATES.includes(value.state)||!positive(value.dispatcherPid)||
    !(value.workerPid===null||positive(value.workerPid))||!iso(value.claimStartedAt)||
    !(value.startedAt===null||iso(value.startedAt))||
    !(value.lastOutcome===null||PURGE_OUTCOMES.includes(value.lastOutcome))||
    !(value.nextRetryAt===null||iso(value.nextRetryAt))||
    (value.journalSequence!==undefined&&!positive(value.journalSequence)))throw purgeClaimError();
  if(value.state==='running'&&(!positive(value.workerPid)||value.startedAt===null))throw purgeClaimError();
  if(value.retirement!==undefined)assertRetirement(value.retirement);
  if(value.previousRetirement!==undefined)assertPreviousRetirement(value.previousRetirement);
  if(value.retirement&&!['retry_wait','stopped','completed'].includes(value.state))throw purgeClaimError();
  if(value.previousRetirement&&value.state!=='starting')throw purgeClaimError();
  if(task){purgeDescriptor({...task,worker:value});if((task.phase==='completed')!==(value.state==='completed'))throw purgeClaimError();}
  return value;
}
export function assertPurgeWorkerTransition(previous,next,{task,previousTask,retirementTask}={}){
  if(next!==undefined)assertPurgeWorker(next,{task});
  const retiredAuthority=()=>{
    const reference=next?.previousRetirement,retired=retirementTask||previousTask;
    return reference&&retired?.worker?.retirement?.stage==='complete'&&
      ['retry_wait','stopped','completed'].includes(retired.worker.state)&&
      samePurgeDescriptor(reference.descriptor,purgeDescriptor(retired))&&reference.sequence===(retired.worker.journalSequence??null);
  };
  if(previous===undefined){if(next&&(next.generation!==1||next.state!=='starting'||next.workerPid!==null||
    next.startedAt!==null||task?.phase==='completed'||next.previousRetirement&&!retiredAuthority()))throw purgeClaimError();return;}
  if(next===undefined)throw purgeClaimError();
  assertPurgeWorker(previous,{task:previousTask});
  if(next.generation===previous.generation){
    for(const key of ['dispatchId','leaseOperationId','dispatcherPid','claimStartedAt'])if(next[key]!==previous[key])throw purgeClaimError();
    if(previous.workerPid!==null&&next.workerPid!==previous.workerPid)throw purgeClaimError();
    if(previous.startedAt!==null&&next.startedAt!==previous.startedAt)throw purgeClaimError();
    const transitions={starting:['starting','running','retry_wait','stopped'],running:['running','retry_wait','stopped','completed'],
      retry_wait:['retry_wait'],stopped:['stopped'],completed:['completed']};
    if(!transitions[previous.state].includes(next.state))throw purgeClaimError();
    if((next.journalSequence??0)<(previous.journalSequence??0))throw purgeClaimError();
    if(previous.retirement&&(!next.retirement||next.retirement.sequence!==previous.retirement.sequence||
      previous.retirement.stage==='complete'&&next.retirement.stage!=='complete'))throw purgeClaimError();
    if(previous.previousRetirement&&next.previousRetirement&&
      JSON.stringify(previous.previousRetirement)!==JSON.stringify(next.previousRetirement))throw purgeClaimError();
  }else{
    if(next.generation!==previous.generation+1||previous.state==='completed'||
      !['retry_wait','stopped'].includes(previous.state)||previous.retirement?.stage!=='complete'||next.state!=='starting'||
      next.workerPid!==null||next.startedAt!==null||!retiredAuthority())throw purgeClaimError();
  }
}
export function assertPurgeJournal(value){
  if(value===undefined||value===null)return null;
  const required=['version','descriptor','sequence','state','workerPid','leaseToken','stage','publicationReceipt'];
  if(!shape(value,required)||value.version!==1||!positive(value.sequence)||!PURGE_JOURNAL_STATES.includes(value.state)||
    !(value.workerPid===null||positive(value.workerPid))||!(value.leaseToken===null||UUID_RE.test(value.leaseToken||''))||
    !['prepared','body','files','final','completed','purge_pending','verified'].includes(value.stage))throw purgeClaimError();
  assertPurgeDescriptor(value.descriptor);
  if(['claimed','running'].includes(value.state)&&(!positive(value.workerPid)||!UUID_RE.test(value.leaseToken||'')))throw purgeClaimError();
  if(value.publicationReceipt!==null){
    const p=value.publicationReceipt;
    if(!shape(p,['stage','baseRevision','committedRevision'])||!PURGE_REPLACEMENT_STAGES.includes(p.stage)||
      !uint(p.baseRevision)||!uint(p.committedRevision)||p.committedRevision!==p.baseRevision+1)throw purgeClaimError();
  }
  if(Buffer.byteLength(JSON.stringify(value))>16384)throw purgeClaimError();
  return value;
}
export function isProtectedPurgeLease(lease,journal){
  if(journal!==undefined&&journal!==null)assertPurgeJournal(journal);
  return Boolean(lease&&Object.hasOwn(lease,'purgeClaim')||journal&&lease&&journal.descriptor.leaseOperationId===lease.operationId);
}
export function assertPurgeLease(lease,descriptor,{workerPid,token}={}){
  assertPurgeDescriptor(descriptor);
  const claim=lease?.purgeClaim;
  if(!lease||lease.operationId!==descriptor.leaseOperationId||lease.kind!=='permanent-delete'||
    !UUID_RE.test(lease.token||'')||!positive(lease.ownerPid)||
    !shape(claim,['taskId','packageId','generation','dispatchId'])||
    !['taskId','packageId','generation','dispatchId'].every(key=>claim[key]===descriptor[key])||
    !Array.isArray(lease.packageIds)||lease.packageIds.length!==1||lease.packageIds[0]!==descriptor.packageId||
    lease.scope!==null||(workerPid!==undefined&&lease.ownerPid!==workerPid)||(token!==undefined&&lease.token!==token))throw purgeClaimError();
  return lease;
}
export function assertPurgeHostStatus(value,descriptor){
  if(!shape(value,['descriptor','state','childRegistered','exitObserved','spawnFailed','cleanupSettled','workerPid','code'])||
    !samePurgeDescriptor(assertPurgeDescriptor(value.descriptor),assertPurgeDescriptor(descriptor))||
    !['reserved','spawned','booted','stopping','exited','spawn_failed'].includes(value.state)||
    ['childRegistered','exitObserved','spawnFailed','cleanupSettled'].some(key=>typeof value[key]!=='boolean')||
    !(value.workerPid===null||positive(value.workerPid))||!(value.code===null||PURGE_OUTCOMES.includes(value.code)))throw purgeClaimError();
  if(value.exitObserved&&(value.state!=='exited'||!value.childRegistered||!positive(value.workerPid)))throw purgeClaimError();
  if(value.spawnFailed&&(value.state!=='spawn_failed'||value.childRegistered||value.workerPid!==null||value.exitObserved))throw purgeClaimError();
  if(value.state==='exited'&&!value.exitObserved||value.state==='spawn_failed'&&!value.spawnFailed)throw purgeClaimError();
  return value;
}
export function assertPurgePublication(value,task){
  if(!shape(value,['descriptor','stage','baseRevision','committedRevision'])||!PURGE_REPLACEMENT_STAGES.includes(value.stage)||
    !uint(value.baseRevision)||value.committedRevision!==value.baseRevision+1||!uint(value.committedRevision))throw purgeClaimError();
  assertPurgeDescriptor(value.descriptor);
  if(task&&(value.descriptor.taskId!==task.operationId||value.descriptor.packageId!==task.packageId||
    !task.worker||value.descriptor.generation>task.worker.generation))throw purgeClaimError();
  return value;
}
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fileIdentity=value=>shape(value,['dev','ino','size','mtimeNs','ctimeNs'])&&
  Object.values(value).every(field=>typeof field==='string'&&/^(0|[1-9][0-9]{0,39})$/.test(field))&&value.ino!=='0';
export function assertPurgeFileIntent(value,task){
  if(!shape(value,['version','intentId','descriptor','sequence','stage','path','tempBasename','sourceHash','resultHash',
    'sourceIdentity','tempIdentity','bytes'])||value.version!==1||!UUID_RE.test(value.intentId||'')||!positive(value.sequence)||
    !['prepared','published','verified'].includes(value.stage)||
    typeof value.path!=='string'||!(/^(?:workspace\.v2\.previous\.json|backups\/workspace-[A-Za-z0-9_.-]+\.json)$/.test(value.path))||
    !(value.sourceHash===null||hash(value.sourceHash))||!hash(value.resultHash)||
    !(value.sourceIdentity===null||fileIdentity(value.sourceIdentity))||!fileIdentity(value.tempIdentity)||
    (value.sourceHash===null)!==(value.sourceIdentity===null)||!positive(value.bytes)||value.bytes>DEFAULT_PURGE_LIMITS.managedFileBytes||
    BigInt(value.tempIdentity.size)!==BigInt(value.bytes))throw purgeClaimError();
  assertPurgeDescriptor(value.descriptor);
  const basename=value.path.split('/').at(-1);
  if(typeof value.tempBasename!=='string'||!value.tempBasename.startsWith(basename+'.')||!value.tempBasename.endsWith('.tmp')||
    !UUID_RE.test(value.tempBasename.slice(basename.length+1,-4)))throw purgeClaimError();
  if(task&&(!task.worker||!samePurgeDescriptor(value.descriptor,purgeDescriptor(task))))throw purgeClaimError();
  return value;
}
export function assertPurgeTaskProofTransition(previous,next){
  if(next.sqlPublication!==undefined)assertPurgePublication(next.sqlPublication,next);
  if(previous?.sqlPublication){
    const before=previous.sqlPublication,after=next.sqlPublication;
    if(!after||after.committedRevision<before.committedRevision||before.stage==='final'&&after.stage!=='final'||
      after.descriptor.generation<before.descriptor.generation||
      after.committedRevision===before.committedRevision&&JSON.stringify(after)!==JSON.stringify(before)||
      after.descriptor.generation===before.descriptor.generation&&!samePurgeDescriptor(after.descriptor,before.descriptor))throw purgeClaimError();
  }
  if(next.fileIntent!==undefined)assertPurgeFileIntent(next.fileIntent,next);
  const before=previous?.fileIntent,after=next.fileIntent;
  if(before){
    if(!after){if(before.stage!=='verified')throw purgeClaimError();}
    else if(before.intentId===after.intentId){
      if(JSON.stringify({...before,stage:null})!==JSON.stringify({...after,stage:null})||
        ['prepared','published','verified'].indexOf(after.stage)<['prepared','published','verified'].indexOf(before.stage))throw purgeClaimError();
    }else if(before.stage!=='verified'||after.stage!=='prepared')throw purgeClaimError();
  }
  if(after&&(!before||after.intentId!==before.intentId)&&
    (next.worker?.state!=='running'||after.stage!=='prepared'||after.sequence!==next.worker.journalSequence))throw purgeClaimError();
}
export function purgeLimits(overrides={}){
  if(!plain(overrides)||Object.keys(overrides).some(key=>!Object.hasOwn(DEFAULT_PURGE_LIMITS,key)))throw purgeClaimError('purge_input_limit');
  const limits={...DEFAULT_PURGE_LIMITS,...overrides};
  for(const [key,value]of Object.entries(limits))if(!positive(value)||value>DEFAULT_PURGE_LIMITS[key])throw purgeClaimError('purge_input_limit');
  return Object.freeze(limits);
}
