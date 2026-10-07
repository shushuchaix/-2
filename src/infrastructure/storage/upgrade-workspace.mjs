import {normalizeWorkspaceExtensions,needsWorkspaceUpgrade} from '../../domain/workspace-management.mjs';
import {createBackup} from './backup.mjs';
export async function upgradeWorkspace({repository,clock=repository.clock}) {
  if (!needsWorkspaceUpgrade(await repository.read())) return {changed:false,backupId:null};
  return (await repository.mutateWorkspace(async w => {
    if (!needsWorkspaceUpgrade(w)) return {changed:false,backupId:null};
    const normalized = normalizeWorkspaceExtensions(w);
    const backup = w.revision > 0 ? await createBackup({repository,clock,workspaceSnapshot:w}) : null;
    Object.assign(w,normalized);
    return {changed:true,backupId:backup?.backupId || null};
  })).result;
}
