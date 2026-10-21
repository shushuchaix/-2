import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { createTempDir, registerTestResource } from "../helpers/fixtures.mjs";

const moduleUrl = new URL(
  "../../src/infrastructure/diagnostics/log.mjs",
  import.meta.url,
).href;
const guardUrl = new URL("../helpers/network-guard.mjs", import.meta.url).href;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logNames = [
  "application.log",
  "application.previous.log",
  "application.fatal.log",
  "application.fatal.previous.log",
];
const worker = `
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import {createDiagnosticsLog} from ${JSON.stringify(moduleUrl)};
import {withDiagnosticFatalTurn} from ${JSON.stringify(new URL("../../src/infrastructure/diagnostics/coordination.mjs", import.meta.url).href)};
import path from 'node:path';
const options=JSON.parse(process.argv[1]);
if(options.crashPublication) {
  if(options.crashPublication==='normal') {
    const link=fs.link;
    fs.link=async (...args)=>{await link(...args); process.exit(86);};
  } else {
    const link=fsSync.linkSync;
    fsSync.linkSync=(...args)=>{link(...args); process.exit(86);};
  }
}
let release;
const adapter=options.hold ? {...fs,appendFile:async (...args)=>{
  process.send({held:true});
  await new Promise(resolve=>release=resolve);
  return fs.appendFile(...args);
}} : fs;
const log=createDiagnosticsLog({...options,fsAdapter:adapter,maxMemoryEntries:0});
process.on('message', async message=>{
  if(message.release) { release?.(); return; }
  if(!message.go) return;
  if(options.exitAfterRecord) {
    await Promise.all(Array.from({length:options.iterations},()=>log.record({operation:'run.stage'})));
    const result=await log.list();
    process.send({done:true,storage:result.storage});
    process.disconnect();
    return;
  }
  if(options.holdFatal) {
    await fs.mkdir(path.join(options.dataDir,'logs'),{recursive:true});
    withDiagnosticFatalTurn(path.join(options.dataDir,'logs','.application-fatal.lock'),()=>{
      process.send({held:true});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
    });
    return;
  }
  if(options.crash) {
    process.on('uncaughtExceptionMonitor',error=>log.recordFatal({operation:'desktop.failure',runId:options.runId,code:'main_uncaught'},error));
    setImmediate(()=>{throw Error('private synthetic fatal')});
    return;
  }
  const ids=[];
  for(let i=0;i<options.iterations;i++) {
    if(options.fatalOnly)
      ids.push(log.recordFatal({operation:'desktop.failure',runId:options.runId},Error('private synthetic fatal')).diagnosticId);
    else ids.push((await log.record({operation:'run.stage',runId:options.runId,stage:'collecting'})).diagnosticId);
    if(!options.fatalOnly && options.fatal && i%13===0)
      ids.push(log.recordFatal({operation:'desktop.failure',runId:options.runId},Error('private synthetic fatal')).diagnosticId);
  }
  const result=await log.list();
  process.send({done:true,ids,storage:result.storage});
  process.disconnect();
});
process.send({ready:true});
`;

function child(t, options) {
  const processHandle = spawn(
    process.execPath,
    [
      "--import",
      guardUrl,
      "--input-type=module",
      "-e",
      worker,
      JSON.stringify(options),
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, RJR_DISABLE_LOCAL_CREDENTIALS: "1" },
    },
  );
  const messages = [];
  let stderr = "";
  processHandle.stderr.on("data", (data) => {
    stderr += data;
  });
  processHandle.on("message", (message) => messages.push(message));
  const exit = new Promise((resolve, reject) => {
    processHandle.once("error", reject);
    processHandle.once("exit", (code, signal) => resolve({ code, signal }));
  });
  registerTestResource(t, async () => {
    if (processHandle.exitCode === null && processHandle.signalCode === null)
      processHandle.kill("SIGKILL");
    await exit;
  });
  return {
    processHandle,
    exit,
    async waitFor(key, timeoutMs = 15000) {
      const start = Date.now();
      while (!messages.some((message) => message[key])) {
        assert.ok(
          Date.now() - start < timeoutMs,
          `worker did not report ${key}: ${stderr}`,
        );
        assert.equal(processHandle.exitCode, null, stderr);
        await delay(5);
      }
      return messages.find((message) => message[key]);
    },
    go() {
      processHandle.send({ go: true });
    },
  };
}

