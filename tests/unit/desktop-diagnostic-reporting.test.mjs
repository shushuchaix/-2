import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { createHostDiagnostics } from "../../src/infrastructure/diagnostics/host-log.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
import { registerCredentialIpc } from "../../electron/credentials.mjs";

async function desktopModule() {
  const module = await import("../../electron/diagnostics.mjs").catch(
    () => null,
  );
  assert.ok(module, "controlled desktop diagnostic reporting is available");
  return module;
}

test("desktop renderer reports reject foreign frames and omit private fields", async (t) => {
  const module = await desktopModule();
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const handlers = new Map(),
    frame = { url: "http://127.0.0.1:3000/" },
    webContents = { mainFrame: frame };
  module.registerDiagnosticIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    diagnostics,
    getWindow: () => ({ webContents }),
    getOrigin: () => frame.url,
  });
  const handler = handlers.get("diagnostics:report"),
    event = { sender: webContents, senderFrame: frame };
  await assert.rejects(
    handler(
      { ...event, senderFrame: { url: "https://example.test/" } },
      { operation: "renderer.request" },
    ),
    /sender/,
  );
  const result = await handler(event, {
    operation: "renderer.request",
    route: "/api/v2/jobs/private-id/application?private-query",
    code: "network_error",
    phase: "transport",
    method: "PUT",
    outcome: "failed",
    message: "private body",
    headers: { secret: "private key" },
    error: {
      message: "private exception",
      stack:
        "Error: private\n at C:/Users/private/project/public/js/api.js:10:2",
    },
  });
  assert.match(result.diagnosticId || "", /^d-/);
  const entries = (await diagnostics.list()).entries;
  assert.equal(entries[0].route, "/api/v2/jobs/:id/application");
  assert.equal(JSON.stringify(entries).includes("private"), false);
});

test("desktop renderer reports bound size and rate without accepting business log injection", async (t) => {
  const module = await desktopModule();
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const handlers = new Map(),
    frame = { url: "http://127.0.0.1:3000/" },
    webContents = { mainFrame: frame };
  module.registerDiagnosticIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    diagnostics,
    getWindow: () => ({ webContents }),
    getOrigin: () => frame.url,
    clock: { now: () => 1000 },
  });
  const handler = handlers.get("diagnostics:report"),
    event = { sender: webContents, senderFrame: frame };
  await handler(event, { operation: "run.failed" });
  await handler(event, {
    operation: "renderer.failure",
    message: "x".repeat(9000),
  });
  assert.equal((await diagnostics.list()).entries.length, 0);
  for (let i = 0; i < 25; i++)
    await handler(event, {
      operation: "renderer.failure",
      code: "renderer_error",
      phase: "render",
      outcome: "failed",
    });
  const entries = (await diagnostics.list()).entries;
  assert.equal(entries.length, 20);
  assert.ok(entries.every((entry) => entry.operation === "renderer.failure"));
});

test("native renderer failures persist error codes without URLs or preload paths", async (t) => {
  const module = await desktopModule();
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  module.attachWindowDiagnostics({ window, diagnostics });
  window.webContents.emit(
    "did-fail-load",
    {},
    -2,
    "private network detail",
    "https://private.example/?secret=private",
  );
  window.webContents.emit(
    "preload-error",
    {},
    "C:/Users/private/preload.cjs",
    Error("private exception"),
  );
  window.webContents.emit(
    "render-process-gone",
    {},
    { reason: "crashed", exitCode: 9 },
  );
  const entries = (await diagnostics.list()).entries;
  assert.equal(entries.length, 3);
  assert.ok(
    entries.some(
      (entry) => entry.operation === "desktop.load" && entry.errorNumber === -2,
    ),
  );
  assert.ok(
    entries.some(
      (entry) => entry.operation === "desktop.renderer" && entry.exitCode === 9,
    ),
  );
  assert.equal(JSON.stringify(entries).includes("private"), false);
});

test("credential IPC failures return a diagnostic number without logging key arguments", async (t) => {
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const handlers = new Map(),
    frame = { url: "http://127.0.0.1:3000/" },
    webContents = { mainFrame: frame };
  const original = Object.assign(Error("private encryption exception"), {
    code: "EACCES",
  });
  registerCredentialIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    diagnostics,
    service: {
      save: async () => {
        throw original;
      },
    },
    getWindow: () => ({ webContents }),
    getOrigin: () => frame.url,
    onKey: async () => {throw original;},
  });
  await assert.rejects(
    handlers.get("credentials:save")(
      { sender: webContents, senderFrame: frame },
      "deepseek",
      "sk-private-key",
    ),
    (error) => /^d-/.test(error.diagnosticId || ""),
  );
  const entries = (await diagnostics.list()).entries;
  assert.equal(entries[0]?.operation, "desktop.credentials");
  assert.equal(JSON.stringify(entries).includes("private"), false);
});

