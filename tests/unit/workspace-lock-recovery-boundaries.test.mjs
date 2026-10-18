import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withWorkspaceLock, publishOwnedFileLock } from "../../src/infrastructure/storage/lock.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const guard = new URL("../helpers/network-guard.mjs", import.meta.url).href;
async function newlyDepartedPid() {
  const departed = spawn(process.execPath, ["--import", guard, "--eval", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  const code = await new Promise((resolve, reject) => { departed.once("error", reject); departed.once("close", resolve); });
  assert.equal(code, 0);
  assert.throws(() => process.kill(departed.pid, 0), { code: "ESRCH" });
  return departed.pid;
}

async function fixture(t, afterRecovery) {
  const dir = await createTempDir(t), main = path.join(dir, ".workspace.lock");
  const owner = Buffer.from(JSON.stringify({ pid: await newlyDepartedPid(), token: randomUUID() }));
  await fs.writeFile(main, owner);
  const counts = { links: 0, mainReads: 0, mainUnlinks: 0, injected: 0 };
  const adapter = {
    ...fs,
    open: async (...args) => {
      const handle = await fs.open(...args);
      if (String(args[0]).includes(".reclaimers") && String(args[0]).endsWith(".claim")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); counts.injected++; await delay(350); };
      }
      return handle;
    },
    readFile: (...args) => { if (args[0] === main) counts.mainReads++; return fs.readFile(...args); },
    link: (...args) => { if (args[1] === main) counts.links++; return fs.link(...args); },
    unlink: async (...args) => {
      await fs.unlink(...args);
      if (args[0] === main && ++counts.mainUnlinks === 1) await afterRecovery?.({ dir, main });
    },
  };
  return { dir, main, owner, counts, adapter };
}

test("a completed dead-owner recovery crossing 300ms gets one final no-replace publication", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await withWorkspaceLock(f.dir, () => { calls++; }, { timeoutMs: 300, pollMs: 2, fsAdapter: f.adapter });
  assert.equal(calls, 1);
  assert.equal(f.counts.injected, 1);
  assert.equal(f.counts.links, 2);
  await assert.rejects(fs.stat(f.main), { code: "ENOENT" });
});

test("a live writer winning the final recovered slot is preserved without another recovery", async (t) => {
  const liveOwner = { pid: process.pid, token: randomUUID() };
  const liveBytes = Buffer.from(JSON.stringify(liveOwner));
  const f = await fixture(t, ({ main }) => publishOwnedFileLock(main, liveOwner, fs));
  let calls = 0;
  await assert.rejects(withWorkspaceLock(f.dir, () => { calls++; }, { timeoutMs: 300, pollMs: 2, fsAdapter: f.adapter }), /Workspace busy/);
  assert.equal(calls, 0);
  assert.equal(f.counts.links, 2);
  assert.equal(f.counts.mainReads, 2);
  assert.equal(f.counts.mainUnlinks, 1);
  assert.deepEqual(await fs.readFile(f.main), liveBytes);
});

test("a legacy recovery guard appearing before the final publication remains closed", async (t) => {
  const bytes = Buffer.from("uncertain synthetic legacy owner");
  const f = await fixture(t, ({ main }) => fs.writeFile(main + ".reclaim", bytes));
  let calls = 0;
  await assert.rejects(withWorkspaceLock(f.dir, () => { calls++; }, { timeoutMs: 300, pollMs: 2, fsAdapter: f.adapter }), /Workspace busy/);
  assert.equal(calls, 0);
  assert.equal(f.counts.links, 1);
  assert.equal(f.counts.mainReads, 2);
  assert.equal(f.counts.mainUnlinks, 1);
  assert.deepEqual(await fs.readFile(f.main + ".reclaim"), bytes);
  await assert.rejects(fs.stat(f.main), { code: "ENOENT" });
});

