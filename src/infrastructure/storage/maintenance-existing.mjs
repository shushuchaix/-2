import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { assertControl } from './package-control.mjs';
import { SQLITE_STORE_VERSION, SCHEMA_SQL } from './sqlite-schema.mjs';
import { JOB_READ_MODEL_VERSION } from '../../domain/job-read-model.mjs';
import { COLLECTION_PROJECTION_VERSION } from '../../domain/collection-projections.mjs';
import { assertPurgeDescriptor, samePurgeDescriptor, purgeDescriptor, purgeClaimError,
  purgeLimits } from '../maintenance/protocol.mjs';

const bindings=new WeakMap();
const clone=value=>structuredClone(value);
const fail=()=>purgeClaimError('purge_existing_store_required');
const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const digest=text=>createHash('sha256').update(text).digest('hex');
const physical=stat=>{
  if(stat?.dev===undefined||stat?.ino===undefined||String(stat.ino)==='0')throw fail();
  return String(stat.dev)+':'+String(stat.ino);
};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const terminal=task=>task&&['complete','aborted'].includes(task.phase);

// Strip comments and normalize whitespace only outside SQL literals. The fixed
// DDL is inspected as text, never executed by this maintenance entry.
function canonicalSql(text){
  let result='',quoted=false,space=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){result+=c;if(c==="'"){if(text[i+1]==="'"){result+=text[++i];}else quoted=false;}continue;}
    if(c==="'"){if(space&&result)result+=' ';space=false;quoted=true;result+=c;continue;}
    if(c==='-'&&text[i+1]==='-'){while(i<text.length&&text[i]!=='\n')i++;space=true;continue;}
    if(/\s/.test(c)){space=true;continue;}
    if(space&&result)result+=' ';space=false;result+=c;
  }
  return result.trim().replace(/\bIF NOT EXISTS\s+/g,'').replace(/;$/,'').trim();
}
const expectedSchema=(()=>{
  const cleaned=canonicalSql(SCHEMA_SQL),matches=[...cleaned.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)];
  return new Map(matches.map((match,index)=>[match[2],{type:match[1].toLowerCase(),
    sql:cleaned.slice(match.index,matches[index+1]?.index??cleaned.length).replace(/;\s*$/,'').trim()}]));
})();

