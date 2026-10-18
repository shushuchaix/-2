import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { withDiagnosticFatalTurn, getDiagnosticFatalFailureFacts } from "../../src/infrastructure/diagnostics/coordination.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";

const keys = ["configuredTimeoutMs", "acquisitionElapsedMs", "prepareCallElapsedMs", "acquireProbeCount", "totalWaitRequestedMs", "actualWaitMs", "lastStage"];
const fixture = async (t) => {
  const dir = await createTempDir(t);
  return { dir, lock: path.join(dir, ".fatal.lock") };
};
function clock(t) {
  const state = { wall: 0, mono: 0 };
  t.mock.method(Date, "now", () => state.wall);
  t.mock.method(performance, "now", () => state.mono);
  return state;
}
function caught(action) {
  try { action(); assert.fail("expected busy"); }
  catch (error) { assert.equal(error.code, "diagnostic_lock_busy"); return error; }
}

test("fatal facts provenance ignores hostile getters, proxies, and forged busy errors", () => {
  let reads = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["code", "metadata", "failureFacts"].map((key) => [key, { get() { reads++; throw Error("private-canary"); } }])));
  const proxy = new Proxy({}, { get() { reads++; throw Error("private-canary"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const error of [hostile, proxy, revoked.proxy, Object.assign(Error("private-canary"), { code: "diagnostic_lock_busy", failureFacts: { configuredTimeoutMs: 1 } }), null, undefined, "private-canary", 1]) {
    assert.equal(getDiagnosticFatalFailureFacts(error), undefined);
  }
  assert.equal(reads, 0);
});

test("publication busy facts separate configured budget, preparation and cleanup elapsed", async (t) => {
  const { lock } = await fixture(t), owner = JSON.stringify({ pid: process.pid, token: "preserved-owner" });
  fs.writeFileSync(lock, owner);
  const state = clock(t), sync = fs.fsyncSync, link = fs.linkSync, unlink = fs.unlinkSync;
  t.mock.method(fs, "fsyncSync", (...args) => { sync(...args); state.mono += 7; });
  t.mock.method(fs, "linkSync", (...args) => { state.wall = 310; state.mono += 303; return link(...args); });
  t.mock.method(fs, "unlinkSync", (...args) => { state.mono += 1000; return unlink(...args); });
  const facts = getDiagnosticFatalFailureFacts(caught(() => withDiagnosticFatalTurn(lock, () => assert.fail("must not own"))));
  assert.deepEqual(facts, { configuredTimeoutMs: 250, acquisitionElapsedMs: 310, prepareCallElapsedMs: 7, acquireProbeCount: 1, totalWaitRequestedMs: 0, actualWaitMs: 0, lastStage: "publication" });
  assert.ok(Object.isFrozen(facts));
  assert.equal(state.mono, 1310);
  assert.equal(fs.readFileSync(lock, "utf8"), owner);
});

test("legacy guard facts retain conflict stage after measured waits without changing owner", async (t) => {
  const { lock } = await fixture(t), guard = lock + ".reclaim", bytes = "private-canary-legacy-owner";
  fs.writeFileSync(guard, bytes);
  const state = clock(t); let waits = 0;
  t.mock.method(Atomics, "wait", (_buffer, _index, _value, timeout) => {
    assert.equal(timeout, 5); waits++; state.wall += 260; state.mono += 275; return "timed-out";
  });
  const facts = getDiagnosticFatalFailureFacts(caught(() => withDiagnosticFatalTurn(lock, () => assert.fail("must not own"))));
  assert.deepEqual(facts, { configuredTimeoutMs: 250, acquisitionElapsedMs: 275, prepareCallElapsedMs: 0, acquireProbeCount: 2, totalWaitRequestedMs: 5, actualWaitMs: 275, lastStage: "legacy_guard" });
  assert.equal(waits, 1);
  assert.equal(fs.readFileSync(guard, "utf8"), bytes);
  assert.equal(fs.existsSync(lock), false);
});

test("an exclusive preparation collision has its own factual stage", async (t) => {
  const { lock } = await fixture(t), state = clock(t);
  t.mock.method(fs, "openSync", () => { state.wall = 300; state.mono = 310; throw Object.assign(Error("private-canary"), { code: "EEXIST" }); });
  const facts = getDiagnosticFatalFailureFacts(caught(() => withDiagnosticFatalTurn(lock, () => assert.fail("must not own"))));
  assert.equal(facts.lastStage, "preparation");
  assert.equal(facts.prepareCallElapsedMs, 310);
  assert.equal(facts.acquisitionElapsedMs, 310);
  assert.equal(facts.acquireProbeCount, 1);
  assert.equal(fs.existsSync(lock), false);
});

test("storage and export include only owned facts and clear them on the next unrelated failure", async (t) => {
  const dataDir = await createTempDir(t), dir = path.join(dataDir, "logs"), lock = path.join(dir, ".application-fatal.lock");
  fs.mkdirSync(dir); fs.writeFileSync(lock + ".reclaim", "private-canary-owner");
  const state = clock(t), stat = fs.statSync;
  t.mock.method(fs, "statSync", (...args) => { const value = stat(...args); if (args[0] === lock + ".reclaim") { state.wall += 300; state.mono += 320; } return value; });
  const log = createDiagnosticsLog({ dataDir });
  log.recordFatal({ operation: "desktop.failure" });
  const first = (await log.list()).storage;
  assert.equal(first.failureCode, "diagnostic_lock_busy");
  assert.deepEqual(Object.keys(first.failureFacts), keys);
  assert.equal(first.failureFacts.acquisitionElapsedMs, 320);
  assert.ok(Object.isFrozen(first.failureFacts));
  const exported = await log.exportText();
  assert.match(exported, /"configuredTimeoutMs":250/);
  assert.match(exported, /"lastStage":"legacy_guard"/);
  assert.doesNotMatch(JSON.stringify(first) + exported, /private-canary/);
  let metadataReads = 0;
  const mkdir = fs.mkdirSync;
  const forged = Object.assign(Error("private-canary"), { code: "diagnostic_lock_busy" });
  Object.defineProperty(forged, "metadata", { get() { metadataReads++; throw Error("private-canary"); } });
  t.mock.method(fs, "mkdirSync", () => { throw forged; });
  log.recordFatal({ operation: "desktop.failure" });
  assert.equal("failureFacts" in (await log.list()).storage, false);
  assert.equal(metadataReads, 0);
  t.mock.method(fs, "mkdirSync", mkdir);
  t.mock.method(fs, "mkdirSync", () => { throw Object.assign(Error("private-canary"), { code: "EACCES" }); });
  log.recordFatal({ operation: "desktop.failure" });
  const last = (await log.list()).storage;
  assert.equal(last.failureCode, "EACCES");
  assert.equal("failureFacts" in last, false);
  assert.doesNotMatch(await log.exportText(), /private-canary|failureFacts/);
});