for (const kind of ["live", "EPERM", "invalid", "empty"]) {
  test(`an unsuccessful ${kind} owner probe crossing the wait limit gets no final publication`, async (t) => {
    const dir = await createTempDir(t), main = path.join(dir, ".workspace.lock");
    // The EPERM adapter throws before parsing or probing this fixed synthetic
    // PID; the other protected cases never need a historical dead process.
    const bytes = Buffer.from(kind === "invalid" ? "{" : kind === "empty" ? "" : JSON.stringify({ pid: kind === "EPERM" ? 2147483646 : process.pid, token: randomUUID() }));
    await fs.writeFile(main, bytes);
    let links = 0, reads = 0, calls = 0;
    const adapter = {
      ...fs,
      link: (...args) => { links++; return fs.link(...args); },
      readFile: async (...args) => {
        if (args[0] === main) { reads++; await delay(350); if (kind === "EPERM") throw Object.assign(Error("synthetic unreadable owner"), { code: "EPERM" }); }
        return fs.readFile(...args);
      },
    };
    await assert.rejects(withWorkspaceLock(dir, () => { calls++; }, { timeoutMs: 300, pollMs: 2, fsAdapter: adapter }), /Workspace busy/);
    assert.equal(calls, 0);
    assert.equal(links, 1);
    assert.equal(reads, 1);
    assert.deepEqual(await fs.readFile(main), bytes);
  });
}

test("a real native publication finishing late retains the turn and prevents a second writer", async (t) => {
  const dir = await createTempDir(t), main = path.join(dir, ".workspace.lock");
  let release, entered, calls = 0, secondCalls = 0, finished = false;
  const held = new Promise((resolve) => { release = resolve; });
  const published = new Promise((resolve) => { entered = resolve; });
  const adapter = { ...fs, link: async (...args) => { await fs.link(...args); entered(); await held; } };
  const first = withWorkspaceLock(dir, () => { calls++; }, { timeoutMs: 300, pollMs: 2, fsAdapter: adapter }).finally(() => { finished = true; });
  try {
    await published;
    const owner = await fs.readFile(main);
    await assert.rejects(withWorkspaceLock(dir, () => { secondCalls++; }, { timeoutMs: 30, pollMs: 2 }), /Workspace busy/);
    await delay(350);
    assert.equal(finished, false);
    assert.equal(calls, 0);
    assert.equal(secondCalls, 0);
    assert.deepEqual(await fs.readFile(main), owner);
  } finally { release(); }
  await first;
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(main), { code: "ENOENT" });
});

test("AP-LOCK-1: an absent main with an uncertain legacy guard retains bounded poll spacing", async (t) => {
  const dir = await createTempDir(t), main = path.join(dir, ".workspace.lock"), guard = main + ".reclaim";
  const bytes = Buffer.from("uncertain legacy guard");
  await fs.writeFile(guard, bytes);
  const originalNow = Date.now, originalTimer = globalThis.setTimeout;
  let clock = 0, waits = 0, guardProbes = 0, ownerReads = 0, links = 0, calls = 0;
  const adapter = {
    ...fs,
    stat: (...args) => { if (args[0] === guard) { guardProbes++; clock++; } return fs.stat(...args); },
    readFile: (...args) => { if (args[0] === main) { ownerReads++; clock++; } return fs.readFile(...args); },
    link: (...args) => { links++; return fs.link(...args); },
  };
  // A deterministic logical clock counts probes; polling still uses the real
  // configured 20ms timer. These counts are not a CPU or wall-time benchmark.
  Date.now = () => clock;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 20) { waits++; clock += 20; }
    return originalTimer(fn, ms, ...args);
  };
  try {
    await assert.rejects(withWorkspaceLock(dir, () => { calls++; }, { timeoutMs: 80, pollMs: 20, fsAdapter: adapter }), /Workspace busy/);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalTimer;
  }
  t.diagnostic(JSON.stringify({ logicalClock: clock, waits, guardProbes, ownerReads, links, calls, guardPreserved: true }));
  assert.ok(waits >= 1, "repeated unsuccessful recovered-slot publication retains the configured poll");
  assert.ok(guardProbes <= 2 * (waits + 1), "at most one immediate recovered-slot publication per polling cycle");
  assert.equal(links, 0);
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readFile(guard), bytes);
  await assert.rejects(fs.stat(main), { code: "ENOENT" });
});
