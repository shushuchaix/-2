import fs from 'node:fs/promises';
import path from 'node:path';
import {createTempDir} from './fixtures.mjs';
import {createFakeClock} from './clock.mjs';
import {openWorkspaceRepository} from '../../src/infrastructure/storage/repository.mjs';
import {openPackageControl,createEmptyControl} from '../../src/infrastructure/storage/package-control.mjs';
import {createEmptyWorkspace} from '../../src/domain/contracts.mjs';
export function failOnce(fsAdapter,phase) {
  let armed=phase;
  const match={control_commit:'state.json',workspace_commit:'workspace.v2.json',previous_commit:'workspace.v2.previous.json',snapshot_write:'runs-v2',backup_replace:'backups'};
  return {...fsAdapter,arm(when){armed=when;},async rename(from,to){
    if(armed&&String(to).includes(match[armed]||'never')){armed=null;throw Error('synthetic storage failure');}
    return fsAdapter.rename(from,to);
  },async unlink(file){if(armed==='file_cleanup'&&!String(file).endsWith('.tmp')){armed=null;throw Error('synthetic storage failure');}return fsAdapter.unlink(file);}};
}
export async function packageFixture(t,options={}) {
  const dataDir=options.dataDir||await createTempDir(t),clock=options.clock||createFakeClock('2026-10-09T00:00:00.000Z');
  const adapter=failOnce(fs,null);
  const f={clock,armFailure:phase=>adapter.arm(phase)};
  async function open(){f.repository=await openWorkspaceRepository({dataDir,clock,fsAdapter:adapter});f.control=openPackageControl({dataDir,fsAdapter:adapter});}
  await open();
  if((await f.repository.read()).schemaVersion!==3)await f.repository.withMaintenanceTransaction(async tx=>{
    await tx.commitControl(tx.control||createEmptyControl());
    await tx.commitWorkspace(createEmptyWorkspace({schemaVersion:3}));
  },{bootstrap:true});
  f.reopen=async()=>{await open();return f;};
  if(options.failPhase)f.armFailure(options.failPhase);
  return f;
}
