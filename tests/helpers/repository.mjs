import { createTempDir, registerTestResource } from "./fixtures.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
export async function tempRepository(t, options = {}) {
  const repository=await openWorkspaceRepository({allowLegacy:true,
    dataDir: await createTempDir(t),
    ...options,
  });
  registerTestResource(t,()=>repository.close());
  return repository;
}