async function ordinaryPath(filename,{directory=false,fsAdapter=fs}={}){
  const absolute=path.resolve(filename),root=path.parse(absolute).root;
  let current=root;
  const parts=absolute.slice(root.length).split(path.sep).filter(Boolean);
  for(let i=-1;i<parts.length;i++){
    if(i>=0)current=path.join(current,parts[i]);
    const stat=await fsAdapter.lstat(current,{bigint:true});
    if(stat.isSymbolicLink()||!samePath(await fsAdapter.realpath(current),current)||
      (i<parts.length-1?!stat.isDirectory():directory?!stat.isDirectory():!stat.isFile()))throw fail();
    if(i===parts.length-1)return {path:absolute,physical:physical(stat),stat};
  }
  throw fail();
}
async function limitedJson(filename,limit,fsAdapter){
  const before=await ordinaryPath(filename,{fsAdapter});
  if(before.stat.size>BigInt(limit))throw purgeClaimError('purge_input_limit');
  const handle=await fsAdapter.open(filename,'r');let text;
  try{
    const opened=await handle.stat({bigint:true});if(physical(opened)!==before.physical)throw fail();
    const chunks=[];let total=0;
    for(;;){
      const bytes=Buffer.alloc(Math.min(65536,limit+1-total));
      const {bytesRead}=await handle.read(bytes,0,bytes.length,null);
      if(!bytesRead)break;
      total+=bytesRead;if(total>limit)throw purgeClaimError('purge_input_limit');chunks.push(bytes.subarray(0,bytesRead));
    }
    const after=await handle.stat({bigint:true});
    if(physical(after)!==before.physical||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs)throw fail();
    text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total));
  }finally{await handle.close();}
  const after=await ordinaryPath(filename,{fsAdapter});if(after.physical!==before.physical)throw fail();
  let value;try{value=JSON.parse(text);}catch{throw fail();}
  return {value,digest:digest(text),physical:before.physical};
}
function validateControl(control,descriptor){
  assertControl(control);
  const journal=control.migrationJournal;
  if(journal.sqlite?.phase!=='complete'||typeof journal.sqlite.sourceHash!=='string'||
    !/^[a-f0-9]{64}$/.test(journal.sqlite.sourceHash))throw fail();
  for(const key of ['upgrade','readModels','sqliteSchemaUpgrade'])if(journal[key]&&!terminal(journal[key]))throw fail();
  for(const task of Object.values(journal.maintenance||{}))if(!terminal(task))throw fail();
  for(const task of Object.values(journal.archives||{}))if(!terminal(task))throw fail();
  for(const transfer of Object.values(control.ownershipTransfers))if(transfer.phase!==undefined&&transfer.phase!=='complete')throw fail();
  const task=control.purgeTasks[descriptor.taskId],ledger=control.deletionLedger[descriptor.packageId];
  if(!task||!ledger||ledger.operationId!==descriptor.taskId||task.packageId!==descriptor.packageId||
    !['prepared','purge_pending','verified','completed'].includes(task.phase)||
    !samePurgeDescriptor(purgeDescriptor(task),descriptor)||
    !['starting','running'].includes(task.worker.state)||task.worker.workerPid!==null&&task.worker.workerPid!==process.pid)throw fail();
  return control;
}
async function inspectFiles(state){
  const {dataDir,fsAdapter,limits,descriptor}=state;
  await ordinaryPath(dataDir,{directory:true,fsAdapter});
  for(const folder of ['control','backups','runs-v2'])await ordinaryPath(path.join(dataDir,folder),{directory:true,fsAdapter});
  const marker=await limitedJson(path.join(dataDir,'workspace.v2.json'),limits.markerBytes,fsAdapter),
    initialized=await limitedJson(path.join(dataDir,'control','initialized.json'),limits.markerBytes,fsAdapter),
    envelope=await limitedJson(path.join(dataDir,'control','state.json'),limits.controlBytes,fsAdapter);
  const {checksum,...control}=envelope.value;
  if(typeof checksum!=='string'||checksum!==digest(JSON.stringify(control)))throw fail();
  validateControl(control,descriptor);
  if(initialized.value.formatVersion!==1||initialized.value.phase!=='ready'||initialized.value.workspaceId!==control.workspaceId||
    marker.value.format!=='resume-job-radar/sqlite-migrated'||marker.value.version!==1||marker.value.database!=='workspace.sqlite'||
    marker.value.workspaceId!==control.workspaceId||marker.value.sourceHash!==control.migrationJournal.sqlite.sourceHash||
    state.workspaceId!==control.workspaceId)throw fail();
  const database=await ordinaryPath(path.join(dataDir,'workspace.sqlite'),{fsAdapter});
  if(state.databaseIdentity&&state.databaseIdentity!==database.physical)throw fail();
  if(state.markerDigest&&state.markerDigest!==marker.digest)throw fail();
  return {control,controlDigest:envelope.digest,markerDigest:marker.digest,databaseIdentity:database.physical,
    sourceHash:marker.value.sourceHash};
}
export function assertExistingSqliteFormat(db,{sourceHash}={}){
  const actual=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  if(actual.length!==expectedSchema.size)throw fail();
  for(const row of actual){const expected=expectedSchema.get(row.name);
    if(!expected||row.type!==expected.type||typeof row.sql!=='string'||canonicalSql(row.sql)!==expected.sql)throw fail();}
  const meta=key=>{const row=db.prepare('SELECT value FROM store_meta WHERE key=?').get(key);
    if(!row||Buffer.byteLength(row.value)>16384)throw fail();try{return JSON.parse(row.value);}catch{throw fail();}};
  if(meta('storeVersion')!==SQLITE_STORE_VERSION||meta('schemaVersion')!==3||
    !Number.isSafeInteger(meta('revision'))||meta('revision')<0||meta('jobReadModelVersion')!==JOB_READ_MODEL_VERSION||
    meta('collectionProjectionVersion')!==COLLECTION_PROJECTION_VERSION||meta('migrationSourceHash')!==sourceHash||
    Object.values(db.prepare('PRAGMA journal_mode').get())[0]!=='wal')throw fail();
  return {revision:meta('revision'),sourceHash};
}

