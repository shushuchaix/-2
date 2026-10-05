import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createRunService } from "../../src/application/run-service.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { RunGate } from "../../src/limits.mjs";
import { createTempDir, job, profile, target } from "../helpers/fixtures.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { recoverWorkspace } from "../../src/infrastructure/storage/recovery.mjs";
async function fixture(t, providers, gate) {
  const repository = await openWorkspaceRepository({
      dataDir: await createTempDir(t),
    }),
    workspaceService = createWorkspaceService({ repository }),
    jobService = createJobService({ repository }),
    evaluationService = createEvaluationService({ repository });
  const p = await workspaceService.saveProfile({ profile: profile() }),
    tar = await workspaceService.saveTarget({
      ...target(),
      sourceIds: providers.map((p) => p.id),
      profileRevisionId: p.revisionId,
    });
  const catalog = providers.map((p) => ({
    siteId: p.id + "-1",
    providerId: p.id,
    category: "job_board",
    name: p.id,
    origin: "https://example.com",
    status: "ready",
  }));
  return {
    repository,
    workspaceService,
    jobService,
    p,
    tar,
    service: createRunService({
      repository,
      workspaceService,
      jobService,
      evaluationService,
      registry: createSourceRegistry(providers),
      requestFactory: () => async () => {
        throw Error("Unexpected network");
      },
      runGate: gate,
      catalog,
    }),
  };
}
test("partial runs retain all raw facts and manual state with immutable target snapshots", async (t) => {
  const records = [
    job(),
    job({
      sourceRecordId: "2",
      title: "不相关岗位",
      description: "博士以上，负责完全不同方向的研究及实施工作。",
      degree: "博士",
    }),
  ];
  const f = await fixture(t, [
    fakeProvider({ records, duplicate: true }),
    fakeProvider({ id: "failed", fail: true }),
  ]);
  const prior = await f.jobService.ingestRecords({
    runId: "previous",
    records: [job({ sourceRecordId: "old" })],
  });
  await f.jobService.updateApplication(prior.jobIds[0], {
    status: "applied",
    note: "我的备注",
  });
  const { runId } = await f.service.startRun({
    targetRevisionId: f.tar.revisionId,
    mode: "rules",
  });
  await f.workspaceService.saveTarget({ ...f.tar, roles: ["新方向"] });
  const result = await f.service.waitForRun(runId);
  assert.equal(result.run.status, "partial");
  assert.equal(result.run.counts.normalized, 2);
  assert.equal(result.run.counts.deduplicated, 2);
  assert.equal(result.run.targetSnapshot.revisionId, f.tar.revisionId);
  const w = await f.repository.read();
  assert.equal(Object.keys(w.jobs).length, 3);
  assert.equal(w.applications[prior.jobIds[0]].note, "我的备注");
  assert.ok(result.evaluations.some((e) => e.qualification.status === "fail"));
  assert.ok(result.run.snapshotRef.hash);
});
test("empty and all failed outcomes differ and queued cancellation releases one permit", async (t) => {
  const empty = await fixture(t, [fakeProvider({ records: [] })]);
  const e = await empty.service.startRun({
    targetRevisionId: empty.tar.revisionId,
    mode: "rules",
  });
  assert.equal(
    (await empty.service.waitForRun(e.runId)).run.status,
    "completed",
  );
  const failed = await fixture(t, [fakeProvider({ fail: true })]);
  const x = await failed.service.startRun({
    targetRevisionId: failed.tar.revisionId,
    mode: "rules",
  });
  assert.equal((await failed.service.waitForRun(x.runId)).run.status, "failed");
  const gate = new RunGate({
    maxConcurrent: 1,
    persist: false,
    perIpCooldownMs: 0,
    dailyPerIp: 100,
  });
  let arrived;
  const started = new Promise((r) => (arrived = r));
  let release;
  const unblock = new Promise((r) => (release = r));
  const f = await fixture(
    t,
    [
      fakeProvider({
        hold: async (ctx) => {
          arrived();
          await Promise.race([
            unblock,
            delay(10000, undefined, { signal: ctx.signal, ref: false }),
          ]);
        },
      }),
    ],
    gate,
  );
  const first = await f.service.startRun({
    targetRevisionId: f.tar.revisionId,
    mode: "rules",
  });
  await started;
  const second = await f.service.startRun({
    targetRevisionId: f.tar.revisionId,
    mode: "rules",
  });
  await f.service.cancelRun(second.runId);
  await f.service.cancelRun(second.runId);
  assert.equal(
    (await f.service.waitForRun(second.runId)).run.status,
    "cancelled",
  );
  assert.equal(gate.active, 1);
  release();
  await f.service.waitForRun(first.runId);
  assert.equal(gate.active, 0);
});
test("running cancellation saves already ingested observations and terminal snapshot", async (t) => {
  let began;
  const started = new Promise((r) => (began = r));
  const f = await fixture(t, [
    fakeProvider({
      hold: async (ctx) => {
        began();
        await delay(10000, undefined, { signal: ctx.signal, ref: false });
      },
    }),
  ]);
  const { runId } = await f.service.startRun({
    targetRevisionId: f.tar.revisionId,
    mode: "ai",
    credentials: { userApiKey: "NEVER-PERSIST" },
  });
  await started;
  await f.service.cancelRun(runId);
  const snapshot = await f.service.waitForRun(runId);
  assert.equal(snapshot.run.status, "cancelled");
  assert.equal(snapshot.jobs.length, 1);
  assert.ok(
    !JSON.stringify(await f.repository.read()).includes("NEVER-PERSIST"),
  );
});
test("coverage limits are partial and snapshot write failure is explicit", async (t) => {
  const f = await fixture(t, [fakeProvider({ truncated: true })]);
  const { runId } = await f.service.startRun({
    targetRevisionId: f.tar.revisionId,
    mode: "ai",
  });
  const result = await f.service.waitForRun(runId);
  assert.equal(result.run.status, "partial");
  assert.equal(result.run.degraded, true);
  const broken = await fixture(t, [fakeProvider()]);
  broken.repository.writeRunSnapshot = async () => {
    throw Error("injected snapshot failure");
  };
  const started = await broken.service.startRun({
    targetRevisionId: broken.tar.revisionId,
    mode: "rules",
  });
  await assert.rejects(broken.service.waitForRun(started.runId), /injected/);
  const persisted = await broken.service.getRun(started.runId);
  assert.equal(persisted.status, "failed");
  assert.ok(persisted.issues.some((i) => i.code === "snapshot_failed"));
});
test("a second entry preserves live owner tasks and requests cancellation through authority", async (t) => {
  let began, release;
  const started = new Promise((r) => (began = r)),
    unblock = new Promise((r) => (release = r));
  const provider = fakeProvider({
      hold: async (ctx) => {
        began();
        await Promise.race([
          unblock,
          delay(10000, undefined, { signal: ctx.signal, ref: false }),
        ]);
      },
    }),
    f = await fixture(t, [provider]);
  const run = await f.service.startRun({
    targetRevisionId: f.tar.revisionId,
    mode: "rules",
  });
  await started;
  try {
    await recoverWorkspace(f.repository);
    assert.equal((await f.service.getRun(run.runId)).status, "running");
    const other = createRunService({
      repository: f.repository,
      workspaceService: f.workspaceService,
      jobService: f.jobService,
      evaluationService: createEvaluationService({ repository: f.repository }),
      registry: createSourceRegistry([provider]),
      requestFactory: () => () => {
        throw Error("network forbidden");
      },
    });
    await other.cancelRun(run.runId);
    assert.equal(
      (await f.service.waitForRun(run.runId)).run.status,
      "cancelled",
    );
  } finally {
    release();
    await f.service.waitForRun(run.runId);
  }
});