async function diskEntries(dataDir, maxFileBytes = Infinity) {
  const entries = [];
  for (const name of logNames) {
    let text;
    try {
      text = await fs.readFile(path.join(dataDir, "logs", name), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assert.ok(
      Buffer.byteLength(text) <= maxFileBytes,
      `${name} exceeded retention`,
    );
    assert.ok(!text || text.endsWith("\n"), `${name} has an incomplete line`);
    for (const line of text.split("\n").filter(Boolean))
      entries.push(JSON.parse(line));
  }
  return entries;
}

async function receipt(name, dataDir, facts) {
  if (!process.env.RJR_DIAGNOSTIC_RECEIPTS) return;
  const cacheRoot = path.resolve(
    fileURLToPath(new URL("../../.cache/", import.meta.url)),
  );
  const destination = path.resolve(process.env.RJR_DIAGNOSTIC_RECEIPTS, name);
  assert.ok(
    destination.startsWith(cacheRoot + path.sep),
    "diagnostic evidence must remain in the workspace cache",
  );
  await fs.mkdir(destination, { recursive: true });
  for (const filename of logNames) {
    try {
      await fs.copyFile(
        path.join(dataDir, "logs", filename),
        path.join(destination, filename),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await fs.writeFile(
    path.join(destination, "receipt.json"),
    JSON.stringify(facts, null, 2) + "\n",
  );
}

test(
  "three independent CLI loggers serialize small-file rotation and simultaneous fatal writes",
  { timeout: 30000 },
  async (t) => {
    const dataDir = await createTempDir(t),
      maxFileBytes = 4096;
    const children = Array.from({ length: 3 }, (_, index) =>
      child(t, {
        dataDir,
        maxFileBytes,
        iterations: 160,
        fatal: true,
        runId: `r-cli-${index}`,
      }),
    );
    await Promise.all(children.map((item) => item.waitFor("ready")));
    let sampling = true,
      maxObservedBytes = 0;
    const sample = (async () => {
      while (sampling) {
        for (const name of logNames) {
          try {
            maxObservedBytes = Math.max(
              maxObservedBytes,
              (await fs.stat(path.join(dataDir, "logs", name))).size,
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        await delay(2);
      }
    })();
    let done;
    try {
      children.forEach((item) => item.go());
      done = await Promise.all(children.map((item) => item.waitFor("done")));
    } finally {
      sampling = false;
      await sample;
    }
    assert.ok(
      maxObservedBytes <= maxFileBytes,
      `observed ${maxObservedBytes} > ${maxFileBytes}`,
    );
    for (const result of done)
      assert.deepEqual(result.storage, {
        mode: "file",
        pendingWrites: 0,
        droppedWrites: 0,
        failedWrites: 0,
      });
    for (const item of children) assert.equal((await item.exit).code, 0);
    const entries = await diskEntries(dataDir, maxFileBytes);
    assert.equal(
      new Set(entries.map((entry) => entry.diagnosticId)).size,
      entries.length,
    );
    assert.doesNotMatch(JSON.stringify(entries), /private/);
    const reopened = await createDiagnosticsLog({
      dataDir,
      maxFileBytes,
    }).list();
    assert.equal(reopened.summary.damagedLines, 0);
    assert.equal(reopened.retention.fileCount, 4);
    assert.equal(reopened.retention.normalFileCount, 2);
    assert.equal(reopened.retention.fatalFileCount, 2);
    const files = await fs.readdir(path.join(dataDir, "logs"));
    assert.deepEqual(files.sort(), [...logNames].sort());
    const facts = {
      case: "three-process-rotation-and-fatal",
      maxFileBytes,
      maxObservedBytes,
      acknowledgedIds: done.flatMap((item) => item.ids),
      storage: done.map((item) => item.storage),
      retainedIds: entries.map((item) => item.diagnosticId),
      damagedLines: reopened.summary.damagedLines,
    };
    t.diagnostic(
      JSON.stringify({
        case: facts.case,
        maxFileBytes,
        maxObservedBytes,
        acknowledged: facts.acknowledgedIds.length,
        retained: entries.length,
        failedWrites: done.map((item) => item.storage.failedWrites),
      }),
    );
    await receipt("rotation", dataDir, facts);
  },
);

test(
  "every acknowledged normal and fatal id survives restart exactly once without rotation",
  { timeout: 30000 },
  async (t) => {
    const dataDir = await createTempDir(t),
      maxFileBytes = 1024 * 1024;
    const children = Array.from({ length: 3 }, (_, index) =>
      child(t, {
        dataDir,
        maxFileBytes,
        iterations: 75,
        fatal: true,
        runId: `r-cli-${index}`,
      }),
    );
    await Promise.all(children.map((item) => item.waitFor("ready")));
    children.forEach((item) => item.go());
    const results = await Promise.all(
      children.map((item) => item.waitFor("done")),
    );
    await Promise.all(children.map((item) => item.exit));
    for (const result of results) assert.equal(result.storage.failedWrites, 0);
    const ids = results.flatMap((result) => result.ids).sort();
    const entries = await diskEntries(dataDir, maxFileBytes);
    assert.deepEqual(entries.map((entry) => entry.diagnosticId).sort(), ids);
    const exported = await createDiagnosticsLog({
      dataDir,
      maxFileBytes,
    }).exportText();
    const reopenedIds = exported
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line).diagnosticId)
      .sort();
    assert.deepEqual(reopenedIds, ids);
    t.diagnostic(
      JSON.stringify({
        case: "no-rotation-exactly-once",
        acknowledged: ids.length,
        diskEntries: entries.length,
        uniqueIds: new Set(reopenedIds).size,
      }),
    );
    await receipt("no-rotation", dataDir, {
      case: "no-rotation-exactly-once",
      maxFileBytes,
      acknowledgedIds: ids,
      reopenedIds,
      storage: results.map((item) => item.storage),
    });
  },
);

test(
  "three fatal-only processes contend for one bounded emergency rotation turn",
  { timeout: 15000 },
  async (t) => {
    const dataDir = await createTempDir(t),
      maxFileBytes = 4096;
    const children = Array.from({ length: 3 }, (_, index) =>
      child(t, {
        dataDir,
        maxFileBytes,
        iterations: 20,
        fatalOnly: true,
        runId: `r-fatal-${index}`,
      }),
    );
    await Promise.all(children.map((item) => item.waitFor("ready")));
    children.forEach((item) => item.go());
    const results = await Promise.all(
      children.map((item) => item.waitFor("done")),
    );
    await Promise.all(children.map((item) => item.exit));
    for (const result of results)
      assert.deepEqual(result.storage, {
        mode: "file",
        pendingWrites: 0,
        droppedWrites: 0,
        failedWrites: 0,
      });
    const entries = await diskEntries(dataDir, maxFileBytes);
    const files = await fs.readdir(path.join(dataDir, "logs"));
    assert.deepEqual(files.sort(), [
      "application.fatal.log",
      "application.fatal.previous.log",
    ]);
    assert.equal(
      (await createDiagnosticsLog({ dataDir, maxFileBytes }).list()).summary
        .damagedLines,
      0,
    );
    t.diagnostic(
      JSON.stringify({
        case: "simultaneous-fatal-only",
        acknowledged: results.reduce((sum, item) => sum + item.ids.length, 0),
        retained: entries.length,
        failedWrites: results.map((item) => item.storage.failedWrites),
      }),
    );
    await receipt("fatal-only", dataDir, {
      case: "simultaneous-fatal-only",
      maxFileBytes,
      acknowledgedIds: results.flatMap((item) => item.ids),
      retainedIds: entries.map((item) => item.diagnosticId),
      storage: results.map((item) => item.storage),
    });
  },
);

test(
  "a hard-killed normal lock owner is recovered by an independent writer",
  { timeout: 15000 },
  async (t) => {
    const dataDir = await createTempDir(t);
    const holder = child(t, {
      dataDir,
      iterations: 1,
      hold: true,
      runId: "r-killed",
    });
    await holder.waitFor("ready");
    holder.go();
    await holder.waitFor("held");
    holder.processHandle.kill("SIGKILL");
    await holder.exit;
    const log = createDiagnosticsLog({ dataDir, maxMemoryEntries: 0 });
    const entry = await log.record({
      operation: "run.started",
      runId: "r-recovered",
    });
    const result = await log.list();
    assert.equal(result.storage.mode, "file");
    assert.equal(result.storage.failedWrites, 0);
    assert.ok(
      (await diskEntries(dataDir)).some(
        (item) => item.diagnosticId === entry.diagnosticId,
      ),
    );
  },
);

test(
  "fatal exit persists while another process owns the normal writer turn",
  { timeout: 15000 },
  async (t) => {
    const dataDir = await createTempDir(t);
    const holder = child(t, {
      dataDir,
      iterations: 1,
      hold: true,
      runId: "r-held",
    });
    await holder.waitFor("ready");
    holder.go();
    await holder.waitFor("held");
    const crashing = child(t, { dataDir, crash: true, runId: "r-fatal-exit" });
    await crashing.waitFor("ready");
    crashing.go();
    assert.equal((await crashing.exit).code, 1);
    const result = await createDiagnosticsLog({ dataDir }).list({
      runId: "r-fatal-exit",
    });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].code, "main_uncaught");
    assert.doesNotMatch(JSON.stringify(result), /private/);
    holder.processHandle.send({ release: true });
    await holder.waitFor("done");
  },
);

test(
  "fatal uses its own turn when this process has a pending async append",
  { timeout: 10000 },
  async (t) => {
    const dataDir = await createTempDir(t);
    let release, held;
    const holding = new Promise((resolve) => {
      held = resolve;
    });
    const adapter = {
      ...fs,
      appendFile: async (...args) => {
        held();
        await new Promise((resolve) => {
          release = resolve;
        });
        return fs.appendFile(...args);
      },
    };
    const log = createDiagnosticsLog({
      dataDir,
      fsAdapter: adapter,
      maxMemoryEntries: 0,
    });
    const writing = log.record({ operation: "desktop.start" });
    await holding;
    const fatal = log.recordFatal(
      { operation: "desktop.failure" },
      Error("private"),
    );
    assert.ok(
      (await diskEntries(dataDir)).some(
        (entry) => entry.diagnosticId === fatal.diagnosticId,
      ),
    );
    release();
    await writing;
    assert.equal((await log.list()).storage.failedWrites, 0);
  },
);

test("runIds is an internal fail-closed allowlist applied before the result limit", async (t) => {
  const dataDir = await createTempDir(t),
    log = createDiagnosticsLog({ dataDir });
  const allowed = await log.record({
    operation: "run.failed",
    runId: "r-allowed",
  });
  await log.record({ operation: "run.stage", runId: "r-other" });
  const result = await log.list({ runIds: ["r-allowed"], limit: 1 });
  assert.equal(result.entries[0].diagnosticId, allowed.diagnosticId);
  assert.equal((await log.list({ runIds: [] })).entries.length, 0);
  assert.equal((await log.list({ runIds: "r-allowed" })).entries.length, 0);
  assert.ok(
    (await log.exportText({ runIds: ["r-allowed"] })).includes(
      allowed.diagnosticId,
    ),
  );
});

test(
  "a caller deadline keeps another live writer's turn and does not disable independent fatal IO",
  { timeout: 15000 },
  async (t) => {
    const dataDir = await createTempDir(t);
    const holder = child(t, {
      dataDir,
      iterations: 1,
      hold: true,
      runId: "r-held",
    });
    await holder.waitFor("ready");
    holder.go();
    await holder.waitFor("held");
    const lockFile = path.join(dataDir, "logs", ".application.lock");
    const originalOwner = await fs.readFile(lockFile, "utf8");
    const log = createDiagnosticsLog({ dataDir });
    const entry = await log.record({
      operation: "run.started",
      runId: "r-waiting",
    });
    assert.equal(await fs.readFile(lockFile, "utf8"), originalOwner);
    assert.equal((await diskEntries(dataDir)).length, 0);
    const fatal = log.recordFatal({
      operation: "desktop.failure",
      runId: "r-waiting",
    });
    assert.ok(
      (await diskEntries(dataDir)).some(
        (item) => item.diagnosticId === fatal.diagnosticId,
      ),
    );
    holder.processHandle.send({ release: true });
    const completed = await holder.waitFor("done");
    const retried = await log.record({
      operation: "run.started",
      runId: "r-retried",
    });
    const result = await log.list();
    assert.equal(result.storage.mode, "memory");
    assert.equal(result.storage.failedWrites, 1);
    assert.equal(result.storage.pendingWrites, 0);
    assert.ok(
      result.entries.some((item) => item.diagnosticId === entry.diagnosticId),
    );
    assert.deepEqual(
      (await diskEntries(dataDir)).map((item) => item.diagnosticId).sort(),
      [...completed.ids, retried.diagnosticId, fatal.diagnosticId].sort(),
    );
  },
);

test(
  "fatal contention has a bounded failure and a hard-killed fatal owner is recovered",
  { timeout: 15000 },
  async (t) => {
    const dataDir = await createTempDir(t);
    const holder = child(t, { dataDir, holdFatal: true });
    await holder.waitFor("ready");
    holder.go();
    await holder.waitFor("held");
    const lockFile = path.join(dataDir, "logs", ".application-fatal.lock");
    const originalOwner = await fs.readFile(lockFile, "utf8");
    const log = createDiagnosticsLog({ dataDir });
    const start = Date.now();
    const failed = log.recordFatal({ operation: "desktop.failure" });
    assert.ok(
      Date.now() - start < 1500,
      "fatal lock contention cannot block process exit indefinitely",
    );
    assert.equal(await fs.readFile(lockFile, "utf8"), originalOwner);
    const result = await log.list();
    assert.equal(result.storage.mode, "memory");
    assert.equal(result.storage.failedWrites, 1);
    assert.ok(
      result.entries.some(
        (entry) => entry.diagnosticId === failed.diagnosticId,
      ),
    );
    assert.equal((await diskEntries(dataDir)).length, 0);
    holder.processHandle.kill("SIGKILL");
    await holder.exit;
    const recovered = createDiagnosticsLog({ dataDir, maxMemoryEntries: 0 });
    const entry = recovered.recordFatal({ operation: "desktop.failure" });
    assert.ok(
      (await diskEntries(dataDir)).some(
        (item) => item.diagnosticId === entry.diagnosticId,
      ),
    );
    assert.equal((await recovered.list()).storage.failedWrites, 0);
  },
);

test("unreadable or uncertain fatal lock ownership is never stolen", async (t) => {
  for (const kind of ["malformed", "EPERM"]) {
    const dataDir = await createTempDir(t);
    const lockFile = path.join(dataDir, "logs", ".application-fatal.lock");
    const owner =
      kind === "malformed"
        ? "unknown owner"
        : JSON.stringify({ pid: 2147483646, token: randomUUID() });
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, owner);
    const originalKill = process.kill;
    if (kind === "EPERM")
      process.kill = (pid, signal) => {
        if (pid === 2147483646)
          throw Object.assign(Error("uncertain pid"), { code: "EPERM" });
        return originalKill(pid, signal);
      };
    try {
      const log = createDiagnosticsLog({ dataDir });
      log.recordFatal({ operation: "desktop.failure" });
      assert.equal(await fs.readFile(lockFile, "utf8"), owner, kind);
      const result = await log.list();
      assert.equal(result.storage.failedWrites, 1, kind);
      assert.equal(result.storage.mode, "memory", kind);
      assert.equal((await diskEntries(dataDir)).length, 0, kind);
    } finally {
      process.kill = originalKill;
    }
  }
});

test("unknown normal owner remains intact after timeout and new records retry only after release", async (t) => {
  for (const kind of ["malformed", "EPERM"]) {
    const dataDir = await createTempDir(t);
    const lockFile = path.join(dataDir, "logs", ".application.lock");
    const owner =
      kind === "malformed"
        ? "unknown owner"
        : JSON.stringify({ pid: 2147483646, token: randomUUID() });
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, owner);
    const originalKill = process.kill;
    if (kind === "EPERM")
      process.kill = (pid, signal) => {
        if (pid === 2147483646)
          throw Object.assign(Error("uncertain pid"), { code: "EPERM" });
        return originalKill(pid, signal);
      };
    try {
      const log = createDiagnosticsLog({ dataDir });
      const entry = await log.record({ operation: "run.stage" });
      assert.equal(await fs.readFile(lockFile, "utf8"), owner, kind);
      assert.equal((await diskEntries(dataDir)).length, 0, kind);
      const blocked = await log.list();
      assert.equal(blocked.storage.pendingWrites, 0, kind);
      assert.equal(blocked.storage.failedWrites, 1, kind);
      await fs.unlink(lockFile);
      const retried = await log.record({ operation: "run.started" });
      const result = await log.list();
      assert.equal(result.storage.pendingWrites, 0, kind);
      assert.equal(result.storage.failedWrites, 1, kind);
      assert.equal(result.storage.mode, "memory", kind);
      assert.ok(
        result.entries.some((item) => item.diagnosticId === entry.diagnosticId),
      );
      assert.deepEqual(
        (await diskEntries(dataDir)).map((item) => item.diagnosticId),
        [retried.diagnosticId],
      );
    } finally {
      process.kill = originalKill;
    }
  }
});

test(
  "a CLI naturally exits after live or unknown log contention and a full pending queue",
  { timeout: 10000 },
  async (t) => {
    for (const kind of ["live", "unknown", "full-queue"]) {
      const dataDir = await createTempDir(t);
      const lockFile = path.join(dataDir, "logs", ".application.lock");
      const owner =
        kind === "live"
          ? JSON.stringify({ pid: process.pid, token: randomUUID() })
          : "unknown owner";
      await fs.mkdir(path.dirname(lockFile), { recursive: true });
      await fs.writeFile(lockFile, owner);
      const waiting = child(t, {
        dataDir,
        exitAfterRecord: true,
        iterations: kind === "full-queue" ? 260 : 1,
      });
      await waiting.waitFor("ready");
      const startedAt = Date.now();
      waiting.go();
      const result = await waiting.waitFor("done");
      let timer;
      try {
        const exited = await Promise.race([
          waiting.exit,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error("CLI stayed alive after observing log contention"),
                ),
              1500,
            );
          }),
        ]);
        assert.equal(exited.code, 0, kind);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(await fs.readFile(lockFile, "utf8"), owner, kind);
      assert.equal(result.storage.pendingWrites, 0, kind);
      assert.equal(
        result.storage.failedWrites,
        kind === "full-queue" ? 256 : 1,
        kind,
      );
      assert.equal(
        result.storage.droppedWrites,
        kind === "full-queue" ? 4 : 0,
        kind,
      );
      const facts = {
        case: "natural-exit-" + kind,
        elapsedMs: Date.now() - startedAt,
        ownerPreserved: true,
        storage: result.storage,
      };
      t.diagnostic(JSON.stringify(facts));
      await receipt("natural-exit-" + kind, dataDir, facts);
    }
  },
);

