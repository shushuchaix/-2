import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { tempRepository } from "../helpers/repository.mjs";
import {
  profile,
  target,
  namedTargetInput,
  job,
} from "../helpers/fixtures.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { createRunService } from "../../src/application/run-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
const gateModule = () =>
  import("../../src/application/workspace-operations.mjs");
const busy = (e) => e.code === "workspace_operation_busy" && e.status === 409;
async function setup(t) {
  const repository = await tempRepository(t),
    ws = createWorkspaceService({ repository });
  const p = await ws.saveProfile({ profile: profile() }),
    tar = await ws.saveTarget(
      namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
    );
  return { repository, ws, p, tar };
}
test("cross-repository shared leases block exclusive operations and guard business writes", async (t) => {
  const repository = await tempRepository(t),
    other = await openWorkspaceRepository({ dataDir: repository.dataDir });
  const { createWorkspaceOperationGate } = await gateModule();
  const a = createWorkspaceOperationGate({ repository }),
    b = createWorkspaceOperationGate({ repository: other });
  const shared = await a.acquire("import");
  await assert.rejects(b.acquire("cleanup"), busy);
  await shared.release();
  const exclusive = await b.acquire("cleanup");
  await assert.rejects(
    repository.mutateWorkspace((w) => {
      w.settings.example = true;
    }),
    busy,
  );
  await assert.rejects(
    repository.mutateWorkspace(
      (w) => {
        w.settings.example = true;
      },
      { operationMaintenance: true },
    ),
    /maintenance/i,
  );
  await assert.rejects(
    repository.writeRunSnapshot("test", { runId: "test" }),
    busy,
  );
  await assert.rejects(
    repository.mutateWorkspace(() => {}, {
      operationLease: { ...exclusive, token: "forged" },
    }),
    (e) => e.code === "invalid_operation_lease",
  );
  await other.mutateWorkspace(
    (w) => {
      w.settings.example = true;
    },
    { operationLease: exclusive },
  );
  await exclusive.release();
  assert.deepEqual((await repository.read()).operationLeases, {});
});
test("real child-process lease blocks cleanup and is removed only after owner release", async (t) => {
  const repository = await tempRepository(t),
    { createWorkspaceOperationGate } = await gateModule();
  const child = fork(
    new URL("../helpers/operation-process.mjs", import.meta.url),
    [repository.dataDir],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  t.after(() => child.kill());
  const [message] = await once(child, "message");
  assert.equal(message.ready, true);
  await assert.rejects(
    createWorkspaceOperationGate({ repository }).acquire("cleanup"),
    busy,
  );
  const exited = once(child, "exit");
  child.send("release");
  await exited;
  const lease = await createWorkspaceOperationGate({ repository }).acquire(
    "cleanup",
  );
  await lease.release();
});
test("a simultaneous collection and cleanup registration can only have one winner", async (t) => {
  const repository = await tempRepository(t),
    other = await openWorkspaceRepository({ dataDir: repository.dataDir }),
    { createWorkspaceOperationGate } = await gateModule();
  const results = await Promise.allSettled([
    createWorkspaceOperationGate({ repository }).acquire("cleanup"),
    createWorkspaceOperationGate({ repository: other }).acquire("collect"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(busy(results.find((r) => r.status === "rejected").reason));
  await results.find((r) => r.status === "fulfilled").value.release();
});
test("live owners survive recovery, dead owners clear, cancellation and exceptions release", async (t) => {
  const repository = await tempRepository(t),
    { createWorkspaceOperationGate } = await gateModule();
  const a = createWorkspaceOperationGate({ repository }),
    lease = await a.acquire("import");
  await assert.rejects(a.acquire("cleanup"), busy);
  const dead = createWorkspaceOperationGate({
      repository,
      isOwnerAlive: () => false,
    }),
    exclusive = await dead.acquire("cleanup");
  await exclusive.release();
  await assert.rejects(
    lease.release(),
    (e) => e.code === "invalid_operation_lease",
  );
  await assert.rejects(
    a.withOperation("import", {}, () => {
      throw Error("expected action failure");
    }),
    /expected action/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    a.acquire("import", { signal: controller.signal }),
    /abort/i,
  );
  assert.deepEqual((await repository.read()).operationLeases, {});
  const revision = (await repository.read()).revision;
  const next = await a.acquire("import");
  await next.release();
  await assert.rejects(
    a.acquire("cleanup", { expectedWorkspaceRevision: revision }),
    (e) => e.code === "duplicate_preview_stale",
  );
});
test("collection holds its lease through final snapshot and protects indirect profile archive", async (t) => {
  const { repository, ws, p, tar } = await setup(t),
    { createWorkspaceOperationGate } = await gateModule();
  const gate = createWorkspaceOperationGate({ repository }),
    jobs = createJobService({ repository });
  let enter, finish;
  const reached = new Promise((r) => (enter = r)),
    released = new Promise((r) => (finish = r)),
    write = repository.writeRunSnapshot;
  repository.writeRunSnapshot = async (...args) => {
    enter();
    await released;
    return write(...args);
  };
  const service = createRunService({
    repository,
    workspaceService: ws,
    jobService: jobs,
    evaluationService: createEvaluationService({ repository }),
    registry: createSourceRegistry([fakeProvider({ records: [job()] })]),
    catalog: [
      {
        siteId: "synthetic-1",
        providerId: "synthetic",
        origin: "https://example.com",
        status: "ready",
        category: "job_board",
      },
    ],
    requestFactory: () => () => {
      throw Error("Network forbidden");
    },
  });
  const { runId } = await service.startRun({
    targetRevisionId: tar.revisionId,
  });
  await reached;
  await assert.rejects(gate.acquire("cleanup"), busy);
  await assert.rejects(
    ws.archiveVersion({
      kind: "profile",
      parentId: p.profileId,
      revisionId: p.revisionId,
    }),
    busy,
  );
  await ws.updateVersion({
    kind: "target",
    parentId: tar.targetId,
    revisionId: tar.revisionId,
    enabled: false,
  });
  finish();
  await service.waitForRun(runId);
  assert.deepEqual((await repository.read()).operationLeases, {});
  await ws.archiveVersion({
    kind: "profile",
    parentId: p.profileId,
    revisionId: p.revisionId,
  });
  await assert.rejects(service.startRun({ targetRevisionId: tar.revisionId }));
  await assert.rejects(
    createEvaluationService({ repository }).rescore({
      jobIds: Object.keys((await repository.read()).jobs),
      profileRevisionId: p.revisionId,
      targetRevisionId: tar.revisionId,
    }),
    (e) => e.code === "version_archived",
  );
  const restored = await ws.restoreVersion({
    kind: "profile",
    parentId: p.profileId,
    revisionId: p.revisionId,
  });
  assert.equal(restored.revisionId, p.revisionId);
});
test("standalone scoring remains active until evaluation persistence finishes", async (t) => {
  const { repository, ws, p, tar } = await setup(t),
    { createWorkspaceOperationGate } = await gateModule(),
    jobs = createJobService({ repository });
  const { jobIds } = await jobs.ingestRecords({
    runId: "fixture",
    targetRevisionId: tar.revisionId,
    records: [job()],
  });
  let enter, finish;
  const reached = new Promise((r) => (enter = r)),
    release = new Promise((r) => (finish = r));
  const service = createEvaluationService({
    repository,
    modelFactory: () => ({
      available: true,
      model: "synthetic",
      chatJson: async () => {
        enter();
        await release;
        return { results: [] };
      },
    }),
  });
  const pending = service.rescore({
    jobIds,
    profileRevisionId: p.revisionId,
    targetRevisionId: tar.revisionId,
    mode: "ai",
  });
  await reached;
  await assert.rejects(
    createWorkspaceOperationGate({ repository }).acquire("cleanup"),
    busy,
  );
  finish();
  await pending;
  assert.deepEqual((await repository.read()).operationLeases, {});
});
