import { createTempDir } from "./fixtures.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
export async function tempRepository(t, options = {}) {
  return openWorkspaceRepository({allowLegacy:true,
    dataDir: await createTempDir(t),
    ...options,
  });
}
