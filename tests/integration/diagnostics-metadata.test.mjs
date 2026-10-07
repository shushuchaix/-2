import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTempDir } from "../helpers/fixtures.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";

test("detailed diagnostic metadata survives restart while unknown nested payloads are discarded", async (t) => {
  const dataDir = await createTempDir(t);
  const log = createDiagnosticsLog({ dataDir });
  const requestId = "q-00000000-0000-4000-8000-000000000001";
  const error = Object.assign(Error("private-response"), {
    code: "parse_error",
    phase: "parse",
    requestId,
    parser: {
      format: "html",
      selectorPresent: true,
      titleOnly: true,
      textLength: 9,
      text: "private-resume",
      selector: "private-key",
    },
  });
  const entry = await log.record(
    {
      operation: "run.finished",
      runId: "r-test",
      requestId,
      phase: "finished",
      outcome: "partial",
      durationMs: 93,
      counts: {
        raw: 12,
        accepted: 10,
        rejected: 2,
        profile: "private-profile",
      },
      coverage: {
        complete: 2,
        failed: 1,
        truncated: 1,
        sites: 3,
        queries: ["private-keyword"],
      },
      usage: {
        sources: {
          requests: 6,
          maxRequests: 10,
          byKind: { dns: 2, request: 4, "private-key": 3 },
        },
        model: { requests: 1, promptTokens: 123, prompt: "private-prompt" },
      },
      headers: { authorization: "private-token" },
      url: "https://example.test/private-name?q=private-keyword",
    },
    error,
  );
  const reopened = createDiagnosticsLog({ dataDir });
  const result = await reopened.list();
  const saved = result.entries.find(
    (e) => e.diagnosticId === entry.diagnosticId,
  );
  assert.equal(saved.schemaVersion, 2);
  assert.match(saved.sessionId, /^s-[a-f0-9-]{36}$/);
  assert.equal(saved.requestId, requestId);
  assert.deepEqual(saved.counts, { raw: 12, accepted: 10, rejected: 2 });
  assert.deepEqual(saved.coverage, {
    complete: 2,
    failed: 1,
    truncated: 1,
    sites: 3,
  });
  assert.equal(saved.usage.sources.byKind.dns, 2);
  assert.equal(saved.error.phase, "parse");
  assert.equal(saved.error.parser.textLength, 9);
  assert.equal(saved.error.parser.titleOnly, true);
  assert.equal(JSON.stringify(result).includes("private-"), false);
  assert.equal((await reopened.exportText()).includes("private-"), false);
});

test("export includes an early root cause after more than 200 routine events", async (t) => {
  const dataDir = await createTempDir(t);
  let tick = Date.UTC(2026, 9, 7);
  const log = createDiagnosticsLog({ dataDir, clock: { now: () => tick++ } });
  const root = await log.record(
    { operation: "run.collect", runId: "r-long" },
    Object.assign(Error("failure"), { code: "ECONNRESET" }),
  );
  for (let i = 0; i < 240; i++)
    await log.record({
      operation: "run.stage",
      runId: "r-long",
      stage: "collecting",
    });
  const result = await log.list({ runId: "r-long" });
  assert.equal(result.entries.length, 200);
  assert.equal(result.summary.total, 241);
  assert.equal(result.summary.truncated, true);
  const exported = await createDiagnosticsLog({ dataDir }).exportText({
    runId: "r-long",
  });
  const entries = exported
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 241);
  assert.equal(entries[0].diagnosticId, root.diagnosticId);
  assert.ok(exported.includes("241"));
});

