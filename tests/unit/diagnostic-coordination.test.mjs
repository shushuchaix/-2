import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDiagnosticFatalTurn } from "../../src/infrastructure/diagnostics/coordination.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
const fixture = async (t) => {
  const dir = await createTempDir(t);
  return { dir, lock: path.join(dir, ".application-fatal.lock") };
};
test("prepared owner is complete and durable before atomic no-replace link", async (t) => {
  const { dir, lock } = await fixture(t),
    link = fs.linkSync,
    sync = fs.fsyncSync;
  let fsync = 0,
    links = 0,
    linkedOwner;
  fs.fsyncSync = (...args) => {
    const result = sync(...args);
    fsync++;
    return result;
  };
  fs.linkSync = (from, to) => {
    assert.equal(to, lock);
    linkedOwner = JSON.parse(fs.readFileSync(from, "utf8"));
    assert.equal(linkedOwner.pid, process.pid);
    assert.match(linkedOwner.token, /^[\da-f-]{36}$/);
    assert.equal(fsync, 1);
    links++;
    return link(from, to);
  };
  try {
    assert.equal(
      withDiagnosticFatalTurn(lock, () => {
        assert.deepEqual(
          JSON.parse(fs.readFileSync(lock, "utf8")),
          linkedOwner,
        );
        assert.equal(
          fs.readdirSync(dir).filter((p) => p.endsWith(".tmp")).length,
          0,
        );
        return 42;
      }),
      42,
    );
  } finally {
    fs.linkSync = link;
    fs.fsyncSync = sync;
  }
  assert.equal(links, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test("live owner contention reuses one complete fsynced temp and never steals", async (t) => {
  const { dir, lock } = await fixture(t),
    text = JSON.stringify({ pid: process.pid, token: randomUUID() });
  fs.writeFileSync(lock, text);
  const link = fs.linkSync,
    sync = fs.fsyncSync,
    files = [];
  let fsync = 0,
    acted = false;
  fs.fsyncSync = (...args) => {
    fsync++;
    return sync(...args);
  };
  fs.linkSync = (from, to) => {
    files.push(from);
    assert.equal(JSON.parse(fs.readFileSync(from, "utf8")).pid, process.pid);
    return link(from, to);
  };
  const start = Date.now();
  try {
    assert.throws(
      () =>
        withDiagnosticFatalTurn(lock, () => {
          acted = true;
        }),
      { code: "diagnostic_lock_busy" },
    );
  } finally {
    fs.linkSync = link;
    fs.fsyncSync = sync;
  }
  assert.equal(acted, false);
  assert.equal(fsync, 1);
  assert.ok(files.length > 1);
  assert.equal(new Set(files).size, 1);
  assert.equal(fs.readFileSync(lock, "utf8"), text);
  assert.ok(Date.now() - start < 1500);
  assert.deepEqual(fs.readdirSync(dir), [".application-fatal.lock"]);
});
test("legacy recovery guard blocks publication and remains untouched", async (t) => {
  const { dir, lock } = await fixture(t),
    guard = lock + ".reclaim";
  fs.writeFileSync(guard, "uncertain legacy owner");
  const sync = fs.fsyncSync;
  let fsync = 0;
  fs.fsyncSync = (...args) => {
    fsync++;
    return sync(...args);
  };
  try {
    assert.throws(
      () =>
        withDiagnosticFatalTurn(lock, () => assert.fail("legacy guard stolen")),
      { code: "diagnostic_lock_busy" },
    );
  } finally {
    fs.fsyncSync = sync;
  }
  assert.equal(fsync, 0);
  assert.equal(fs.readFileSync(guard, "utf8"), "uncertain legacy owner");
  assert.deepEqual(fs.readdirSync(dir), [".application-fatal.lock.reclaim"]);
});
test("action failure remains original and releases only owned lock", async (t) => {
  const { dir, lock } = await fixture(t),
    error = Error("synthetic action");
  assert.throws(
    () =>
      withDiagnosticFatalTurn(lock, () => {
        throw error;
      }),
    (e) => e === error,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});
test("failed temp fsync cannot publish or run action and removes own temp", async (t) => {
  const { dir, lock } = await fixture(t),
    sync = fs.fsyncSync,
    error = Object.assign(Error("synthetic fsync"), { code: "EIO" });
  fs.fsyncSync = () => {
    throw error;
  };
  try {
    assert.throws(
      () =>
        withDiagnosticFatalTurn(lock, () =>
          assert.fail("incomplete owner published"),
        ),
      (e) => e === error,
    );
  } finally {
    fs.fsyncSync = sync;
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});
test("non-contention link error remains original and removes own temp", async (t) => {
  const { dir, lock } = await fixture(t),
    link = fs.linkSync,
    error = Object.assign(Error("synthetic permission"), { code: "EPERM" });
  fs.linkSync = () => {
    throw error;
  };
  try {
    assert.throws(
      () =>
        withDiagnosticFatalTurn(lock, () =>
          assert.fail("failed link published"),
        ),
      (e) => e === error,
    );
  } finally {
    fs.linkSync = link;
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});
test("changed ownership is reported and replacement owner survives", async (t) => {
  const { lock } = await fixture(t),
    text = JSON.stringify({ pid: process.pid, token: randomUUID() });
  assert.throws(
    () => withDiagnosticFatalTurn(lock, () => fs.writeFileSync(lock, text)),
    { code: "diagnostic_lock_lost" },
  );
  assert.equal(fs.readFileSync(lock, "utf8"), text);
});

test("an unknown owner remains intact after the fatal acquisition deadline", async (t) => {
  const { dir, lock } = await fixture(t);
  fs.writeFileSync(lock, "unknown owner");
  assert.throws(
    () =>
      withDiagnosticFatalTurn(lock, () => assert.fail("unknown owner stolen")),
    { code: "diagnostic_lock_busy" },
  );
  assert.equal(fs.readFileSync(lock, "utf8"), "unknown owner");
  assert.deepEqual(fs.readdirSync(dir), [".application-fatal.lock"]);
});
test("dead publication cleanup failure releases the turn and preserves protected artifacts", async (t) => {
  const { dir, lock } = await fixture(t),
    deadPid = 2147483645,
    uncertainPid = 2147483646;
  const dead = lock + "." + deadPid + "." + "a".repeat(32) + ".tmp";
  const protectedFiles = [
    lock + "." + process.pid + "." + "b".repeat(32) + ".tmp",
    lock + "." + uncertainPid + "." + "c".repeat(32) + ".tmp",
    lock + ".unknown.tmp",
  ];
  for (const file of [dead, ...protectedFiles])
    fs.writeFileSync(file, "synthetic publication");
  const kill = process.kill,
    unlink = fs.unlinkSync,
    failure = Object.assign(
      Error("synthetic dead publication cleanup failure"),
      { code: "EPERM" },
    );
  process.kill = (pid, signal) => {
    if (pid === deadPid)
      throw Object.assign(Error("confirmed dead"), { code: "ESRCH" });
    if (pid === uncertainPid)
      throw Object.assign(Error("uncertain"), { code: "EPERM" });
    return kill(pid, signal);
  };
  fs.unlinkSync = (file) => {
    if (file === dead) throw failure;
    return unlink(file);
  };
  try {
    assert.throws(
      () =>
        withDiagnosticFatalTurn(lock, () =>
          assert.fail("cleanup failed before action"),
        ),
      (e) => e === failure,
    );
    assert.equal(fs.existsSync(lock), false);
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      [dead, ...protectedFiles].map((file) => path.basename(file)).sort(),
    );
    fs.unlinkSync = unlink;
    assert.equal(
      withDiagnosticFatalTurn(lock, () => 42),
      42,
    );
    assert.equal(fs.existsSync(dead), false);
    for (const file of protectedFiles)
      assert.equal(fs.readFileSync(file, "utf8"), "synthetic publication");
  } finally {
    process.kill = kill;
    fs.unlinkSync = unlink;
  }
});
