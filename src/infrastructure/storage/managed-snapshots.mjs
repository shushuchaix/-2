import path from 'node:path';
import { contentHash } from './content-hash.mjs';
import { requirePackage, assertOwned, packageError, UUID_RE } from '../../domain/packages.mjs';
import { writeAtomicJson } from './atomic.mjs';

export function snapshotPath(dataDir,id){
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw Error('Invalid run id');
  return path.join(dataDir,'runs-v2',id+'.json');
}
export async function assertSnapshotPath(dataDir,filename,fsAdapter,{allowMissing=false}={}){
  const relative=path.relative(dataDir,filename);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw packageError('snapshot_identity_conflict','受管快照路径不一致。');
  let current=dataDir;
  for(const part of ['',...relative.split(path.sep)]){
    if(part)current=path.join(current,part);
    try{if((await fsAdapter.lstat(current)).isSymbolicLink())throw packageError('snapshot_identity_conflict','受管快照路径包含符号链接。');}
    catch(error){if(error.code==='ENOENT'&&allowMissing)return;throw error;}
  }
}
export function assertSnapshotOwner(w,id,snapshot,clock,{access='business'}={}){
  const run=w.runs[id];
  if(!run)throw packageError('package_not_found','检索记录不存在。',404);
  requirePackage(w,run.ownerPackageId,{now:clock.now(),access});
  assertOwned(w,snapshot,run.ownerPackageId);
  if(!UUID_RE.test(snapshot.recordId)||(snapshot.run?.ownerPackageId&&snapshot.run.ownerPackageId!==run.ownerPackageId))
    throw packageError('package_scope_mismatch','快照归属或稳定记录身份不一致。');
}
/** File IO remains outside SQL transactions; callers establish a durable intent before replacements. */
export function createManagedSnapshotPort({dataDir,fsAdapter,clock,tx,options={},assertLive=()=>{}}){
  const readSnapshot=async id=>{
    assertLive();const filename=snapshotPath(dataDir,id);await assertSnapshotPath(dataDir,filename,fsAdapter);
    return JSON.parse(await fsAdapter.readFile(filename,'utf8'));
  };
  return {
    readSnapshot,
    async writeSnapshot(id,snapshot){
      assertLive();if(!options.bootstrap&&tx.workspace.schemaVersion===3)assertSnapshotOwner(tx.workspace,id,snapshot,clock);
      const filename=snapshotPath(dataDir,id);await assertSnapshotPath(dataDir,filename,fsAdapter,{allowMissing:true});
      try{if(contentHash(await readSnapshot(id))!==contentHash(snapshot))throw Error('Run snapshot immutable');}
      catch(error){if(error.code!=='ENOENT')throw error;await writeAtomicJson(filename,snapshot,{fsAdapter});}
      return {path:path.relative(dataDir,filename).split(path.sep).join('/'),hash:contentHash(snapshot)};
    },
    async replaceSnapshot(id,snapshot){
      assertLive();const run=tx.workspace.runs[id],file=Object.values(tx.workspace.files||{}).find(file=>file.runId===id&&file.kind==='run_snapshot');
      if(!run||!file||file.snapshotRecordId!==snapshot.recordId||!UUID_RE.test(snapshot.recordId))throw packageError('snapshot_identity_conflict','快照稳定身份不一致。');
      const intent=tx.control?.ownershipTransfers?.[snapshot.recordId],exclusive=options.operationLease&&tx.workspace.operationLeases?.[options.operationLease.operationId];
      const transferring=intent?.phase==='prepared'&&intent.to===snapshot.ownerPackageId&&[intent.from,intent.to].includes(run.ownerPackageId);
      if(!transferring&&!(exclusive&&exclusive.token===options.operationLease.token&&['restore','upgrade'].includes(exclusive.kind)))
        throw packageError('snapshot_replace_forbidden','快照替换需要持久转移意图或恢复授权。');
      const filename=snapshotPath(dataDir,id),relative=path.relative(dataDir,filename).split(path.sep).join('/');
      if(file.path!==relative)throw packageError('snapshot_identity_conflict','受管快照路径不一致。');
      await assertSnapshotPath(dataDir,filename,fsAdapter,{allowMissing:true});
      const expectedOwner=transferring?intent.to:run.ownerPackageId;
      if(snapshot.ownerPackageId!==expectedOwner||(snapshot.run?.ownerPackageId&&snapshot.run.ownerPackageId!==expectedOwner))throw packageError('snapshot_identity_conflict','快照归属不一致。');
      let old;
      try{old=await readSnapshot(id);}catch(error){
        if(error.code!=='ENOENT'||transferring)throw error;
        if(file.hash!==contentHash(snapshot))throw packageError('snapshot_identity_conflict','恢复快照哈希不一致。');
        await writeAtomicJson(filename,snapshot,{fsAdapter});return {path:relative,hash:contentHash(snapshot)};
      }
      if(old.recordId!==snapshot.recordId)throw packageError('snapshot_identity_conflict','现有快照身份不一致。');
      const journal=tx.control?.migrationJournal?.ownershipTransferSnapshots?.[intent?.operationId]?.[snapshot.recordId];
      if(transferring&&(!journal||contentHash(snapshot)!==journal.toHash||![journal.fromHash,journal.toHash].includes(contentHash(old))))
        throw packageError('snapshot_identity_conflict','快照哈希与转移准备记录不一致。');
      if(contentHash(old)!==contentHash(snapshot))await writeAtomicJson(filename,snapshot,{fsAdapter});
      return {path:relative,hash:contentHash(snapshot)};
    },
    async removeManagedFile(fileId){
      assertLive();const file=tx.workspace.files?.[fileId]||Object.values(tx.control?.purgeTasks||{}).flatMap(task=>task.files||[]).find(file=>file.recordId===fileId);
      if(!file||typeof file.path!=='string'||!/^(?:runs-v2|runs|backups)\/[A-Za-z0-9_.-]+\.json$/.test(file.path))throw packageError('purge_file_failed','受管理文件身份无效。',503);
      const filename=path.join(dataDir,file.path);await assertSnapshotPath(dataDir,filename,fsAdapter,{allowMissing:true});
      await fsAdapter.unlink(filename).catch(error=>{if(error.code!=='ENOENT')throw error;});
    },
  };
}