test("accepted renderer reports retain the real host receipt when native IO reaches the observer deadline", async (t) => {
  const module = await desktopModule(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    ownerReleased = Promise.withResolvers();
  const dataDir = await createTempDir(t),
    ownerFile = path.join(dataDir, "logs", ".application.lock");
  let appends = 0,
    acceptedWrite,
    receipt;
  const sink = createHostDiagnostics({
    dataDir,
    runtime: { hostRole: "main" },
    fsAdapter: {
      ...fs,
      mkdir: async (...args) => {
        await fs.mkdir(...args);
        entered.resolve();
        await release.promise;
      },
      appendFile: async (...args) => {
        appends++;
        return fs.appendFile(...args);
      },
      unlink: async (...args) => {
        await fs.unlink(...args);
        if (args[0] === ownerFile) ownerReleased.resolve();
      },
    },
  });
  const handlers = new Map(),
    frame = { url: "http://127.0.0.1:3000/" },
    webContents = { mainFrame: frame };
  module.registerDiagnosticIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    diagnostics: {
      ...sink,
      record: (...args) => (acceptedWrite = sink.record(...args)),
    },
    getWindow: () => ({ webContents }),
    getOrigin: () => frame.url,
  });
  // Keep the product's two 500ms values. Deliver simultaneous deadlines in one
  // turn so the optional outer observer cannot win by scheduler luck.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const report = handlers.get("diagnostics:report")(
    { sender: webContents, senderFrame: frame },
    {
      operation: "renderer.failure",
      code: "renderer_error",
      outcome: "failed",
      message: "private message",
      headers: { cookie: "private cookie" },
    },
  );
  try {
    await entered.promise;
    t.mock.timers.tick(500);
    receipt = await report;
    const accepted = await acceptedWrite;
    assert.match(receipt?.diagnosticId || "", /^d-/);
    assert.deepEqual(receipt, { diagnosticId: accepted.diagnosticId });
    assert.equal(appends, 0); // A receipt is not a claim of successful disk IO.
    assert.equal(JSON.stringify(accepted).includes("private"), false);
  } finally {
    release.resolve();
    t.mock.timers.reset();
    await report.catch(() => {});
    await acceptedWrite;
    let cleanupTimer;
    try {
      // Wait for this actual native turn to release, not another 500ms observer
      // snapshot. The guard only prevents a broken fixture hanging the suite.
      await Promise.race([
        ownerReleased.promise,
        new Promise((_, reject) => {
          cleanupTimer = setTimeout(
            () => reject(Error("Synthetic diagnostic turn did not release")),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
    assert.equal((await sink.list()).storage.pendingWrites, 0);
  }
  const reopened = await createHostDiagnostics({
    dataDir,
    runtime: { hostRole: "main" },
  }).list();
  assert.equal(
    reopened.entries.filter(
      (entry) => entry.diagnosticId === receipt.diagnosticId,
    ).length,
    1,
  );
});

test("renderer report receipts remain available from memory after a real host storage failure", async (t) => {
  const module = await desktopModule();
  const sink = createHostDiagnostics({
    dataDir: await createTempDir(t),
    runtime: { hostRole: "main" },
    fsAdapter: {
      ...fs,
      mkdir: async () => {
        throw Object.assign(Error("private directory"), { code: "EACCES" });
      },
    },
  });
  const handlers = new Map(),
    frame = { url: "http://127.0.0.1:3000/" },
    webContents = { mainFrame: frame };
  module.registerDiagnosticIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    diagnostics: sink,
    getWindow: () => ({ webContents }),
    getOrigin: () => frame.url,
  });
  const receipt = await handlers.get("diagnostics:report")(
    { sender: webContents, senderFrame: frame },
    { operation: "renderer.failure", code: "renderer_error" },
  );
  const result = await sink.list();
  assert.deepEqual(receipt, { diagnosticId: result.entries[0].diagnosticId });
  assert.equal(result.storage.mode, "memory");
  assert.equal(result.storage.failureCode, "EACCES");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

for (const failure of ["throws", "rejects", "missing_receipt"]) {
  test(`accepted renderer reports expose a safe failure when the host sink ${failure}`, async () => {
    const module = await desktopModule(),
      handlers = new Map(),
      frame = { url: "http://127.0.0.1:3000/" },
      webContents = { mainFrame: frame };
    const diagnostics = {
      record: () => {
        if (failure === "throws") throw Error("private exception and path");
        if (failure === "rejects")
          return Promise.reject(Error("private exception and path"));
        return undefined;
      },
    };
    module.registerDiagnosticIpc({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      diagnostics,
      getWindow: () => ({ webContents }),
      getOrigin: () => frame.url,
    });
    await assert.rejects(
      handlers.get("diagnostics:report")(
        { sender: webContents, senderFrame: frame },
        { operation: "renderer.failure", code: "renderer_error" },
      ),
      (error) => {
        assert.equal(error.code, "diagnostic_report_failed");
        assert.equal(String(error.message).includes("private"), false);
        return true;
      },
    );
  });
}
