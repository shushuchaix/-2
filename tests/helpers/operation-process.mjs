import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
try {
  const { createWorkspaceOperationGate } = await import(
    "../../src/application/workspace-operations.mjs"
  );
  const repository = await openWorkspaceRepository({
    dataDir: process.argv[2],
  });
  const lease = await createWorkspaceOperationGate({ repository }).acquire(
    "import",
  );
  process.send({ ready: true, operationId: lease.operationId });
  process.on("message", async (message) => {
    if (message === "release") {
      await lease.release();
      process.exit(0);
    }
  });
} catch (error) {
  process.send?.({ error: error.code || "worker_failed" });
  process.exit(1);
}
