import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
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
    onKey: () => {},
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
