import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "../helpers/fixtures.mjs";
import { createDiagnosticWriteBarrier } from "../helpers/diagnostic-write-barrier.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";

test("accepted diagnostic observation is not physical completion and restart waits for the actual owner release", async (t) => {
  const dataDir = await createTempDir(t);
  let release, entered = false;
  const hold = new Promise((resolve) => { release = resolve; });
  const completion = createDiagnosticWriteBarrier({ dataDir, fsAdapter: {
    ...fs,
    async appendFile(...args) { entered = true; await hold; return fs.appendFile(...args); },
  } });
  const log = createDiagnosticsLog({ dataDir, fsAdapter: completion.fsAdapter, maxMemoryEntries: 0 });
  const recording = log.record({ operation: "desktop.failure", body: "private-canary" }, Error("private-canary"));
  let entry;
  try {
    entry = await recording;
    assert.equal(entered, true);
    assert.equal(completion.releaseCount, 0);
    const reopenedBefore = await createDiagnosticsLog({ dataDir }).list();
    assert.equal(reopenedBefore.entries.length, 0);
    assert.equal((await fs.readdir(path.join(dataDir, "logs"))).includes(".application.lock"), true);
  } finally { release(); }
  await completion.waitForWrites(1, { phase: "held_append", releaseHold: release });
  const result = await createDiagnosticsLog({ dataDir }).list();
  assert.equal(completion.releaseCount, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].diagnosticId, entry.diagnosticId);
  assert.doesNotMatch(JSON.stringify(result), /private-canary/);
  const original = await log.list();
  assert.equal(original.storage.pendingWrites, 0);
  assert.equal(original.storage.failedWrites, 0);
});

test("fixture watchdog fails on missing actual release and only releases an artificial hold", async (t) => {
  const dataDir = await createTempDir(t), lock = path.join(dataDir, "logs", ".application.lock");
  await fs.mkdir(path.dirname(lock)); await fs.writeFile(lock, "protected-owner");
  const denied = Object.assign(Error("synthetic unlink denied"), { code: "EPERM" });
  const completion = createDiagnosticWriteBarrier({ dataDir, fsAdapter: { ...fs, unlink: async () => { throw denied; } } });
  await assert.rejects(completion.fsAdapter.unlink(lock), (error) => error === denied);
  assert.equal(completion.releaseCount, 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let artificialHoldReleases = 0;
  const waiting = completion.waitForWrites(1, { phase: "missing_release", releaseHold: () => artificialHoldReleases++ });
  const rejection = assert.rejects(waiting, { code: "physical_release_missing", phase: "missing_release", releaseCount: 0, expectedCount: 1 });
  t.mock.timers.tick(5000);
  await rejection;
  assert.equal(artificialHoldReleases, 1);
  assert.equal(await fs.readFile(lock, "utf8"), "protected-owner");
});

test("completion adapter delegates existing methods and counts only successful exact owner unlinks", async (t) => {
  const dataDir = await createTempDir(t), lock = path.join(dataDir, "logs", ".application.lock");
  const calls = [];
  const marker = () => "unchanged";
  const adapter = { appendFile: marker, async unlink(...args) { assert.equal(this, adapter); calls.push(args); } };
  const completion = createDiagnosticWriteBarrier({ dataDir, fsAdapter: adapter });
  assert.equal(completion.fsAdapter.appendFile, marker);
  assert.equal("mkdir" in completion.fsAdapter, false);
  await completion.fsAdapter.unlink(lock + ".other");
  assert.equal(completion.releaseCount, 0);
  await completion.fsAdapter.unlink(lock);
  await completion.waitForWrites(1);
  assert.equal(completion.releaseCount, 1);
  assert.deepEqual(calls, [[lock + ".other"], [lock]]);
});