/** Trusted parent/worker construction only. This function never initializes or
 * upgrades a store. A JSON/IPC object cannot reproduce its returned binding. */
export async function inspectExistingMaintenance({dataDir,workspaceId,descriptor,fsAdapter=fs,busyTimeoutMs=250,limits={}}={}){
  assertPurgeDescriptor(descriptor);
  if(typeof dataDir!=='string'||!path.isAbsolute(dataDir)||typeof workspaceId!=='string'||
    !Number.isSafeInteger(busyTimeoutMs)||busyTimeoutMs<0||busyTimeoutMs>30000)throw fail();
  const state={dataDir:path.resolve(dataDir),workspaceId,descriptor:Object.freeze(clone(descriptor)),fsAdapter,
    busyTimeoutMs,limits:purgeLimits(limits)};
  try{
    const files=await inspectFiles(state),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite');let db;
    try{
      db=new DatabaseSync(path.join(state.dataDir,'workspace.sqlite'),{readOnly:true,timeout:busyTimeoutMs,
        enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false,allowExtension:false});
      assertExistingSqliteFormat(db,{sourceHash:files.sourceHash});
    }finally{db?.close();}
    const after=await inspectFiles({...state,...files});
    if(after.controlDigest!==files.controlDigest)throw fail();
    Object.assign(state,after);const token=Object.freeze(Object.create(null));bindings.set(token,state);return token;
  }catch(error){if(error.code?.startsWith('purge_'))throw error;throw fail();}
}
export function existingMaintenanceState(binding,{dataDir,descriptor}={}){
  const state=bindings.get(binding);
  if(!state||dataDir&&!samePath(dataDir,state.dataDir)||descriptor&&!samePurgeDescriptor(descriptor,state.descriptor))throw fail();
  return state;
}
export async function recheckExistingMaintenance(binding){
  const state=existingMaintenanceState(binding);
  try{return await inspectFiles(state);}catch(error){if(error.code?.startsWith('purge_'))throw error;throw fail();}
}

// The caller holds the project file fence before reaching this constructor.
// Node 24 RW opens include CREATE; this protects cooperating project writers,
// not arbitrary external raw unlink between the final lstat and DatabaseSync.
export function verifyExistingReadWriteDatabase(db,binding){
  const state=existingMaintenanceState(binding);
  return assertExistingSqliteFormat(db,{sourceHash:state.sourceHash});
}
export function assertExistingDatabasePathSync(binding){
  const state=existingMaintenanceState(binding),filename=path.join(state.dataDir,'workspace.sqlite'),root=path.parse(filename).root;
  let current=root;const parts=filename.slice(root.length).split(path.sep).filter(Boolean);
  for(let i=-1;i<parts.length;i++){
    if(i>=0)current=path.join(current,parts[i]);
    const stat=syncFs.lstatSync(current,{bigint:true});
    if(stat.isSymbolicLink()||!samePath(syncFs.realpathSync(current),current)||
      (i===parts.length-1?!stat.isFile():!stat.isDirectory()))throw fail();
    if(i===parts.length-1&&physical(stat)!==state.databaseIdentity)throw fail();
  }
  return true;
}
