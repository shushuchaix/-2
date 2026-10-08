import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tempRepository } from "../helpers/repository.mjs";
import { profile, target, job, AT } from "../helpers/fixtures.mjs";
import { createApplicationContext } from "../../src/application/context.mjs";
import { loadConfig } from "../../src/config.mjs";
import { assertWorkspace } from "../../src/domain/contracts.mjs";
import {
  createBackup,
  restoreBackup,
} from "../../src/infrastructure/storage/backup.mjs";

async function legacy(t) {
  const repository = await tempRepository(t);
  await repository.mutateWorkspace((w) => {
    w.profiles.p1 = [
      {
        profileId: "p1",
        revision: 1,
        revisionId: "p1@1",
        profile: profile(),
        text: "合成画像正文",
        contentHash: "original",
        createdAt: AT,
      },
    ];
    w.targets.t1 = [target()];
    w.jobs.j1 = {
      jobId: "j1",
      kind: "job",
      canonical: job(),
      firstSeen: AT,
      lastSeen: AT,
    };
    w.observations.o1 = {
      observationId: "o1",
      jobId: "j1",
      fields: job(),
      contentHash: "original-observation",
    };
  });
  return repository;
}
async function start(repository) {
  const cfg = loadConfig({ quiet: true, dataDir: repository.dataDir });
  cfg.deepseek.apiKey = "";
  return createApplicationContext({
    cfg,
    dataDir: repository.dataDir,
    dependencies: { repository },
  });
}
test("upgrade is idempotent and preserves facts", async (t) => {
  const repository = await legacy(t),
    before = await repository.read();
  const first = await start(repository),
    after = await repository.read();
  assert.equal(after.managementVersion, 1);
  assert.match(after.versionMetadata["t1@1"].versionName, /Java开发.*v1/);
  assert.deepEqual(after.profiles, before.profiles);
  assert.deepEqual(after.observations, before.observations);
  assert.equal(first.managementUpgrade.changed, true);
  const backups = await fs.readdir(path.join(repository.dataDir, "backups"));
  assert.equal(backups.length, 1);
  const archive = JSON.parse(
    await fs.readFile(
      path.join(repository.dataDir, "backups", backups[0]),
      "utf8",
    ),
  );
  assert.equal(archive.workspace.managementVersion, undefined);
  const second = await start(repository);
  assert.equal(second.managementUpgrade.changed, false);
  assert.equal(
    (await fs.readdir(path.join(repository.dataDir, "backups"))).length,
    1,
  );
});
test("old restore replaces extension state", async (t) => {
  const repository = await legacy(t),
    backup = await createBackup({ repository });
  await start(repository);
  await repository.mutateWorkspace((w) => {
    w.jobRedirects ||= {};
    w.dedupOperations ||= {};
    w.jobRedirects.removed = {
      toJobId: "j1",
      operationId: "merge",
      mergedAt: AT,
    };
    w.dedupOperations.merge = {
      at: AT,
      planHash: "old",
      counts: {},
      backupId: "old.json",
    };
  });
  await restoreBackup({ repository, archivePath: backup.path });
  const restored = await repository.read();
  assert.deepEqual(restored.jobRedirects, {});
  assert.deepEqual(restored.targetMembers, {});
  assert.deepEqual(restored.dedupOperations, {});
  assert.equal(restored.managementVersion, 1);
  assert.equal(restored.profiles.p1[0].contentHash, "original");
});
test("failed upgrade keeps valid workspace", async (t) => {
  const repository = await legacy(t);
  await repository.mutateWorkspace((w) => {
    w.runs.r1 = {
      runId: "r1",
      snapshotRef: { path: "runs-v2/r1.json", hash: "missing" },
    };
  });
  const before = await repository.read();
  await assert.rejects(start(repository));
  const after = await repository.read();
  assert.deepEqual(
    { ...after, revision: before.revision, operationLeases: undefined },
    { ...before, operationLeases: undefined },
  );
  assert.deepEqual(after.operationLeases, {});
});
test("extension validation rejects corrupt shapes names and redirect cycles", async (t) => {
  const repository = await legacy(t);
  await start(repository);
  const good = await repository.read();
  assert.throws(
    () => assertWorkspace({ ...good, versionMetadata: [] }),
    /versionMetadata/,
  );
  const cycle = structuredClone(good);
  cycle.jobRedirects.a = { toJobId: "b", operationId: "x", mergedAt: AT };
  cycle.jobRedirects.b = { toJobId: "a", operationId: "x", mergedAt: AT };
  assert.throws(() => assertWorkspace(cycle), /redirect/i);
  const duplicate = structuredClone(good);
  duplicate.targets.t2 = [target({ targetId: "t2", revisionId: "t2@1" })];
  duplicate.versionMetadata["t2@1"] = { ...duplicate.versionMetadata["t1@1"] };
  assert.throws(() => assertWorkspace(duplicate), /name/i);
});