test("severity and correlation filters find old failures before the view limit", async (t) => {
  const log = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const failure = await log.record(
    {
      operation: "network.request",
      runId: "r-first",
      sourceId: "synthetic",
      requestId: "q-00000000-0000-4000-8000-000000000002",
      outcome: "failed",
    },
    Object.assign(Error("private-body"), { code: "ETIMEDOUT" }),
  );
  await log.record({
    operation: "run.detail.insufficient",
    runId: "r-first",
    level: "warn",
  });
  for (let i = 0; i < 210; i++)
    await log.record({
      operation: "run.stage",
      runId: "r-second",
      stage: "planning",
    });
  const result = await log.list({
    level: "problem",
    sourceId: "synthetic",
    category: "network",
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].diagnosticId, failure.diagnosticId);
  assert.equal(result.summary.errors, 1);
  assert.equal(
    (await log.list({ diagnosticId: failure.diagnosticId })).entries.length,
    1,
  );
  assert.equal(
    (await log.list({ requestId: failure.requestId })).entries.length,
    1,
  );
});

test("tampered metadata is sanitized again and export reports damaged or rotated history", async (t) => {
  const dataDir = await createTempDir(t);
  const log = createDiagnosticsLog({ dataDir });
  const entry = await log.record({ operation: "http.request" });
  const altered = {
    ...entry,
    route: "/api/v2/profiles/private-name",
    phase: "private-phase",
    requestId: "private-key",
    counts: { raw: -1, accepted: 2, password: "private-password" },
    runtime: {
      appVersion: "private-key",
      nodeVersion: "20.20.2",
      user: "private-user",
    },
    parser: { format: "private-format", textLength: -1, text: "private-text" },
  };
  await fs.writeFile(
    path.join(dataDir, "logs", "application.log"),
    "damaged\n" + JSON.stringify(altered) + "\n",
  );
  const reopened = createDiagnosticsLog({ dataDir });
  const result = await reopened.list();
  assert.equal(result.summary.damagedLines, 1);
  assert.equal(JSON.stringify(result).includes("private-"), false);
  assert.deepEqual(result.entries[0].counts, { accepted: 2 });
  assert.match(await reopened.exportText(), /损坏|不完整/);
});

test("diagnostic sink exceptions never change a successful business result", async () => {
  const { recordDiagnostic } = await import(
    "../../src/infrastructure/diagnostics/log.mjs"
  );
  assert.equal(typeof recordDiagnostic, "function");
  const sink = {
    record: async () => {
      throw Error("unavailable sink");
    },
  };
  assert.equal(
    await recordDiagnostic(sink, { operation: "storage.write" }),
    undefined,
  );
});

test("optional diagnostic callbacks receive an event without changing its outcome", async () => {
  const { recordDiagnostic } = await import(
    "../../src/infrastructure/diagnostics/log.mjs"
  );
  const events = [];
  const result = await recordDiagnostic(
    (event) => {
      events.push(event);
      return { diagnosticId: "observed" };
    },
    { operation: "run.started" },
  );
  assert.equal(events.length, 1);
  assert.equal(result.diagnosticId, "observed");
});

test("concurrent task contexts correlate internal storage logs without mixing tasks", async (t) => {
  const { withDiagnosticContext } = await import(
    "../../src/infrastructure/diagnostics/log.mjs"
  );
  assert.equal(typeof withDiagnosticContext, "function");
  const log = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  await Promise.all(
    ["r-left", "r-right"].map((runId) =>
      withDiagnosticContext({ runId, password: "private-key" }, async () => {
        await Promise.resolve();
        await log.record({
          operation: "storage.transaction",
          phase: "current",
          outcome: "success",
        });
      }),
    ),
  );
  for (const runId of ["r-left", "r-right"])
    assert.equal((await log.list({ runId })).entries.length, 1);
  await log.record({ operation: "desktop.start" });
  const result = await log.list();
  assert.equal(
    result.entries.find((e) => e.operation === "desktop.start").runId,
    undefined,
  );
  assert.equal(JSON.stringify(result).includes("private-key"), false);
});

