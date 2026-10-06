import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir, job, profile, target } from "../helpers/fixtures.mjs";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { writeAtomicJson } from "../../src/infrastructure/storage/atomic.mjs";
import { once } from "node:events";
import { createServer } from "../../src/server.mjs";
import { loadConfig } from "../../src/config.mjs";
import { hashPassword } from "../../src/auth.mjs";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";
import {
  createPagedProvider,
  jsonResponse,
} from "../../src/sources/adapters/shared.mjs";
import { createLegacyProvider } from "../../src/sources/adapters/legacy.mjs";

async function logger(t, options = {}) {
  const module = await import(
    "../../src/infrastructure/diagnostics/log.mjs"
  ).catch(() => null);
  assert.ok(module, "本地诊断日志模块应存在");
  return module.createDiagnosticsLog({
    dataDir: await createTempDir(t),
    ...options,
  });
}

test("diagnostics survive restart and omit sensitive errors and event payloads", async (t) => {
  const log = await logger(t);
  const error = Object.assign(
    Error(
      "password=private-pass Bearer private-token resume私密正文 https://user:pass@example.com/?apiKey=private-key",
    ),
    {
      code: "EPERM",
      syscall: "rename",
      path: "C:/Users/private-name/workspace.v2.json",
    },
  );
  error.stack +=
    "\n    at writeAtomicJson (C:/Users/private-name/project/src/infrastructure/storage/atomic.mjs:25:21)";
  const entry = await log.record(
    {
      operation: "run.ingest",
      level: "error",
      runId: "r-test",
      stage: "details",
      sourceId: "synthetic",
      body: { password: "private-pass" },
      profile: "私密正文",
    },
    error,
  );
  assert.match(entry.diagnosticId, /^d-/);
  const module = await import("../../src/infrastructure/diagnostics/log.mjs");
  const reopened = module.createDiagnosticsLog({ dataDir: log.dataDir });
  const result = await reopened.list({ runId: "r-test" });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].error.code, "EPERM");
  assert.equal(result.entries[0].error.resource, "workspace.v2.json");
  assert.match(
    result.entries[0].error.stack,
    /src\/infrastructure\/storage\/atomic.mjs:25:21/,
  );
  const serialized = JSON.stringify(result);
  for (const secret of [
    "private-pass",
    "private-token",
    "private-key",
    "private-name",
    "私密正文",
    "user:pass",
  ])
    assert.equal(serialized.includes(secret), false, secret);
});

test("diagnostic rotation is bounded and filtering returns newest task records", async (t) => {
  const log = await logger(t, { maxFileBytes: 1200 });
  for (let i = 0; i < 18; i++)
    await log.record({
      operation: "run.stage",
      runId: i % 2 ? "r-first" : "r-second",
      stage: "collecting",
    });
  const result = await log.list({ runId: "r-first", limit: 3 });
  assert.equal(result.entries.length, 3);
  assert.ok(result.entries.every((entry) => entry.runId === "r-first"));
  const files = await fs.readdir(path.join(log.dataDir, "logs"));
  assert.deepEqual(files.sort(), [
    "application.log",
    "application.previous.log",
  ]);
  for (const file of files)
    assert.ok(
      (await fs.stat(path.join(log.dataDir, "logs", file))).size <= 1200,
    );
});

test("logging permission failure keeps an in-memory diagnostic without throwing", async (t) => {
  const log = await logger(t, {
    fsAdapter: {
      mkdir: async () => {
        throw Object.assign(Error("denied"), { code: "EACCES" });
      },
    },
  });
  const entry = await log.record(
    { operation: "run.failed", runId: "r-memory" },
    Error("Invalid source url"),
  );
  const result = await log.list({ runId: "r-memory" });
  assert.equal(result.storage.mode, "memory");
  assert.match(result.storage.message, /日志.*写入|权限/);
  assert.equal(result.entries[0].diagnosticId, entry.diagnosticId);
});

test("HTTP failures return a matching diagnostic id and logs can be exported", async (t) => {
  const f = await apiFixture(t),
    app = await f.ctx.ready;
  app.sourceService.probe = async () => {
    throw Object.assign(Error("private-body"), {
      code: "EPERM",
      syscall: "rename",
    });
  };
  const failed = await f.call("/api/v2/sources/synthetic/probe", {}, "POST");
  assert.equal(failed.response.status, 500);
  assert.match(failed.data.diagnosticId || "", /^d-/);
  const logs = await f.call("/api/v2/diagnostics/logs");
  assert.equal(logs.response.status, 200);
  assert.ok(
    logs.data.entries.some(
      (e) =>
        e.diagnosticId === failed.data.diagnosticId && e.error.code === "EPERM",
    ),
  );
  const exported = await f.call("/api/v2/diagnostics/logs/export");
  assert.match(exported.response.headers.get("content-type"), /text\/plain/);
  assert.ok(exported.text.includes(failed.data.diagnosticId));
  assert.equal(exported.text.includes("private-body"), false);
});

test("diagnostic API rejects unsupported filters and does not accept file paths", async (t) => {
  const f = await apiFixture(t);
  for (const query of [
    "runId=../workspace",
    "limit=10000",
    "path=workspace.v2.json",
  ])
    assert.equal(
      (await f.call("/api/v2/diagnostics/logs?" + query)).response.status,
      400,
    );
});

