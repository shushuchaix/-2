import { openWorkspaceRepository } from '../../src/infrastructure/storage/repository.mjs';
const repo=await openWorkspaceRepository({dataDir:process.argv[2]});
await repo.mutateWorkspace(w=>w.recoveryRecords.push({message:process.argv[3]}));
