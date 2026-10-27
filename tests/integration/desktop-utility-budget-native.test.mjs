import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const evidenceRoot = path.join(root, ".cache/phase2-native-joint");
const fixtureUrl = "https://m.weibo.cn/detail/123";
const allBoundaries = ["after-reserve", "before-response", "before-settle"];
const selectedBoundary = process.env.RJR_NATIVE_UTILITY_BUDGET_BOUNDARY;
if (selectedBoundary && !allBoundaries.includes(selectedBoundary))
  throw Error("native_boundary_invalid");
const boundaries = selectedBoundary ? [selectedBoundary] : allBoundaries;
const sourceFiles = [
  "electron/backend/entry.cjs",
  "electron/backend/host.mjs",
  "electron/backend/service.mjs",
  "electron/backend/protocol.mjs",
  "electron/backend/browser-adapter.mjs",
  "electron/backend/browser-capabilities.mjs",
  "electron/backend/collection-commands.mjs",
  "electron/backend/synthetic.mjs",
  "electron/backend/synthetic-contract.mjs",
  "electron/backend/synthetic-environment.mjs",
  "electron/collection/browser.mjs",
  "electron/collection/window-budget.mjs",
  "electron/collection/network-policy.mjs",
  "electron/self-test-network.mjs",
  "src/application/context.mjs",
  "src/application/collection-ledger.mjs",
  "src/application/collection-row-ledger.mjs",
  "src/application/collection-row-service.mjs",
  "src/application/collection-row-access.mjs",
  "src/infrastructure/runtime/rpc.mjs",
  "src/infrastructure/collection/egress-proxy.mjs",
  "src/infrastructure/storage/repository.mjs",
  "src/infrastructure/storage/sqlite-store.mjs",
  "src/infrastructure/storage/sqlite-records.mjs",
  "src/infrastructure/storage/sqlite-schema.mjs",
  "src/infrastructure/storage/sqlite-migration.mjs",
  "src/infrastructure/storage/sqlite-job-queries.mjs",
  "src/infrastructure/storage/sqlite-collection-queries.mjs",
  "src/infrastructure/storage/read-model-maintenance.mjs",
  "src/infrastructure/storage/package-counts.mjs",
  "src/infrastructure/storage/package-control.mjs",
  "src/infrastructure/diagnostics/log.mjs",
  "src/infrastructure/diagnostics/coordination.mjs",
  "src/infrastructure/diagnostics/host-log.mjs",
  "tests/integration/desktop-utility-budget-native.test.mjs",
];
const hashes = () =>
  Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash("sha256")
        .update(fs.readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function bounded(promise, code, ms = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(Error(code), { code })),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// This opt-in gate starts an isolated real Electron main and formal utility.
// Its only browser transport is one existing fixed self-test URL, served by a
// native protocol handler through an independently counted localhost server.
if (!process.versions.electron)
  test(
    "native utility deaths preserve durable browser budgets and revoke the main capability",
    {
      skip:
        process.env.RJR_RUN_NATIVE_UTILITY_BUDGET !== "1" &&
        "requires explicit native Electron test run",
      timeout: 180000,
    },
    () => {
      const runRoot = path.join(evidenceRoot, "native-" + randomUUID());
      fs.mkdirSync(runRoot, { recursive: true });
      fs.writeFileSync(
        path.join(runRoot, "driver.cjs"),
        `import(${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}).then(m=>m.runDesktopUtilityBudgetNative()).catch(e=>{require('node:fs').writeFileSync(require('node:path').join(__dirname,'bootstrap-error.json'),JSON.stringify({name:e.name,code:e.code||null,message:e.message}));require('electron').app.exit(1);});\n`,
      );
      const environment = {
        ...process.env,
        RJR_DISABLE_LOCAL_CREDENTIALS: "1",
        RJR_NATIVE_UTILITY_BUDGET_RUN_ROOT: runRoot,
      };
      delete environment.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(
        path.join(root, "node_modules/electron/dist/electron.exe"),
        [path.join(runRoot, "driver.cjs")],
        {
          cwd: root,
          env: environment,
          encoding: "utf8",
          timeout: 150000,
          windowsHide: true,
        },
      );
      fs.writeFileSync(path.join(runRoot, "electron-stderr.txt"), result.stderr || "");
      fs.writeFileSync(
        path.join(runRoot, "process.json"),
        JSON.stringify(
          {
            node: process.versions.node,
            exitCode: result.status,
            signal: result.signal,
            errorCode: result.error?.code ?? null,
          },
          null,
          2,
        ),
      );
      const file = path.join(runRoot, "receipt.json");
      const receipt = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : null;
      fs.writeFileSync(
        path.join(evidenceRoot, "native-latest.json"),
        JSON.stringify({ runDirectory: path.basename(runRoot), processExitCode: result.status, receipt }, null, 2),
      );
      assert.equal(result.status, 0, `native gate: ${receipt?.status || "entry_blocked"}`);
      assert.equal(receipt?.status, "passed");
      assert.equal(receipt?.sourceHashesStableForWholeRun, true);
      assert.equal(receipt?.cases.length, boundaries.length);
      assert.deepEqual(receipt.cases.map((row) => row.transportCalls), boundaries.map((boundary) => boundary === "after-reserve" ? 0 : 1));
      assert.ok(receipt.cases.every((row) => row.status === "passed"));
      assert.equal(receipt.network.externalRequests, 0);
      assert.equal(receipt.network.blockedRequests, 0);
    },
  );

export async function runDesktopUtilityBudgetNative() {
  const { app, BrowserWindow, session, utilityProcess } = await import("electron");
  const { DatabaseSync } = await import("node:sqlite");
  const runRoot = path.resolve(process.env.RJR_NATIVE_UTILITY_BUDGET_RUN_ROOT || "");
  if (
    process.env.RJR_DISABLE_LOCAL_CREDENTIALS !== "1" ||
    path.dirname(runRoot) !== evidenceRoot ||
    !/^native-[a-f0-9-]+$/.test(path.basename(runRoot)) ||
    fs.lstatSync(runRoot).isSymbolicLink()
  ) {
    app.exit(1);
    return;
  }
  for (const directory of ["electron-profile", "electron-session"])
    fs.mkdirSync(path.join(runRoot, directory));
  app.setPath("userData", path.join(runRoot, "electron-profile"));
  app.setPath("sessionData", path.join(runRoot, "electron-session"));
  app.commandLine.appendSwitch("disable-background-networking");
  // The driver owns its lifetime even when the last hidden browser is revoked.
  app.on("window-all-closed", () => {});
  const receipt = {
    status: "running",
    scope: "formal createDesktopBackend -> real utilityProcess; synthetic data and fixed local browser transport only",
    runtime: { electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite, platform: process.platform },
    verificationScope: selectedBoundary ? "partial-single-boundary" : "all-three-boundaries",
    startedSourceHashes: hashes(),
    cases: [],
    network: null,
  };
  let guard, server, backend, step = "app-ready", current;
  const save = () => fs.writeFileSync(path.join(runRoot, "receipt.json"), JSON.stringify(receipt, null, 2));
  const check = (value, code) => {
    if (!value) throw Object.assign(Error(code), { code });
    current?.checks.push(code);
  };
  const readDurable = (dataDir, ref) => {
    let db, readPhase = "open";
    try {
      db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"), { readOnly: true });
      readPhase = "root-select";
      const row = db.prepare("SELECT value FROM rows WHERE collection='runs' AND id=?").get(ref.activityId);
      readPhase = "reservations-select";
      const reservations = db.prepare("SELECT value FROM rows WHERE collection='reservations' AND run_id=? ORDER BY id").all(ref.activityId).map((v) => JSON.parse(v.value));
      readPhase = "usage-select";
      const usage = db.prepare("SELECT value FROM rows WHERE collection='budgetUsage' AND id=?").get(ref.activityId);
      readPhase = "facts-select";
      const counts = Object.fromEntries(db.prepare("SELECT collection,count(*) AS total FROM rows WHERE owner_id=? AND collection IN ('jobs','observations','evaluations','conditionalCache','contentBodies','contentArticles','articleCache','contentLinks','officialLinkCache') GROUP BY collection ORDER BY collection").all(ref.scope.packageId).map((v) => [v.collection, v.total]));
      return { root: JSON.parse(row.value), usage: JSON.parse(usage.value), reservations, factCounts: counts };
    } catch (error) {
      if (error.code === "ERR_SQLITE_ERROR") error.sqliteReadPhase = readPhase;
      throw error;
    } finally {
      try { db?.close(); }
      catch (error) {
        if (error.code === "ERR_SQLITE_ERROR") error.sqliteReadPhase = "close";
        throw error;
      }
    }
  };
  try {
    await app.whenReady();
    const { prepareSelfTestDirectory } = await import("../../electron/self-test.mjs");
    const { installSelfTestNetworkGuard } = await import("../../electron/self-test-network.mjs");
    const { createDesktopBackend } = await import("../../electron/backend/host.mjs");
    guard = installSelfTestNetworkGuard();
    app.on("session-created", (value) => guard.attachSession(value));
    guard.attachSession(session.defaultSession);
    guard.allowSyntheticUrl(fixtureUrl);
    let localCase;
    server = http.createServer((req, res) => {
      if (req.url !== "/transport" || req.method !== "GET" || !localCase) {
        res.writeHead(404).end();
        return;
      }
      const activeCase = localCase;
      activeCase.transportCalls++;
      activeCase.transportActive++;
      req.once("aborted", () => activeCase.transportAborted++);
      res.once("close", () => activeCase.transportActive--);
      const respond = () => {
        if (!res.destroyed) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div class="weibo-text">Synthetic fire engineer vacancy. Fixed native budget lifecycle fixture.</div></body></html>');
          activeCase.transportReplies++;
        }
      };
      if (activeCase.boundary === "before-response") {
        activeCase.responseRelease = respond;
        activeCase.reached.resolve("before-response");
      } else respond();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const transportOrigin = "http://127.0.0.1:" + server.address().port;
    guard.setAllowedOrigin(transportOrigin);
    guard.allowSyntheticOrigin(transportOrigin);
    for (const boundary of boundaries) {
      step = boundary + ":prepare";
      current = {
        boundary,
        status: "running",
        checks: [],
        transportCalls: 0,
        protocolCalls: 0,
        transportActive: 0,
        transportReplies: 0,
        transportAborted: 0,
        protocolSettled: 0,
        authStateWrites: [],
        materialWrites: 0,
        boots: [],
        shutdown: [],
        frameCounts: { reserveRequests: 0, reserveCommits: 0, settleAttempts: 0, settleDelivered: 0, settleCommits: 0, cancelsToUtility: 0, cancelsFromUtility: 0 },
        lateFramesInjected: [],
        rpcFailures: [],
        reached: deferred(),
      };
      const c = current;
      // Promise controls stay in the driver; only serializable evidence is saved.
      const caseReceipt = { boundary, status: "running" };
      receipt.cases.push(caseReceipt);
      const caseRoot = path.join(runRoot, boundary);
      fs.mkdirSync(caseRoot);
      const isolated = prepareSelfTestDirectory({ tempRoot: caseRoot });
      let origin, scope, entry, currentTap;
      const nativeWindows = [], partitions = new Set();
      const safeSession = {
        fromPartition(partition, input) {
          const ses = session.fromPartition(partition, input);
          if (!partitions.has(partition)) {
            partitions.add(partition);
            ses.protocol.handle("https", async (request) => {
              check(request.url === fixtureUrl, "protocol_fixed_url_only");
              c.protocolCalls++;
              try {
                const response = await fetch(transportOrigin + "/transport", { signal: request.signal });
                const body = await response.arrayBuffer();
                return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
              } finally {
                c.protocolSettled++;
              }
            });
          }
          return ses;
        },
      };
      class HiddenWindow extends BrowserWindow {
        constructor(options) {
          super({ ...options, show: false });
          nativeWindows.push(this);
        }
      }
      const store = {
        resumePending: async () => ({ completed: true }),
        available: () => false,
        get: async (input) => {
          check(input.sessionRef === entry?.sessionRef && input.scope.packageId === scope?.packageId && input.scope.targetRevisionId === scope?.targetRevisionId, "synthetic_session_exact_scope");
          return { ...entry };
        },
        getStatus: async () => ({ sessionRef: entry.sessionRef, platform: "weibo", state: "unverified", remembered: false, riskBlocked: false }),
        readMaterial: async () => ({ cookies: [] }),
        saveMaterial: async ({ cookies }) => {
          check(cookies.length === 0, "no_login_material_created");
          c.materialWrites++;
        },
        setState: async ({ state }) => { c.authStateWrites.push(state); },
      };
      const tapUtility = {
        fork(...args) {
          const child = utilityProcess.fork(...args);
          const tap = new EventEmitter();
          const requests = new Map();
          Object.assign(tap, { stdout: child.stdout, stderr: child.stderr, pid: child.pid, nativeChild: child, held: [], exited: deferred() });
          tap.postMessage = (frame) => {
            if (frame.type === "cancel") c.frameCounts.cancelsToUtility++;
            if (frame.type === "request") {
              requests.set(frame.requestId, frame);
              if (frame.method === "browser.ledger.reserveBatch") {
                c.frameCounts.reserveRequests++;
                c.reserveInput = structuredClone(frame.input);
              }
              if (frame.method === "browser.ledger.settleBatch") {
                c.frameCounts.settleAttempts++;
                c.settleInput = structuredClone(frame.input);
                if (boundary === "before-settle" && c.boots.length === 1 && !tap.didGate) {
                  tap.didGate = true;
                  tap.held.push(frame);
                  c.reached.resolve("before-settle");
                  return;
                }
                c.frameCounts.settleDelivered++;
              }
            }
            child.postMessage(frame);
          };
          tap.kill = () => child.kill();
          child.on("message", (frame) => {
            if (frame.type === "cancel") c.frameCounts.cancelsFromUtility++;
            if (frame.type === "request" && frame.method === "host.browser.verifySession") c.browserRequest = structuredClone(frame);
            if (frame.type === "response") {
              const request = requests.get(frame.requestId);
              if (request && frame.ok === false) c.rpcFailures.push({ method: request.method, code: frame.error?.code || "unknown_rpc_error" });
              if (request?.method === "browser.ledger.reserveBatch" && frame.ok === true) {
                c.frameCounts.reserveCommits++;
                c.reserveResult = structuredClone(frame.result);
                if (boundary === "after-reserve" && c.boots.length === 1 && !tap.didGate) {
                  tap.didGate = true;
                  tap.held.push(frame);
                  c.reached.resolve("after-reserve");
                  return;
                }
              }
              if (request?.method === "browser.ledger.settleBatch" && frame.ok === true) c.frameCounts.settleCommits++;
            }
            tap.emit("message", frame);
          });
          child.once("exit", (exitCode) => {
            tap.exitedAt = performance.now();
            tap.emit("exit", exitCode);
            // Production exit listeners have synchronously returned here.
            tap.exitSnapshot = backend?.snapshot();
            tap.windowsDestroyedAtExit = nativeWindows.every((window) => window.isDestroyed());
            tap.exited.resolve(exitCode);
          });
          currentTap = tap;
          return tap;
        },
      };
      const api = async (route, body, method = body === undefined ? "GET" : "POST", scoped = true) => {
        const url = new URL(origin + "/api/v2" + route);
        if (scoped && scope) for (const [key, value] of Object.entries(scope)) url.searchParams.set(key, value);
        const response = await fetch(url, {
          method,
          headers: { "content-type": "application/json", origin },
          ...(body === undefined ? {} : { body: JSON.stringify({ ...body, ...(scoped ? scope : {}) }) }),
        });
        const value = await response.json();
        if (!response.ok) throw Object.assign(Error("native_http_failed"), { code: value.code || "native_http_failed", status: response.status });
        return value;
      };
      const boot = async () => {
        const bootReceipt = { before: hashes(), network: null };
        c.boots.push(bootReceipt);
        backend = createDesktopBackend({
          utilityProcess: tapUtility,
          BrowserWindow: HiddenWindow,
          session: safeSession,
          sessionStore: store,
          credentialService: { save: async () => { throw Error("credential_forbidden"); }, delete: async () => { throw Error("credential_forbidden"); } },
          dataDir: isolated.dataDir,
          appRoot: root,
          packaged: false,
          selfTest: true,
          offlineGuard: guard,
          onStage(value) {
            if (value.origin) { origin = value.origin; guard.setAllowedOrigin(origin); }
          },
        });
        const state = await bounded(backend.start(), "utility_start_timeout", 30000);
        check(state.state === "ready", "formal_utility_ready");
        bootReceipt.utilityPid = currentTap.nativeChild.pid;
        bootReceipt.afterReady = hashes();
        bootReceipt.network = (await backend.call("backend.status", {})).network;
        check(JSON.stringify(bootReceipt.before) === JSON.stringify(bootReceipt.afterReady), "source_hashes_stable_during_boot");
        return currentTap;
      };
      const staleReject = async (method, input) => {
        let code;
        try { await backend.call(method, input); } catch (error) { code = error.code; }
        (c.staleReplayCodes ||= {})[method] = code ?? "unexpected_success";
        check(["invalid_operation_lease", "collection_stale_epoch"].includes(code), "stale_" + method.split(".").at(-1) + "_rejected");
        return code;
      };
      try {
        const tap = await boot();
        const profile = await api("/profiles", {
          versionName: "合成生命周期简历", submissionId: "native-joint-profile", text: "合成简历：本科消防工程专业，2027届毕业，机场消防和应急管理合成课程项目。",
          profile: { education: "本科", major: "消防工程", graduationYear: 2027, skills: [], certificates: [] },
        }, "POST", false);
        const target = await api("/targets", {
          versionName: "合成生命周期目标", submissionId: "native-joint-target", profileRevisionId: profile.revisionId, enabled: true,
          roles: ["消防工程"], cityMode: "any", cities: [], jobTypes: ["campus"], degreePolicy: "eligibility",
          sourceIds: ["synthetic-desktop"], siteIds: [], coverageMode: "standard", budgets: { maxRequests: 2, maxCostCny: 0 },
        }, "POST", false);
        scope = { packageId: target.packageId, targetRevisionId: target.revisionId };
        entry = { sessionRef: "synthetic-native-budget", platform: "weibo", partition: "native-budget-" + randomUUID(), packageId: scope.packageId, targetRevisionId: scope.targetRevisionId, state: "unverified", remember: false };
        await backend.call("synthetic.controls", { hold: true });
        const started = await api("/collections", { mode: "rules", requestId: "native-budget-start" });
        const ref = { scope, activityId: started.activityId };
        c.ref = ref;
        check(Boolean(ref.activityId), "collection_has_durable_identity");
        localCase = c;
        step = boundary + ":verify";
        await bounded((async () => {
          for (;;) {
            const activity = await api("/collections/" + ref.activityId);
            if (activity.collectionProgress.activeSourceId === "synthetic-desktop") {
              c.collectionBeforeVerify = activity.collectionProgress;
              return;
            }
            await delay(10);
          }
        })(), "synthetic_provider_not_entered", 5000);
        const operation = backend.call("collection.verify", { ...ref, sessionRef: entry.sessionRef, testUrl: fixtureUrl }, { timeoutMs: 20000 }).then(
          (result) => (c.operation = { completed: true, result }),
          (error) => (c.operation = { completed: false, code: error.code }),
        );
        await bounded(Promise.race([
          c.reached.promise,
          operation.then((result) => { throw Object.assign(Error("operation_completed_before_boundary"), { code: result.code || "operation_completed_before_boundary" }); }),
        ]), "boundary_not_reached", 12000);
        c.beforeDeath = readDurable(isolated.dataDir, ref);
        c.budgetWhileReverseWaiting = await bounded(backend.call("browser.ledger.snapshot", ref), "reverse_rpc_deadlock", 2000);
        c.beforeDeathMain = backend.snapshot();
        check(c.frameCounts.reserveCommits === 1, "one_batch_committed_before_transport");
        check(c.beforeDeath.reservations.length === 3 && c.beforeDeath.reservations.every((row) => row.status === "reserved"), "actual_sql_contains_three_reserved_rows");
        check(c.budgetWhileReverseWaiting.usedRequests === 2, "full_two_request_upper_bound_charged");
        check(c.budgetWhileReverseWaiting.usedBytes === 20971520, "original_window_byte_upper_bound_charged");
        check(c.budgetWhileReverseWaiting.knownPhysicalRequests === 0, "no_settlement_claimed_before_boundary");
        check(c.transportCalls === (boundary === "after-reserve" ? 0 : 1), "expected_actual_local_transport_calls");
        check(c.frameCounts.settleDelivered === 0 && c.frameCounts.settleCommits === 0, "no_settlement_committed_before_kill");
        c.backendNetworkBeforeDeath = (await backend.call("backend.status", {})).network;
        c.frameCountsAtBoundary = structuredClone(c.frameCounts);
        c.sessionWritesAtBoundary = { material: c.materialWrites, states: c.authStateWrites.length };
        c.transportAtBoundary = { calls: c.transportCalls, active: c.transportActive, replies: c.transportReplies, aborted: c.transportAborted, protocolCalls: c.protocolCalls, protocolSettled: c.protocolSettled };
        check(c.transportReplies === (boundary === "before-settle" ? 1 : 0), "kill_is_before_response_or_before_settlement_as_requested");
        step = boundary + ":kill";
        c.beforeTerminationMain = backend.snapshot();
        c.killAccepted = backend.terminate();
        c.exitCode = await bounded(tap.exited.promise, "utility_did_not_exit", 5000);
        c.atExit = tap.exitSnapshot;
        check(c.atExit.exited && c.atExit.closed && c.atExit.pending === 0 && c.atExit.incoming === 0, "native_exit_synchronously_closed_all_rpc");
        check(tap.windowsDestroyedAtExit, "native_exit_synchronously_destroyed_all_browser_windows");
        c.operation = await bounded(operation, "main_operation_did_not_reject", 2000);
        check(c.operation.completed === false && c.operation.code === "backend_exited", "waiting_caller_rejected_on_real_process_exit");
        // Feed the held old envelopes and original browser request into the
        // closed host receiver. Actual stale ledger requests are separately
        // replayed through the new real utility after restart below.
        for (const frame of tap.held) {
          c.lateFramesInjected.push({ type: frame.type, method: frame.method || "browser.ledger.reserveBatch.response", destination: "closed-main-peer" });
          tap.emit("message", frame);
        }
        if (c.browserRequest) {
          c.lateFramesInjected.push({ type: c.browserRequest.type, method: c.browserRequest.method, destination: "closed-main-peer" });
          tap.emit("message", c.browserRequest);
        }
        c.responseRelease?.();
        await bounded((async () => {
          while (backend.snapshot().browser.activeReads || c.transportActive || c.protocolCalls !== c.protocolSettled) await delay(10);
        })(), "physical_or_browser_drain_timeout", 5000);
        c.afterDrain = backend.snapshot();
        c.frameCountsAfterLateRelease = structuredClone(c.frameCounts);
        c.nativeWindowsAfterDrain = { created: nativeWindows.length, alive: nativeWindows.filter((window) => !window.isDestroyed()).length };
        c.sessionWritesAfterLateRelease = { material: c.materialWrites, states: c.authStateWrites.length };
        c.transportAfterLateRelease = { calls: c.transportCalls, active: c.transportActive, replies: c.transportReplies, aborted: c.transportAborted, protocolCalls: c.protocolCalls, protocolSettled: c.protocolSettled };
        c.rpcExitRevocation = { pendingAtTermination: c.beforeTerminationMain.pending, incomingAtTermination: c.beforeTerminationMain.incoming, waitingCallerRejectCode: c.operation.code, pendingAfter: c.afterDrain.pending, incomingAfter: c.afterDrain.incoming };
        step = boundary + ":post-exit-read";
        c.postExitReadDelayMs = performance.now() - tap.exitedAt;
        c.postExitReadAttempts = [];
        // Read-only evidence sampling only, after the actual utility exit.
        // SQLite defines 1546 as SQLITE_IOERR_TRUNCATE:
        // https://sqlite.org/rescode.html#ioerr_truncate
        // Preserve each exact failure. No other error is retried, and no
        // backend restart, request, settlement, or writable repair occurs here.
        const samplingDelays = [0, 25, 50, 100];
        for (let attempt = 0; attempt < samplingDelays.length; attempt++) {
          if (samplingDelays[attempt]) await delay(samplingDelays[attempt]);
          const samplingStartedAt = performance.now();
          try {
            c.afterDeath = readDurable(isolated.dataDir, ref);
            c.postExitReadAttempts.push({ attempt, scheduledDelayMs: samplingDelays[attempt], elapsedFromExitMs: performance.now() - tap.exitedAt, readDurationMs: performance.now() - samplingStartedAt, status: "passed" });
            break;
          } catch (error) {
            c.postExitReadAttempts.push({ attempt, scheduledDelayMs: samplingDelays[attempt], elapsedFromExitMs: performance.now() - tap.exitedAt, readDurationMs: performance.now() - samplingStartedAt, status: "failed", code: error.code ?? null, errcode: error.errcode ?? null, errstr: error.errstr ?? null, readPhase: error.sqliteReadPhase ?? null });
            if (error.code !== "ERR_SQLITE_ERROR" || error.errcode !== 1546 || attempt === samplingDelays.length - 1) throw error;
          }
        }
        check(c.afterDrain.pending === 0 && c.afterDrain.incoming === 0 && c.afterDrain.browser.windows === 0, "dead_peer_late_frames_cannot_reopen_browser");
        check(c.authStateWrites.length === 0, "late_response_cannot_authenticate_session");
        check(c.materialWrites === c.sessionWritesAtBoundary.material, "backend_exit_does_not_write_late_session_material");
        check(JSON.stringify(c.afterDeath) === JSON.stringify(c.beforeDeath), "late_response_did_not_change_durable_business_or_budget_rows");
        const crashClose = await bounded(backend.close(), "main_crash_close_timeout", 5000);
        c.shutdown.push(crashClose);
        check(crashClose.cleanupComplete === false && crashClose.failedResources.includes("application"), "forced_death_reports_incomplete_backend_cleanup");
        backend = null;
        step = boundary + ":restart";
        await boot();
        c.afterRestart = readDurable(isolated.dataDir, ref);
        const recovered = await api("/collections/" + ref.activityId);
        c.recoveredUsage = await backend.call("browser.ledger.snapshot", ref);
        check(c.afterRestart.reservations.length === 3 && c.afterRestart.reservations.every((row) => row.status === "uncertain" && !row.verifiedUsage), "restart_preserves_all_unknown_reservations_as_uncertain");
        check(c.recoveredUsage.usedRequests === 2 && c.recoveredUsage.usedBytes === 20971520 && c.recoveredUsage.knownPhysicalRequests === 0, "restart_does_not_refund_unconfirmed_request_or_byte_upper_bound");
        check(recovered.collectionProgress.status === "paused" && recovered.collectionProgress.activeSliceRunId === null && recovered.collectionProgress.epoch > c.reserveInput.token.epoch, "restart_retires_old_epoch_and_pauses_without_replay");
        const beforeReplay = readDurable(isolated.dataDir, ref);
        c.staleReserveCode = await staleReject("browser.ledger.reserveBatch", c.reserveInput);
        c.staleSettleCode = await staleReject("browser.ledger.settleBatch", c.settleInput || {
          ref, token: c.reserveInput.token, operationLease: c.reserveInput.operationLease, draining: true,
          settlements: c.reserveInput.reservations.map((row) => ({ reservationId: row.reservationId, verifiedUsage: { requests: 0, bytes: 0 } })),
        });
        let verifyCode;
        try { await backend.call("collection.verify", { ...ref, sessionRef: entry.sessionRef, testUrl: fixtureUrl }); } catch (error) { verifyCode = error.code; }
        check(verifyCode === "collection_probe_unavailable", "replayed_browser_request_has_no_live_activity_authority");
        await delay(50);
        check(JSON.stringify(readDurable(isolated.dataDir, ref)) === JSON.stringify(beforeReplay), "old_epoch_replay_has_no_durable_effect");
        check(c.transportCalls === (boundary === "after-reserve" ? 0 : 1) && c.authStateWrites.length === 0, "restart_and_old_request_replay_do_not_duplicate_transport_or_authenticate");
        check(Object.values(c.afterRestart.factCounts).every((value) => value === 0), "no_late_job_cache_or_evaluation_written");
        const status = await backend.call("backend.status", {});
        c.boots.at(-1).network = status.network;
        const shutdown = await bounded(backend.close(), "restarted_backend_close_timeout", 10000);
        c.shutdown.push(shutdown);
        c.restartedUtilityExitCode = await bounded(currentTap.exited.promise, "restarted_utility_did_not_exit", 5000);
        check(shutdown.cleanupComplete === true && shutdown.failedResources.length === 0, "restarted_utility_graceful_cleanup_complete");
        check(backend.snapshot().pending === 0 && backend.snapshot().incoming === 0 && backend.snapshot().browser.activeReads === 0, "final_real_rpc_and_browser_pending_zero");
        backend = null;
        c.status = "passed";
      } catch (error) {
        c.status = "failed";
        c.failedStep = step;
        c.errorCode = /^[A-Za-z0-9_.:-]{1,100}$/.test(error.code || "") ? error.code : "native_assertion_failed";
        if (error.code === "ERR_SQLITE_ERROR") c.sqliteError = { code: error.code, errcode: error.errcode ?? null, errstr: error.errstr ?? null, phase: step, readPhase: error.sqliteReadPhase ?? null };
        // Every crash boundary has its own data directory and must report even
        // when an earlier independent case is red. Preserve the first failure.
        receipt.failedStep ||= c.failedStep;
        receipt.errorCode ||= c.errorCode;
      } finally {
        c.responseRelease?.();
        if (backend) {
          try { c.shutdown.push(await bounded(backend.close(), "finally_close_timeout", 6000)); }
          catch (error) { c.cleanupError = error.code || "cleanup_failed"; backend.terminate(); }
          backend = null;
        }
        localCase = null;
        const { reached, responseRelease, browserRequest, reserveInput, settleInput, reserveResult, ...serializable } = c;
        Object.assign(caseReceipt, serializable);
        caseReceipt.sourceHashesAfter = hashes();
        save();
      }
    }
    receipt.network = guard.report();
    check(receipt.network.externalRequests === 0 && receipt.network.blockedRequests === 0, "main_external_and_blocked_network_zero");
    check(receipt.cases.every((row) => row.boots.every((boot) => boot.network?.externalRequests === 0 && boot.network?.blockedRequests === 0) && row.backendNetworkBeforeDeath.externalRequests === 0 && row.backendNetworkBeforeDeath.blockedRequests === 0), "all_utility_network_zero");
    receipt.status = receipt.cases.every((row) => row.status === "passed") ? "passed" : "failed";
  } catch (error) {
    receipt.status = "failed";
    receipt.failedStep = step;
    receipt.errorCode = /^[A-Za-z0-9_.:-]{1,100}$/.test(error.code || "") ? error.code : "native_assertion_failed";
  } finally {
    receipt.network = guard?.report() || null;
    receipt.endedSourceHashes = hashes();
    receipt.sourceHashesStableForWholeRun = JSON.stringify(receipt.startedSourceHashes) === JSON.stringify(receipt.endedSourceHashes) && receipt.cases.every((row) => JSON.stringify(row.sourceHashesAfter) === JSON.stringify(receipt.startedSourceHashes) && row.boots.every((boot) => JSON.stringify(boot.before) === JSON.stringify(receipt.startedSourceHashes) && JSON.stringify(boot.afterReady) === JSON.stringify(receipt.startedSourceHashes)));
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
    guard?.dispose();
    save();
    app.exit(receipt.status === "passed" ? 0 : 1);
  }
}
