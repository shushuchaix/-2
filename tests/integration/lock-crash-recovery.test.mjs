import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SessionManager } from "../../src/auth.mjs";
import { withWorkspaceLock } from "../../src/infrastructure/storage/lock.mjs";
import { createTempDir, registerTestResource } from "../helpers/fixtures.mjs";

const authUrl = new URL("../../src/auth.mjs", import.meta.url).href;
const lockUrl = new URL("../../src/infrastructure/storage/lock.mjs", import.meta.url).href;
const guardUrl = new URL("../helpers/network-guard.mjs", import.meta.url).href;
const secret = "synthetic-crash-recovery-session-secret";
function runWorker(t, source, expectedCode = 0) {
  const child = spawn(process.execPath, ["--import", guardUrl, "--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RJR_DISABLE_LOCAL_CREDENTIALS: "1" },
  });
  let out = "", err = "", exited = false;
  child.stdout.on("data", data => { out += data; });
  child.stderr.on("data", data => { err += data; });
  registerTestResource(t, async () => { if (!exited) child.kill(); });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      exited = true;
      code === expectedCode ? resolve({ out, pid: child.pid }) : reject(Error("Synthetic lock worker failed: " + err));
    });
  });
  // The barrier caller awaits all results later; retain early failures without
  // letting a child-start failure become an unrelated unhandled rejection.
  result.catch(() => {});
  return result;
}

function crashSource(mode, dataDir, phase) {
  const filename = path.join(dataDir, mode === "auth" ? ".auth-sessions.json.lock" : ".workspace.lock");
  return `
    import fs from 'node:fs'; import fsp from 'node:fs/promises'; import path from 'node:path';
    import { SessionManager } from ${JSON.stringify(authUrl)};
    import { withWorkspaceLock } from ${JSON.stringify(lockUrl)};
    const main = ${JSON.stringify(filename)}, phase = ${JSON.stringify(phase)};
    const isClaim = value => String(value).startsWith(main + '.reclaimers' + path.sep) && String(value).endsWith('.claim');
    const afterOpen = value => {
      if (String(value) === main + '.reclaim' || (phase === 'claim' && isClaim(value)) || (phase === 'main' && String(value) === main)) process.exit(86);
    };
    const open = fs.openSync; fs.openSync = function(file, ...args) { const fd = open.call(this, file, ...args); afterOpen(file); return fd; };
    const asyncOpen = fsp.open; fsp.open = async function(file, ...args) { const handle = await asyncOpen.call(this, file, ...args); afterOpen(file); return handle; };
    const rename = fs.renameSync; fs.renameSync = function(from, to, ...args) { const result = rename.call(this, from, to, ...args); if (phase === 'ticket' && isClaim(to)) process.exit(86); return result; };
    const asyncRename = fsp.rename; fsp.rename = async function(from, to, ...args) { const result = await asyncRename.call(this, from, to, ...args); if (phase === 'ticket' && isClaim(to)) process.exit(86); return result; };
    const link = fs.linkSync; fs.linkSync = function(from, to, ...args) { const result = link.call(this, from, to, ...args); if (phase === 'main' && String(to) === main) process.exit(86); return result; };
    const asyncLink = fsp.link; fsp.link = async function(from, to, ...args) { const result = await asyncLink.call(this, from, to, ...args); if (phase === 'main' && String(to) === main) process.exit(86); return result; };
    if (${JSON.stringify(mode)} === 'auth') new SessionManager({ secret: ${JSON.stringify(secret)}, storageFile: main.slice(0, -5) }).issue();
    else await withWorkspaceLock(${JSON.stringify(dataDir)}, async () => {}, { timeoutMs: 2000, pollMs: 2 });
    throw Error('Synthetic crash point was not reached');
  `;
}

for (const phase of ["claim", "ticket", "main"]) {
  test("auth recovers after a process dies at " + phase + " publication without reviving a revoked token", async (t) => {
    const dataDir = await createTempDir(t), file = path.join(dataDir, ".auth-sessions.json");
    const manager = new SessionManager({ secret, storageFile: file }), token = manager.issue().token;
    if (phase !== "main") {
      const dead = await runWorker(t, "");
      fs.writeFileSync(file + ".lock", JSON.stringify({ pid: dead.pid, nonce: "a".repeat(32) }));
    }
    await runWorker(t, crashSource("auth", dataDir, phase), 86);
    manager.revoke(token);
    const fresh = manager.issue().token;
    assert.equal(manager.verify(token), null);
    assert.ok(new SessionManager({ secret, storageFile: file }).verify(fresh));
  });

  test("workspace recovers after a process dies at " + phase + " publication", async (t) => {
    const dataDir = await createTempDir(t), file = path.join(dataDir, ".workspace.lock");
    if (phase !== "main") {
      const dead = await runWorker(t, "");
      fs.writeFileSync(file, JSON.stringify({ pid: dead.pid, token: "dead" }));
    }
    await runWorker(t, crashSource("workspace", dataDir, phase), 86);
    let calls = 0;
    await withWorkspaceLock(dataDir, async () => { calls++; }, { timeoutMs: 300, pollMs: 2 });
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(file), false);
  });
}

