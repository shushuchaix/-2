import path from "node:path";
import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRpcPeer } from "../../src/infrastructure/runtime/rpc.mjs";
import { desktopCapabilities } from "./protocol.mjs";
import { syntheticCapabilities } from "./synthetic-contract.mjs";
import { createBackendBrowserAdapter } from "./browser-adapter.mjs";
import { createBrowserCapabilities } from "./browser-capabilities.mjs";
import { createCollectionCommands } from "./collection-commands.mjs";
import { recordDiagnostic } from "../../src/infrastructure/diagnostics/log.mjs";
import { createHostDiagnostics as createDiagnosticsLog } from "../../src/infrastructure/diagnostics/host-log.mjs";
import { installClosedPipeGuard } from "../process-output.mjs";
import { createRuntimePerformance } from "../../src/infrastructure/runtime/performance.mjs";
import { desktopShutdownReceipt, stopDesktopHttp } from "./shutdown.mjs";

// This capability is reached only from an explicit native save/delete IPC.
// Startup injection uses backend.start and never confirms a missing binding.
export function createModelCredentialHandler({requireContext}) {
  return async ({key})=>(await requireContext()).commitModelCredential(key);
}

export function startUtilityBackend(parentPort) {
  if (
    !parentPort ||
    !process.env.RJR_DATA_DIR ||
    process.env.RJR_DESKTOP !== "1"
  )
    throw Error("backend_environment_invalid");
  installClosedPipeGuard();
  const runtimePerformance = createRuntimePerformance();
  const dataDir = process.env.RJR_DATA_DIR,
    appRoot = process.env.RJR_BACKEND_APP_ROOT;
  const selfTest = process.env.RJR_BACKEND_SELF_TEST === "1",
    packaged = process.env.RJR_BACKEND_PACKAGED === "1";
  const capabilities = selfTest
    ? { ...desktopCapabilities, ...syntheticCapabilities }
    : desktopCapabilities;
  let peer,
    cfg,
    context,
    server,
    ready,
    startPromise,
    closePromise,
    fixtures,
    network,
    shuttingDown = false;
  const diagnostics = createDiagnosticsLog({
    dataDir,
    runtime: {
      buildId: process.env.RJR_BUILD_ID,
      hostRole: "backend",
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
    },
  });
  const handlers = {};
  const callerCancellation = new AsyncLocalStorage();
  let state = { state: "starting", stage: "starting" };
  const stage = async (value) => {
    state = { ...state, ...value };
    await peer.call("host.stage", state).catch(() => {});
  };
  const requireContext = async () => {
    if (!ready)
      throw Object.assign(Error("后台正在准备。"), {
        code: "backend_starting",
      });
    await ready;
    if (!context)
      throw Object.assign(Error("后台恢复未完成。"), {
        code: "application_start_failed",
      });
    return context;
  };
  const browser = createBackendBrowserAdapter(
    { call: (...args) => peer.call(...args) },
    { getCallSignal: () => callerCancellation.getStore() },
  );
  Object.assign(handlers, {
    "backend.start": ({ modelKey }) =>
      (startPromise ||= (async () => {
        await stage({ state: "starting", stage: "configuration" });
        // Configuration is deliberately imported after the native host set the
        // data directory in the child environment, never in Electron main.
        if (selfTest) {
          network = (
            await import("../self-test-network.mjs")
          ).installSelfTestNetworkGuard();
          fixtures = (
            await import("./synthetic.mjs")
          ).createBackendSyntheticEnvironment({ dataDir });
          cfg = fixtures.cfg;
          await fs.writeFile(
            path.join(dataDir, "config.json"),
            JSON.stringify(cfg),
          );
        } else {
          const configuration = await import("../../src/config.mjs");
          configuration.ensureDataDirs();
          cfg = configuration.loadConfig({ quiet: true });
        }
        cfg.server = {
          ...cfg.server,
          host: "127.0.0.1",
          port: 0,
          trustProxy: false,
        };
        if (!process.env.AUTH_PASSWORD && !cfg.auth.passwordHash)
          cfg.auth.mode = "none";
        if (modelKey) cfg.deepseek.apiKey = modelKey;
        await peer.call("host.browser.configure", {
          dnsMode: ["auto", "system", "doh"].includes(cfg.network?.dnsMode)
            ? cfg.network.dnsMode
            : "auto",
        });
        const dependencies = {
          ...(fixtures?.dependencies || {}),
          diagnostics,
          collectionBrowser: browser,
          onStartupStage: (value) =>
            stage({
              state: "starting",
              stage:
                typeof value === "string" ? value : value.stage || "recovery",
            }),
          recoverOwnedResources: () => peer.call("host.sessions.recover"),
          cleanupOwnedResources: (packageId) => browser.closePackage(packageId),
          stopOwnedResources: () => browser.stop(),
          saveModelCredential: ({ apiKey }) =>
            peer.call("host.credentials.saveModel", { apiKey }),
          ...(selfTest
            ? { collectionRuntime: { verified: false, capabilities: {} } }
            : {
                collectionRuntimeRoot: packaged
                  ? path.join(
                      process.env.RJR_BACKEND_RESOURCES_ROOT,
                      "collection-runtime",
                    )
                  : path.join(appRoot, ".cache/collection-runtime-dev"),
              }),
        };
        if (packaged)
          dependencies.ocr = (
            await import("../../src/attachments/ocr.mjs")
          ).createLocalOcr({
            resourceDir: path.join(
              process.env.RJR_BACKEND_RESOURCES_ROOT,
              "ocr",
            ),
          });
        if (shuttingDown)
          throw Object.assign(Error("后台正在关闭。"), {
            code: "backend_stopping",
          });
        const created = (await import("../../src/server.mjs")).createServer(
          cfg,
          { dataDir, dependencies },
        );
        server = created.server;
        ready = created.ready.then((value) => {
          context = value;
          const capabilities = createBrowserCapabilities(context);
          Object.assign(handlers, capabilities.handlers);
          const sessions = {
            get: (input) => peer.call("host.sessions.get", input),
            getStatus: (input) => peer.call("host.sessions.status", input),
            available: () => false,
          };
          const commands = createCollectionCommands({
            context,
            browser,
            sessionStore: sessions,
            forgetSession: capabilities.forget,
          });
          for (const [method, action] of Object.entries(commands))
            handlers[method] = (input, control) => {
              if (shuttingDown)
                throw Object.assign(Error("后台正在关闭。"), {
                  code: "backend_stopping",
                });
              return callerCancellation.run(control.signal, () =>
                action(input),
              );
            };
          context.contentReadService?.setBrowser(browser);
          fixtures?.attach?.({ context, handlers, network });
          return value;
        });
        // Listening and static rendering do not grant business access: createServer
        // retains its existing await-ready/maintenance gate for every business API.
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const origin = "http://127.0.0.1:" + server.address().port;
        network?.setAllowedOrigin(origin);
        await stage({ state: "listening", stage: "recovery", origin });
        try {
          await ready;
          const capabilities = await peer.call("host.sessions.capabilities");
          handlers["collection.capabilities"] = async () => capabilities;
          await stage({ state: "ready", stage: "ready", origin });
        } catch (error) {
          const entry = await recordDiagnostic(
            diagnostics,
            {
              operation: "desktop.failure",
              phase: "load",
              stage: "startup",
              code: "backend_start_failed",
              hostRole: "backend",
              outcome: "failed",
            },
            error,
          );
          await stage({
            state: "maintenance",
            stage: "recovery",
            origin,
            code: "backend_start_failed",
            ...(entry?.diagnosticId
              ? { diagnosticId: entry.diagnosticId }
              : {}),
          });
          if (selfTest) throw error;
        }
        return state;
      })()),
    "backend.status": async () => ({
      ...state,
      hostRole: "backend",
      buildId: process.env.RJR_BUILD_ID || null,
      performance: runtimePerformance.snapshot(),
      repository: context?.repository.metrics?.() || null,
      network: network?.report?.() || null,
    }),
    "backend.modelKey": createModelCredentialHandler({requireContext}),
    "backend.shutdown": () =>
      (closePromise ||= (async () => {
        shuttingDown = true;
        const failedResources = [];
        // Stop HTTP admission before collection/run drain can begin. Existing
        // transport connections are closed now; RPC status/shutdown remain live.
        let httpClosed = Promise.resolve();
        try {
          httpClosed = stopDesktopHttp(server).catch(() => {
            failedResources.push("server");
          });
        } catch {
          failedResources.push("server");
        }
        try {
          if (!context && ready) await ready;
          const result = await context?.close?.();
          failedResources.push(...(result?.failedResources || []));
        } catch {
          failedResources.push("application");
        }
        try {
          await httpClosed;
        } catch {
          failedResources.push("server");
        } finally {
          network?.dispose();
          runtimePerformance.close();
        }
        const receipt = desktopShutdownReceipt(failedResources);
        await recordDiagnostic(diagnostics, {
          operation: "application.shutdown",
          phase: "finished",
          hostRole: "backend",
          outcome: receipt.cleanupComplete ? "success" : "partial",
          code: receipt.cleanupComplete
            ? "backend_stopped"
            : "backend_shutdown_incomplete",
          cleanupComplete: receipt.cleanupComplete,
          failedResources: receipt.failedResources,
        });
        return receipt;
      })()),
  });
  // Dispatch wrappers await readiness but never serialize other incoming RPC.
  for (const method of Object.keys(capabilities)) {
    if (method.startsWith("host.") || handlers[method]) continue;
    handlers[method] = async (input, control) => {
      await requireContext();
      const handler = handlers[method];
      if (handler === wrapper)
        throw Object.assign(Error("后台能力不可用。"), {
          code: "backend_capability_unavailable",
        });
      return (await handler(input, control)) ?? null;
    };
    const wrapper = handlers[method];
  }
  peer = createRpcPeer({
    capabilities,
    handlers,
    send: (frame) => parentPort.postMessage(frame),
  });
  parentPort.on("message", (event) => peer.receive(event.data));
  process.on("uncaughtExceptionMonitor", (error) => {
    try {
      diagnostics.recordFatal(
        {
          operation: "desktop.failure",
          hostRole: "backend",
          code: "backend_uncaught",
          phase: "finished",
          outcome: "failed",
        },
        error,
      );
    } catch {}
  });
  return peer;
}