test("default export includes all retained events even beyond 5000", async (t) => {
  const dataDir = await createTempDir(t);
  const log = createDiagnosticsLog({ dataDir });
  const first = await log.record({ operation: "run.failed", runId: "r-many" });
  // Seed retained history in one write; this verifies export scope, not disk throughput.
  const history = [
    first,
    ...Array.from({ length: 5000 }, () => ({
      ...first,
      diagnosticId: "d-" + randomUUID(),
    })),
  ];
  await fs.writeFile(
    path.join(dataDir, "logs", "application.log"),
    history.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const reopened = createDiagnosticsLog({ dataDir });
  const text = await reopened.exportText({ runId: "r-many" });
  assert.ok(text.includes(first.diagnosticId));
  assert.equal(
    text.split("\n").filter((line) => line.startsWith("{")).length,
    5001,
  );
});

test("fatal diagnostics persist before default process termination without private content", async (t) => {
  const dataDir = await createTempDir(t);
  const moduleUrl = new URL(
    "../../src/infrastructure/diagnostics/log.mjs",
    import.meta.url,
  ).href;
  const script = `import {createDiagnosticsLog} from ${JSON.stringify(moduleUrl)}; const log=createDiagnosticsLog({dataDir:process.argv[1]}); await log.record({operation:'desktop.start'}); process.on('uncaughtExceptionMonitor', error=>log.recordFatal({operation:'desktop.failure', code:'main_uncaught',outcome:'failed'},error)); setImmediate(()=>{throw Error('private resume password')});`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, dataDir],
    { encoding: "utf8", timeout: 4000 },
  );
  assert.equal(result.status, 1);
  const entries = (await createDiagnosticsLog({ dataDir }).list()).entries;
  assert.ok(entries.some((e) => e.code === "main_uncaught" && e.error));
  assert.equal(JSON.stringify(entries).includes("private"), false);
});

test("a stalled observer has a deadline so business results can continue", async () => {
  const { recordDiagnostic } = await import(
    "../../src/infrastructure/diagnostics/log.mjs"
  );
  let timeout;
  try {
    const result = await Promise.race([
      recordDiagnostic(() => new Promise(() => {}), {
        operation: "storage.transaction",
      }),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve("blocked"), 1200);
      }),
    ]);
    assert.equal(result, undefined);
  } finally {
    clearTimeout(timeout);
  }
});

test("stalled file writes fall back to bounded memory that can still be exported", async (t) => {
  const dataDir = await createTempDir(t);
  const log = createDiagnosticsLog({
    dataDir,
    maxMemoryEntries: 3,
    fsAdapter: { ...fs, mkdir: () => new Promise(() => {}) },
  });
  const writes = Array.from({ length: 8 }, () =>
    log.record({ operation: "run.failed", runId: "r-stalled" }),
  );
  let timer;
  try {
    const result = await Promise.race([
      Promise.all(writes).then(() => log.list()),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 1800);
      }),
    ]);
    assert.ok(result, "diagnostic IO must have a deadline");
    assert.equal(result.storage.mode, "memory");
    assert.equal(result.entries.length, 3);
    assert.match(await log.exportText(), /r-stalled/);
  } finally {
    clearTimeout(timer);
  }
});

test("fatal logging never raises a secondary exception from error accessors", async (t) => {
  const log = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const error = Object.defineProperty(Error("synthetic"), "stack", {
    get() {
      throw Error("secondary failure");
    },
  });
  assert.doesNotThrow(() =>
    log.recordFatal({ operation: "desktop.failure" }, error),
  );
});

test("fatal logging avoids synchronous IO after a known filesystem stall", async (t) => {
  const log = createDiagnosticsLog({
    dataDir: await createTempDir(t),
    fsAdapter: { ...fs, mkdir: () => new Promise(() => {}) },
  });
  await log.record({ operation: "desktop.start" });
  const originalMkdir = fsSync.mkdirSync;
  let calls = 0;
  fsSync.mkdirSync = () => {
    calls++;
  };
  try {
    log.recordFatal({ operation: "desktop.failure" }, Error("synthetic"));
    assert.equal(calls, 0);
  } finally {
    fsSync.mkdirSync = originalMkdir;
  }
});
