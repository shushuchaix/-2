import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDiagnosticLogTurn } from "../../src/infrastructure/diagnostics/coordination.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";

test("an already cancelled diagnostic acquisition performs no publication or action", async (t) => {
  const dir = await createTempDir(t), controller = new AbortController();
  controller.abort();
  let io = 0, called = false;
  const adapter = new Proxy(fs, { get(target, key) { const value = target[key]; return typeof value === "function" ? (...args) => { io++; return value(...args); } : value; } });
  await assert.rejects(
    withDiagnosticLogTurn(path.join(dir, ".application.lock"), adapter, () => { called = true; }, { signal: controller.signal }),
    { code: "diagnostic_lock_timeout" },
  );
  assert.equal(io, 0);
  assert.equal(called, false);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("an occupied diagnostic turn waits without repeatedly opening or fsyncing publication files", async (t) => {
  const dir = await createTempDir(t), lock = path.join(dir, ".application.lock");
  const text = JSON.stringify({ pid: process.pid, token: randomUUID() });
  await fs.writeFile(lock, text);
  const controller = new AbortController();
  let opens = 0, probes = 0, acted = false;
  const adapter = {
    ...fs,
    open: (...args) => { opens++; return fs.open(...args); },
    readFile: async (...args) => {
      const result = await fs.readFile(...args);
      if (args[0] === lock && ++probes === 2) controller.abort();
      return result;
    },
  };
  await assert.rejects(
    withDiagnosticLogTurn(lock, adapter, () => { acted = true; }, { signal: controller.signal }),
    { code: "diagnostic_lock_timeout" },
  );
  assert.equal(opens, 0);
  assert.ok(probes >= 2);
  assert.equal(acted, false);
  assert.equal(await fs.readFile(lock, "utf8"), text);
  assert.deepEqual(await fs.readdir(dir), [".application.lock"]);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function waitForPhysicalReleases(completion, { phase, getReleaseCount, releaseHold }) {
  let watchdog;
  try {
    await Promise.race([
      completion,
      new Promise((_, reject) => {
        // Fixture termination only: this is not an extension of the product's
        // 500ms observation/ownership budget. Missing completion is a failure.
        watchdog = setTimeout(() => reject(Object.assign(
          Error("Physical diagnostic owner release missing"),
          { code: "physical_release_missing", phase, releaseCount: getReleaseCount() },
        )), 5000);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
    releaseHold();
  }
}

for (const phase of ["open", "fsync", "link"]) {
  test(`cancellation during pending native ${phase} preserves ownership until that operation settles`, async (t) => {
    const dir = await createTempDir(t), lock = path.join(dir, ".application.lock");
    const controller = new AbortController(), entered = deferred(), release = deferred();
    let settled = false, acted = false;
    const hold = async () => { entered.resolve(); await release.promise; };
    const adapter = {
      ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (phase === "open") await hold();
        if (phase === "fsync") {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { await sync(); await hold(); };
        }
        return handle;
      },
      link: async (...args) => { await fs.link(...args); if (phase === "link") await hold(); },
    };
    const operation = withDiagnosticLogTurn(lock, adapter, () => { acted = true; }, { signal: controller.signal });
    const completion = assert.rejects(operation, { code: "diagnostic_lock_timeout" }).finally(() => { settled = true; });
    try {
      await entered.promise;
      const before = await fs.readdir(dir);
      assert.ok(before.some((name) => name.endsWith(".tmp")));
      if (phase === "link") assert.equal(JSON.parse(await fs.readFile(lock, "utf8")).pid, process.pid);
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(acted, false);
      assert.deepEqual(await fs.readdir(dir), before);
    } finally { release.resolve(); }
    await completion;
    assert.equal(acted, false);
    assert.deepEqual(await fs.readdir(dir), []);
  });
}

test("cancelling a held diagnostic action never releases its lock or abandons its late result", async (t) => {
  const dir = await createTempDir(t), lock = path.join(dir, ".application.lock");
  const controller = new AbortController(), entered = deferred(), release = deferred();
  let settled = false;
  const operation = withDiagnosticLogTurn(lock, fs, async () => { entered.resolve(); await release.promise; return "committed"; }, { signal: controller.signal });
  const completion = operation.finally(() => { settled = true; });
  try {
    await entered.promise;
    const owner = await fs.readFile(lock, "utf8");
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(await fs.readFile(lock, "utf8"), owner);
  } finally { release.resolve(); }
  assert.equal(await completion, "committed");
  assert.deepEqual(await fs.readdir(dir), []);
});

test("normal no-replace races reuse one complete fsynced owner and check every publication guard", async (t) => {
  const dir = await createTempDir(t), lock = path.join(dir, ".application.lock");
  let links = 0, syncs = 0, guards = 0;
  const publications = [];
  const adapter = {
    ...fs,
    stat: (...args) => { if (args[0] === lock + ".reclaim") guards++; return fs.stat(...args); },
    open: async (...args) => {
      const handle = await fs.open(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => { syncs++; return sync(); };
      return handle;
    },
    link: async (from, to) => {
      publications.push(from);
      const owner = JSON.parse(await fs.readFile(from, "utf8"));
      assert.equal(owner.pid, process.pid);
      assert.match(owner.token, /^[a-f0-9-]{36}$/);
      assert.equal(syncs, 1);
      if (++links < 3) throw Object.assign(Error("synthetic no-replace race"), { code: "EEXIST" });
      return fs.link(from, to);
    },
  };
  assert.equal(await withDiagnosticLogTurn(lock, adapter, () => "committed"), "committed");
  assert.equal(links, 3);
  assert.equal(syncs, 1);
  assert.equal(guards, 3);
  assert.equal(new Set(publications).size, 1);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("a legacy guard appearing after a lost normal publication blocks the next link", async (t) => {
  const dir = await createTempDir(t), lock = path.join(dir, ".application.lock"), guard = lock + ".reclaim";
  const controller = new AbortController();
  let links = 0, guardObserved = false;
  const adapter = {
    ...fs,
    stat: async (...args) => {
      const result = await fs.stat(...args);
      if (args[0] === guard) { guardObserved = true; controller.abort(); }
      return result;
    },
    link: async () => {
      links++;
      await fs.writeFile(guard, "uncertain legacy owner");
      throw Object.assign(Error("synthetic no-replace race"), { code: "EEXIST" });
    },
  };
  await assert.rejects(withDiagnosticLogTurn(lock, adapter, () => assert.fail("legacy guard ignored"), { signal: controller.signal }), { code: "diagnostic_lock_timeout" });
  assert.equal(links, 1);
  assert.equal(guardObserved, true);
  assert.equal(await fs.readFile(guard, "utf8"), "uncertain legacy owner");
  assert.deepEqual(await fs.readdir(dir), [".application.lock.reclaim"]);
});

for (const phase of ["open", "fsync", "link"]) {
  test(`an observer deadline during native ${phase} preserves that record and its queued successor exactly once`, async (t) => {
    const dataDir = await createTempDir(t), entered = deferred(), release = deferred();
    const physicallyReleased = deferred(), releaseEvents = [];
    let ownerReleases = 0;
    let held = false;
    const holdOnce = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
    const adapter = {
      ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (phase === "open") await holdOnce();
        if (phase === "fsync") {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { await sync(); await holdOnce(); };
        }
        return handle;
      },
      link: async (...args) => { await fs.link(...args); if (phase === "link") await holdOnce(); },
      unlink: async (...args) => {
        await fs.unlink(...args);
        if (path.basename(args[0]) === ".application.lock") {
          releaseEvents.push({ index: ++ownerReleases, at: performance.now() });
          if (ownerReleases === 2) physicallyReleased.resolve();
        }
      },
    };
    const log = createDiagnosticsLog({ dataDir, fsAdapter: adapter, maxMemoryEntries: 0 });
    const first = log.record({ operation: "desktop.start" });
    let entries;
    try {
      await entered.promise;
      entries = await Promise.all([first, log.record({ operation: "desktop.ready" })]);
      const names = await fs.readdir(path.join(dataDir, "logs"));
      assert.ok(names.some((name) => name.endsWith(".tmp")));
      if (phase === "link") assert.ok(names.includes(".application.lock"));
    } finally { release.resolve(); }
    // list() observes a queue for at most 500ms; releasing the synthetic hold
    // does not mean its successor has finished native IO. Await the two actual
    // owner releases, then let their promise finalizers finish in this turn.
    await waitForPhysicalReleases(physicallyReleased.promise, {
      phase,
      getReleaseCount: () => ownerReleases,
      releaseHold: () => release.resolve(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ownerReleases, 2);
    const status = await log.list();
    assert.equal(status.storage.pendingWrites, 0);
    assert.equal(status.storage.failedWrites, 0);
    assert.equal(status.storage.mode, "file");
    const reopened = createDiagnosticsLog({ dataDir });
    const ids = (await reopened.exportText()).split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line).diagnosticId);
    assert.deepEqual(ids.sort(), entries.map((entry) => entry.diagnosticId).sort());
    assert.equal(new Set(ids).size, 2);
    t.diagnostic(JSON.stringify({ phase, releaseEvents, pendingWrites: status.storage.pendingWrites, failedWrites: status.storage.failedWrites, persistedIds: ids.length }));
  });
}