test(
  "publication crashes do not accumulate dead log coordination artifacts or delete live and uncertain files",
  { timeout: 20000 },
  async (t) => {
    for (const kind of ["normal", "fatal"]) {
      const dataDir = await createTempDir(t),
        directory = path.join(dataDir, "logs");
      await fs.mkdir(directory, { recursive: true });
      const prefix =
        kind === "normal" ? ".application.lock" : ".application-fatal.lock";
      const live = `${prefix}.${process.pid}.${"a".repeat(32)}.tmp`;
      const uncertain = `${prefix}.2147483646.${"b".repeat(32)}.tmp`;
      const unknown = `${prefix}.unknown.tmp`;
      for (const name of [live, uncertain, unknown])
        await fs.writeFile(path.join(directory, name), "synthetic publication");
      const originalKill = process.kill;
      process.kill = (pid, signal) => {
        if (pid === 2147483646)
          throw Object.assign(Error("uncertain pid"), { code: "EPERM" });
        return originalKill(pid, signal);
      };
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          const crashing = child(t, {
            dataDir,
            iterations: 1,
            crashPublication: kind,
            fatalOnly: kind === "fatal",
          });
          await crashing.waitFor("ready");
          crashing.go();
          assert.equal((await crashing.exit).code, 86);
          const crashed = await fs.readdir(directory);
          assert.ok(
            crashed.filter(
              (name) => name.startsWith(prefix + ".") && name.endsWith(".tmp"),
            ).length > 3,
          );
          const recovered = createDiagnosticsLog({
            dataDir,
            maxMemoryEntries: 0,
          });
          const entry =
            kind === "normal"
              ? await recovered.record({ operation: "run.started" })
              : recovered.recordFatal({ operation: "desktop.failure" });
          const result = await recovered.list();
          assert.equal(result.storage.failedWrites, 0);
          assert.ok(
            result.entries.some(
              (item) => item.diagnosticId === entry.diagnosticId,
            ),
          );
          const artifacts = (await fs.readdir(directory)).filter(
            (name) => name.startsWith(prefix + ".") && name.endsWith(".tmp"),
          );
          assert.deepEqual(artifacts.sort(), [live, uncertain, unknown].sort());
        }
        t.diagnostic(
          JSON.stringify({
            case: "publication-crash-" + kind,
            recoveries: 3,
            deadArtifacts: 0,
            protectedArtifacts: 3,
          }),
        );
      } finally {
        process.kill = originalKill;
      }
    }
  },
);
