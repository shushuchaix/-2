import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";

test("healthy diagnostic storage keeps its existing shape", async (t) => {
  const log = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  await log.record({ operation: "desktop.start" });
  assert.deepEqual((await log.list()).storage, { mode: "file", pendingWrites: 0, droppedWrites: 0, failedWrites: 0 });
});

for (const [label, thrown, code] of [
  ["private error", Object.assign(Error("private-canary-message"), { code: "private-canary-code", path: "private-canary-path", token: "private-canary-token" }), "diagnostic_storage_error"],
  ["null", null, "diagnostic_storage_error"],
  ["string", "private-canary-text", "diagnostic_storage_error"],
  ["allowlisted filesystem error", Object.assign(Error("private-canary-message"), { code: "ENOSPC", path: "private-canary-path" }), "ENOSPC"],
  ["throwing code accessor", Object.defineProperty({}, "code", { get() { throw Error("private-canary-accessor"); } }), "diagnostic_storage_error"],
]) {
  test(`diagnostic ${label} reports only a fixed code and actual catch boundary`, async (t) => {
    const log = createDiagnosticsLog({
      dataDir: await createTempDir(t),
      fsAdapter: { ...fs, mkdir: async () => { throw thrown; } },
    });
    await log.record({ operation: "desktop.start" });
    const result = await log.list();
    assert.equal(result.storage.failureCode, code);
    assert.equal(result.storage.failurePhase, "normal_directory");
    assert.equal(result.storage.failedWrites, 1);
    const exported = await log.exportText();
    assert.ok(exported.includes(code));
    assert.doesNotMatch(JSON.stringify(result.storage) + exported, /private-canary/);
  });
}

test("diagnostic write failures retain filesystem codes without claiming an unobserved leaf phase", async (t) => {
  const log = createDiagnosticsLog({
    dataDir: await createTempDir(t),
    fsAdapter: { ...fs, appendFile: async () => { throw Object.assign(Error("private-canary"), { code: "EIO" }); } },
  });
  await log.record({ operation: "desktop.start" });
  const result = await log.list();
  assert.equal(result.storage.failureCode, "EIO");
  // normal_turn includes acquisition, pruning, appending and owner release.
  assert.equal(result.storage.failurePhase, "normal_turn");
  assert.equal(result.storage.pendingWrites, 0);
  assert.doesNotMatch(await log.exportText(), /private-canary/);
});

test("diagnostic fatal contention exposes its fixed busy code without stealing ownership", async (t) => {
  const dataDir = await createTempDir(t), lock = path.join(dataDir, "logs", ".application-fatal.lock");
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, owner);
  const log = createDiagnosticsLog({ dataDir });
  log.recordFatal({ operation: "desktop.failure" });
  const result = await log.list();
  assert.equal(result.storage.failureCode, "diagnostic_lock_busy");
  assert.equal(result.storage.failurePhase, "fatal_turn");
  assert.equal(result.storage.failedWrites, 1);
  assert.equal(await fs.readFile(lock, "utf8"), owner);
});
