import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcPeer } from "../../src/infrastructure/runtime/rpc.mjs";
import { desktopCapabilities } from "./protocol.mjs";
import { syntheticCapabilities } from "./synthetic-contract.mjs";
import { createCollectionBrowser } from "../collection/browser.mjs";
import { platformPolicy } from "../collection/network-policy.mjs";
import { createEgressProxy } from "../../src/infrastructure/collection/egress-proxy.mjs";
import { recordDiagnostic } from "../../src/infrastructure/diagnostics/log.mjs";
import { desktopShutdownReceipt } from "./shutdown.mjs";

const metadata = (value) =>
  Object.fromEntries(
    [
      "sessionRef",
      "platform",
      "state",
      "remembered",
      "riskBlocked",
      "code",
      "checkedAt",
      "bodyStatus",
      "status",
    ]
      .filter((key) => value?.[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
const scopeInput = (input) => ({
  scope: input.scope,
  sessionRef: input.sessionRef,
});

/** Native-only host. UtilityProcess is started by Electron after app readiness.
 * All business data and the HTTP server remain in that utility process. */
export function createDesktopBackend({
  utilityProcess,
  BrowserWindow,
  session,
  sessionStore,
  credentialService,
  diagnostics,
  dataDir,
  appRoot,
  resourcesRoot,
  packaged,
  selfTest = false,
  offlineGuard,
  runtime,
  onStage,
  onExit,
} = {}) {
  const child = utilityProcess.fork(
    fileURLToPath(new URL("./entry.cjs", import.meta.url)),
    [],
    {
      serviceName: "Resume Job Radar Backend",
      stdio: "pipe",
      cwd: packaged ? resourcesRoot || path.dirname(appRoot) : appRoot,
      env: {
        ...process.env,
        RJR_DESKTOP: "1",
        RJR_HOST_ROLE: "backend",
        RJR_DATA_DIR: dataDir,
        RJR_BACKEND_APP_ROOT: appRoot,
        RJR_BACKEND_RESOURCES_ROOT: resourcesRoot || "",
        RJR_BACKEND_PACKAGED: packaged ? "1" : "0",
        RJR_BACKEND_SELF_TEST: selfTest ? "1" : "0",
        RJR_DISABLE_LOCAL_CREDENTIALS: selfTest
          ? "1"
          : process.env.RJR_DISABLE_LOCAL_CREDENTIALS || "0",
        RJR_BUILD_ID: runtime?.buildId || "",
      },
    },
  );
  const lifetime = new AbortController();
  let peer,
    stopping = false,
    exited = false,
    closePromise,
    lastStage = { state: "starting", stage: "starting" };
  const nativeInput = (input, { signal }) => ({
    ...input,
    signal: AbortSignal.any([signal, lifetime.signal]),
  });
  const browser = createCollectionBrowser({
    BrowserWindow,
    session,
    sessionStore,
    diagnostics,
    offlineAllows: offlineGuard?.allows,
    egressProxy: createEgressProxy({ offlineAllows: offlineGuard?.allows }),
    ledger: Object.fromEntries(
      ["snapshot", "reserve", "reserveBatch", "settle", "settleBatch"].map(
        (name) => [name, (input) => peer.call("browser.ledger." + name, input)],
      ),
    ),
    assertScope: (scope) => peer.call("browser.scope.assert", { scope }),
    rememberSession: (input) => peer.call("browser.session.remember", input),
  });
  const browserRead = (method) => async (input, control) => {
    const value = await browser[method]({
      ...nativeInput(input, control),
      ...(input.platform
        ? { routePolicy: platformPolicy(input.platform) }
        : {}),
    });
    // HTML is duplicated as text by the local browser API; send one copy.
    if (value.html && value.text === value.html) {
      const { text, ...dto } = value;
      return dto;
    }
    return value;
  };
  peer = createRpcPeer({
    capabilities: selfTest
      ? { ...desktopCapabilities, ...syntheticCapabilities }
      : desktopCapabilities,
    send: (frame) => child.postMessage(frame),
    handlers: {
      "host.stage": async (value) => {
        lastStage = value;
        await onStage?.(value);
        return { accepted: true };
      },
      "host.credentials.saveModel": ({ apiKey }) =>
        apiKey
          ? credentialService.save("deepseek", apiKey)
          : credentialService.delete("deepseek"),
      "host.sessions.recover": async () =>
        (await sessionStore.resumePending()) ?? null,
      "host.sessions.get": async (input) =>
        metadata(await sessionStore.get(scopeInput(input))),
      "host.sessions.status": async (input) =>
        metadata(await sessionStore.getStatus(scopeInput(input))),
      "host.sessions.capabilities": () => ({
        available: true,
        canRemember: sessionStore.available() === true,
      }),
      "host.browser.configure": ({ dnsMode }) => browser.setDnsMode(dnsMode),
      "host.browser.openLogin": async (input, control) =>
        metadata(await browser.openLogin(nativeInput(input, control))),
      "host.browser.read": browserRead("read"),
      "host.browser.readBoss": browserRead("readBoss"),
      "host.browser.verifySession": async (input, control) =>
        metadata(await browser.verifySession(nativeInput(input, control))),
      "host.browser.recoverBossSession": async (input, control) =>
        (await browser.recoverBossSession(nativeInput(input, control))) ?? null,
      "host.browser.clearSession": (input) => browser.clearSession(input),
      "host.browser.closePackage": ({ packageId }) =>
        browser.closePackage(packageId),
      "host.browser.stop": async () => {
        await browser.stop();
        return { stopped: true };
      },
    },
  });
  child.on("message", (frame) => peer.receive(frame));
  // Never forward child stdout/stderr: exceptions may contain private content.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  child.once("exit", (exitCode) => {
    exited = true;
    // Synchronous revocation comes first, before any RPC/settlement await.
    const error = Object.assign(Error("后台已停止。"), {
      code: "backend_exited",
    });
    lifetime.abort(error);
    browser.revokeBackend(error);
    peer.close("backend_exited");
    if (!stopping) void onExit?.({ code: "backend_exited", exitCode });
  });
  return {
    call: (method, input, options) => peer.call(method, input, options),
    start: (modelKey = "") =>
      peer.call("backend.start", { modelKey }, { timeoutMs: 300000 }),
    close() {
      return (closePromise ||= (async () => {
        stopping = true;
        let receipt = desktopShutdownReceipt(["application"]);
        try {
          if (!exited)
            receipt = await peer.call(
              "backend.shutdown",
              {},
              { timeoutMs: 30000 },
            );
        } finally {
          lifetime.abort();
          browser.revokeBackend();
          peer.close();
          try {
            await browser.stop();
          } catch {
            receipt = desktopShutdownReceipt([
              ...receipt.failedResources,
              "browser",
            ]);
          }
          if (!exited) child.kill();
          await recordDiagnostic(diagnostics, {
            operation: "application.shutdown",
            phase: "finished",
            hostRole: "main",
            outcome: receipt.cleanupComplete ? "success" : "partial",
            code: receipt.cleanupComplete
              ? "backend_stopped"
              : "backend_shutdown_incomplete",
            cleanupComplete: receipt.cleanupComplete,
            failedResources: receipt.failedResources,
          });
        }
        return receipt;
      })());
    },
    snapshot: () => ({
      ...peer.snapshot(),
      state: lastStage.state,
      exited,
      browser: browser.snapshot(),
    }),
    // Test drivers can terminate this same production utility path. There is no
    // inline context fallback or arbitrary executable test command.
    terminate: () => child.kill(),
  };
}
