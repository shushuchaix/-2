import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempRepository } from "../helpers/repository.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { withWorkspaceLock } from "../../src/infrastructure/storage/lock.mjs";
const writer = (dir, message) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "tests/helpers/writer-process.mjs",
      dir,
      message,
    ]);
    let err = "";
    child.stderr.on("data", (x) => (err += x));
    child.on("error", reject);
    child.on("exit", (c) => (c === 0 ? resolve() : reject(Error(err))));
  });
test('Windows transient lock open and release failures retry without executing twice', async t => {
  const repo = await tempRepository(t);
  let opens=0, removals=0, calls=0;
  await withWorkspaceLock(repo.dataDir,()=>{calls++;},{platform:'win32',pollMs:1,fsAdapter:{...fs,
    async open(...args){if(++opens===1)throw Object.assign(Error('busy'),{code:'EPERM'});return fs.open(...args);},
    async unlink(...args){if(++removals===1)throw Object.assign(Error('busy'),{code:'EACCES'});return fs.unlink(...args);},
  }});
  assert.equal(opens,2);assert.equal(removals,2);assert.equal(calls,1);
  await assert.rejects(fs.stat(path.join(repo.dataDir,'.workspace.lock')),{code:'ENOENT'});
});
test('persistent Windows lock permission failure and other platform errors remain bounded', async t => {
  const repo=await tempRepository(t);
  for(const platform of ['win32','linux']){
    let attempts=0;
    await assert.rejects(withWorkspaceLock(repo.dataDir,()=>assert.fail('cannot acquire'),{
      platform,timeoutMs:0,fsAdapter:{...fs,async open(){attempts++;throw Object.assign(Error('permission'),{code:'EPERM'});}},
    }),{code:'EPERM'});
    assert.equal(attempts,1);
  }
});
test("two processes and concurrent transactions preserve every write", async (t) => {
  const repo = await tempRepository(t);
  await Promise.all([writer(repo.dataDir, "a"), writer(repo.dataDir, "b")]);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      repo.mutateWorkspace((w) =>
        w.recoveryRecords.push({ message: String(i) }),
      ),
    ),
  );
  const w = await repo.read();
  assert.equal(w.revision, 22);
  assert.equal(w.recoveryRecords.length, 22);
  w.recoveryRecords = [];
  assert.equal((await repo.read()).recoveryRecords.length, 22);
});
test("active old locks are not removed and dead locks are reclaimed", async (t) => {
  const repo = await tempRepository(t);
  const p = path.join(repo.dataDir, ".workspace.lock");
  await fs.writeFile(
    p,
    JSON.stringify({
      pid: process.pid,
      token: "active",
      createdAt: "2000-01-01",
    }),
  );
  await assert.rejects(
    withWorkspaceLock(repo.dataDir, () => {}, { timeoutMs: 30 }),
    /busy/i,
  );
  assert.equal(JSON.parse(await fs.readFile(p, "utf8")).token, "active");
  await fs.writeFile(p, JSON.stringify({ pid: 2147483647, token: "dead" }));
  await Promise.all([writer(repo.dataDir, "c"), writer(repo.dataDir, "d")]);
  assert.equal((await repo.read()).revision, 2);
  await assert.rejects(fs.stat(p), { code: "ENOENT" });
});
test("write failures and corrupt or future schema never replace valid data", async (t) => {
  const repo = await tempRepository(t);
  await repo.mutateWorkspace((w) =>
    w.recoveryRecords.push({ message: "safe" }),
  );
  const failing = await openWorkspaceRepository({
    dataDir: repo.dataDir,
    fsAdapter: {
      ...fs,
      rename: async () => {
        throw Error("persist rename failure");
      },
    },
  });
  await assert.rejects(
    failing.mutateWorkspace((w) => (w.recoveryRecords = [])),
    /persist rename/,
  );
  assert.equal((await repo.read()).revision, 1);
  await fs.writeFile(path.join(repo.dataDir, "workspace.v2.json"), "{bad");
  await assert.rejects(repo.read(), /corrupt/i);
  await fs.writeFile(
    path.join(repo.dataDir, "workspace.v2.json"),
    JSON.stringify({ schemaVersion: 99 }),
  );
  await assert.rejects(repo.read(), /schema/i);
});
test("run snapshots are immutable and reject path traversal", async (t) => {
  const repo = await tempRepository(t);
  const ref = await repo.writeRunSnapshot("r1", { runId: "r1" });
  assert.equal((await repo.readRunSnapshot("r1")).runId, "r1");
  assert.equal(ref.hash.length, 64);
  await assert.rejects(
    repo.writeRunSnapshot("r1", { changed: true }),
    /immutable/i,
  );
  await assert.rejects(repo.writeRunSnapshot("../x", {}), /run id/i);
});