test("invalid source records have a diagnosed ingest failure rather than a storage label", async (t) => {
  const provider = fakeProvider({ records: [job({ title: "" })] });
  const f = await apiFixture(t, { providers: [provider] }),
    app = await f.ctx.ready;
  const p = await app.workspaceService.saveProfile({ profile: profile() });
  const tar = await app.workspaceService.saveTarget({
    ...target(),
    profileRevisionId: p.revisionId,
  });
  const { runId } = await app.runService.startRun({
    targetRevisionId: tar.revisionId,
  });
  const result = await app.runService.waitForRun(runId);
  assert.equal(result.run.status, "failed");
  const issue = result.run.issues.find(
    (i) => i.code === "record_ingest_failed",
  );
  assert.ok(issue, JSON.stringify(result.run.issues));
  assert.match(issue.diagnosticId, /^d-/);
  assert.match(issue.message, /记录.*处理/);
  const logs = await app.diagnostics.list({ runId });
  const cause = logs.entries.find((e) => e.diagnosticId === issue.diagnosticId);
  assert.equal(cause.operation, "run.ingest");
  assert.match(cause.error.message, /Missing source title/);
});

test("atomic write preserves the primary failure and exposes the failed write phase", async () => {
  const primary = Object.assign(Error("rename denied"), { code: "EPERM" });
  const fsAdapter = {
    mkdir: async () => {},
    open: async () => ({
      writeFile: async () => {},
      sync: async () => {},
      close: async () => {},
    }),
    rename: async () => {
      throw primary;
    },
    unlink: async () => {
      throw Object.assign(Error("cleanup denied"), { code: "EACCES" });
    },
  };
  await assert.rejects(
    writeAtomicJson("synthetic/workspace.v2.json", {}, { fsAdapter }),
    (error) => {
      assert.equal(error, primary);
      assert.equal(error.storageOperation, "atomic.rename");
      return true;
    },
  );
});

test("log viewing and export require the same login as the workspace", async (t) => {
  const dataDir = await createTempDir(t),
    cfg = loadConfig({ quiet: true, dataDir });
  cfg.auth.mode = "password";
  cfg.auth.passwordHash = hashPassword("synthetic-test-password");
  const { server, ready } = createServer(cfg, { dataDir });
  await ready;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  allowLocalOrigin(origin);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  for (const suffix of ["", "/export"])
    assert.equal(
      (await fetch(origin + "/api/v2/diagnostics/logs" + suffix)).status,
      401,
    );
});

test("reading a damaged log rejects injected private fields and skips invalid lines", async (t) => {
  const log = await logger(t);
  const entry = await log.record({
    operation: "run.stage",
    runId: "r-safe",
    stage: "details",
  });
  const file = path.join(log.dataDir, "logs", "application.log");
  await fs.writeFile(
    file,
    "invalid-json\n" +
      JSON.stringify({
        ...entry,
        body: "private-body",
        message: "private-message",
        error: { message: "private-error", stack: "private-stack" },
      }) +
      "\n",
  );
  const module = await import("../../src/infrastructure/diagnostics/log.mjs");
  const result = await module
    .createDiagnosticsLog({ dataDir: log.dataDir })
    .list();
  assert.equal(result.entries.length, 1);
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("caught paged HTTP errors keep status and diagnostic ids in collection and probe", async (t) => {
  const provider = createPagedProvider({
    id: "ncss",
    name: "合成来源",
    capabilities: { category: "job_board" },
    listPage: async () => jsonResponse({ status: 503, text: "private-body" }),
  });
  const f = await apiFixture(t, { providers: [provider] }),
    app = await f.ctx.ready;
  const p = await app.workspaceService.saveProfile({ profile: profile() });
  const tar = await app.workspaceService.saveTarget({
    ...target({ sourceIds: ["ncss"] }),
    profileRevisionId: p.revisionId,
  });
  const { runId } = await app.runService.startRun({
    targetRevisionId: tar.revisionId,
  });
  const result = await app.runService.waitForRun(runId);
  assert.match(result.run.issues[0].diagnosticId || "", /^d-/);
  const logs = await app.diagnostics.list({ runId });
  assert.ok(
    logs.entries.some(
      (e) => e.operation === "run.collect" && e.error?.status === 503,
    ),
  );
  const probe = await app.sourceService.probe("ncss", "ncss");
  assert.match(probe.issues[0].diagnosticId || "", /^d-/);
  const all = await app.diagnostics.list();
  assert.ok(
    all.entries.some(
      (e) => e.operation === "source.probe" && e.error?.status === 503,
    ),
  );
});

test("paged and legacy adapters propagate fatal ingestion without swallowing its cause", async () => {
  const paged = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({ records: [job()], hasMore: false }),
  });
  const legacy = createLegacyProvider("zhaopin", {
    collector: async () => ({ jobs: [job()], errors: [] }),
  });
  for (const provider of [paged, legacy]) {
    const primary = Object.assign(Error("ingestion failed"), {
      code: "EPERM",
      runFatal: true,
    });
    await assert.rejects(
      provider.collect({
        sites: [{ siteId: "synthetic-1" }],
        queries: [{ keyword: "Java" }],
        targetSnapshot: {},
        onBatch: async () => {
          throw primary;
        },
      }),
      (error) => error === primary,
    );
  }
});

test("legacy collectors returning error strings retain their safe HTTP status", async (t) => {
  const log = await logger(t);
  const provider = createLegacyProvider("zhaopin", {
    collector: async () => ({
      jobs: [],
      errors: ["request failed HTTP 403 private-body"],
    }),
  });
  const result = await provider.collect({
    sites: [{ siteId: "zhaopin-1" }],
    queries: [{ keyword: "Java" }],
    targetSnapshot: {},
    reportError: (error, context) =>
      log.record({ operation: "run.collect", ...context }, error),
  });
  assert.match(result.issues[0].diagnosticId || "", /^d-/);
  const logs = await log.list();
  assert.equal(logs.entries[0].error.status, 403);
  assert.equal(JSON.stringify(logs).includes("private-body"), false);
});