test("simultaneous recovery contenders never overlap a live workspace writer", async (t) => {
  const dataDir = await createTempDir(t), main = path.join(dataDir, ".workspace.lock");
  const dead = await runWorker(t, "");
  fs.writeFileSync(main, JSON.stringify({ pid: dead.pid, token: "dead" }));
  const children = Array.from({ length: 6 }, (_, id) => runWorker(t, `
    import fs from 'node:fs'; import fsp from 'node:fs/promises'; import path from 'node:path';
    import { withWorkspaceLock } from ${JSON.stringify(lockUrl)};
    const dir = ${JSON.stringify(dataDir)}, main = path.join(dir, '.workspace.lock');
    const parentPid = process.ppid;
    const waitForRelease = async (name, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (!fs.existsSync(path.join(dir, name))) {
        if (Date.now() >= deadline) throw Error('Synthetic contender ' + name + ' timeout');
        try { process.kill(parentPid, 0); }
        catch (error) { if (error.code === 'ESRCH') throw Error('Synthetic contender parent closed'); }
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    };
    // Synchronize process startup before the product's five-second lock budget.
    // Keep a separate child setup limit and stop if the supervising test dies.
    fs.writeFileSync(path.join(dir, 'started-${id}'), 'ready');
    await waitForRelease('start-contenders', 30000);
    // Keep the separate claim barrier: every warmed-up process must participate
    // in stale-owner recovery before any contender can finish choosing a ticket.
    const open = fsp.open; let intercepted = false;
    fsp.open = async function(file, ...args) {
      const handle = await open.call(this, file, ...args);
      if (!intercepted && String(file).startsWith(main + '.reclaimers' + path.sep) && String(file).endsWith('.claim')) {
        intercepted = true; fs.writeFileSync(path.join(dir, 'ready-${id}'), 'ready');
        await waitForRelease('release-contenders', 5000);
      }
      return handle;
    };
    fs.writeFileSync(path.join(dir, 'lock-started-${id}'), 'started');
    await withWorkspaceLock(dir, async () => {
      const critical = path.join(dir, 'critical');
      fs.mkdirSync(critical);
      await new Promise(resolve => setTimeout(resolve, 10));
      fs.appendFileSync(path.join(dir, 'completed'), '${id}\\n');
      fs.rmdirSync(critical);
    }, { timeoutMs: 5000, pollMs: 2 });
  `));
  const deadline = Date.now() + 10000;
  while (Array.from({ length: 6 }, (_, id) => fs.existsSync(path.join(dataDir, "started-" + id))).includes(false)) {
    if (Date.now() >= deadline) throw Error("Synthetic contender startup timeout");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(JSON.parse(fs.readFileSync(main, "utf8")).pid, dead.pid);
  assert.equal(Array.from({ length: 6 }, (_, id) => fs.existsSync(path.join(dataDir, "lock-started-" + id))).some(Boolean), false);
  fs.writeFileSync(path.join(dataDir, "start-contenders"), "go");
  const claimDeadline = Date.now() + 5000;
  while (Array.from({ length: 6 }, (_, id) => fs.existsSync(path.join(dataDir, "ready-" + id))).includes(false)) {
    if (Date.now() >= claimDeadline) throw Error("Synthetic contender claim timeout");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(JSON.parse(fs.readFileSync(main, "utf8")).pid, dead.pid);
  fs.writeFileSync(path.join(dataDir, "release-contenders"), "go");
  await Promise.all(children);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, "completed"), "utf8").trim().split("\n").sort(), ["0", "1", "2", "3", "4", "5"]);
});

test("workspace wait yields to an async holder in the same process", async (t) => {
  const dataDir = await createTempDir(t), events = [];
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const first = withWorkspaceLock(dataDir, async () => {
    events.push("first-start"); started();
    await new Promise(resolve => setTimeout(resolve, 30));
    events.push("first-end");
  });
  await entered;
  const second = withWorkspaceLock(dataDir, async () => { events.push("second"); }, { timeoutMs: 1000, pollMs: 1 });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("live choosing, partial, and ticket participants are never deleted to force recovery", async (t) => {
  const dead = await runWorker(t, "");
  for (const mode of ["auth", "workspace"]) {
    const dataDir = await createTempDir(t);
    const registry = path.join(dataDir, ".auth-sessions.json"), main = mode === "auth" ? registry + ".lock" : path.join(dataDir, ".workspace.lock");
    const directory = main + ".reclaimers", claim = path.join(directory, process.pid + "-" + "a".repeat(32) + ".claim");
    fs.mkdirSync(directory);
    fs.writeFileSync(main, JSON.stringify({ pid: dead.pid, nonce: "dead" }));
    for (const state of ["", "{partial", JSON.stringify({ choosing: true, ticket: 0 }), JSON.stringify({ choosing: false, ticket: 1 })]) {
      fs.writeFileSync(claim, state);
      if (mode === "auth") assert.throws(() => new SessionManager({ secret, storageFile: registry }).issue(), { code: "auth_session_busy" });
      else await assert.rejects(withWorkspaceLock(dataDir, async () => assert.fail("live claimant must block"), { timeoutMs: 15, pollMs: 1 }), /busy/);
      assert.equal(fs.readFileSync(claim, "utf8"), state);
      assert.equal(JSON.parse(fs.readFileSync(main, "utf8")).pid, dead.pid);
    }
  }
});

test("unknown legacy lock ownership remains closed instead of being guessed expired", async (t) => {
  for (const mode of ["auth", "workspace"]) {
    const dataDir = await createTempDir(t), registry = path.join(dataDir, ".auth-sessions.json");
    const main = mode === "auth" ? registry + ".lock" : path.join(dataDir, ".workspace.lock");
    fs.writeFileSync(main, "");
    fs.writeFileSync(main + ".reclaim", "");
    if (mode === "auth") assert.throws(() => new SessionManager({ secret, storageFile: registry }).issue(), { code: "auth_session_busy" });
    else await assert.rejects(withWorkspaceLock(dataDir, async () => assert.fail("uncertain lock must block"), { timeoutMs: 15, pollMs: 1 }), /busy/);
    assert.equal(fs.readFileSync(main, "utf8"), "");
    assert.equal(fs.readFileSync(main + ".reclaim", "utf8"), "");
  }
});
