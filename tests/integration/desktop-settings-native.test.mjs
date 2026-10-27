import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const evidenceRoot = path.join(root, ".cache/phase2-desktop-settings");

// Opt in because this starts real Electron main/renderer/utility processes and
// the operating system encryption provider. Ordinary offline Node gates retain
// a visible skip, rather than silently substituting fake IPC or fake crypto.
if (!process.versions.electron)
  test(
    "native desktop credential IPC persists the backend binding across utility restarts",
    {
      skip:
        process.env.RJR_RUN_NATIVE_DESKTOP_SETTINGS !== "1" &&
        "requires explicit native Electron test run",
      timeout: 180000,
    },
    () => {
      const runRoot = path.join(evidenceRoot, "native-" + randomUUID());
      fs.mkdirSync(runRoot, { recursive: true });
      const driver = path.join(runRoot, "driver.cjs");
      const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
      fs.writeFileSync(
        driver,
        `import(${JSON.stringify(moduleUrl)}).then(m => m.runDesktopSettingsNative()).catch(e => {require('node:fs').writeFileSync(require('node:path').join(__dirname,'bootstrap-error.json'),JSON.stringify({name:e.name,code:e.code||null,message:e.message}));require('electron').app.exit(1);});\n`,
      );
      const environment = {
        ...process.env,
        RJR_DISABLE_LOCAL_CREDENTIALS: "1",
        RJR_NATIVE_DESKTOP_SETTINGS_RUN_ROOT: runRoot,
      };
      delete environment.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(
        path.join(root, "node_modules/electron/dist/electron.exe"),
        [driver],
        {
          cwd: root,
          env: environment,
          encoding: "utf8",
          timeout: 150000,
          windowsHide: true,
        },
      );
      fs.writeFileSync(
        path.join(runRoot, "electron-stderr.txt"),
        result.stderr || "",
      );
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
      const receiptFile = path.join(runRoot, "receipt.json");
      const receipt = fs.existsSync(receiptFile)
        ? JSON.parse(fs.readFileSync(receiptFile, "utf8"))
        : null;
      fs.writeFileSync(
        path.join(evidenceRoot, "native-latest.json"),
        JSON.stringify(
          {
            runDirectory: path.basename(runRoot),
            exitCode: result.status,
            errorCode: result.error?.code ?? null,
            receipt,
          },
          null,
          2,
        ),
      );
      assert.equal(
        result.status,
        0,
        `native Electron did not pass: ${receipt?.status ?? result.error?.code ?? "entry_blocked"}`,
      );
      assert.equal(receipt?.status, "passed");
      assert.equal(receipt?.nativeEncryption, true);
      assert.equal(receipt?.credentialWrites.save, 2);
      assert.equal(receipt?.credentialWrites.delete, 1);
      assert.equal(receipt?.restarts, 4);
      assert.equal(receipt?.rulesRuns, 2);
      assert.equal(receipt?.network.main.externalRequests, 0);
      assert.equal(receipt?.network.main.blockedRequests, 0);
      assert.ok(
        receipt?.network.backends.every(
          (n) => n.externalRequests === 0 && n.blockedRequests === 0,
        ),
      );
    },
  );

export async function runDesktopSettingsNative() {
  const { app, BrowserWindow, session, utilityProcess, safeStorage, ipcMain } =
    await import("electron");
  const runRoot = path.resolve(
    process.env.RJR_NATIVE_DESKTOP_SETTINGS_RUN_ROOT || "",
  );
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
  const receipt = {
    status: "running",
    scope:
      "real Electron renderer IPC and production utility backend; synthetic data only",
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
    },
    nativeEncryption: false,
    credentialWrites: { save: 0, delete: 0 },
    restarts: 0,
    rulesRuns: 0,
    checks: [],
    network: { main: null, backends: [] },
    shutdown: [],
    sourceHashes: {},
  };
  let backend,
    window,
    guard,
    isolated,
    origin,
    step = "app_ready";
  const check = (value, code) => {
    if (!value) throw Object.assign(Error(code), { code });
    receipt.checks.push(code);
  };
  const api = async (
    route,
    body,
    method = body === undefined ? "GET" : "POST",
    scope,
  ) => {
    const headers = { "content-type": "application/json", origin };
    const url = new URL(origin + "/api/v2" + route);
    if (scope)
      for (const [key, value] of Object.entries(scope))
        url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify({ ...body, ...scope }) }),
    });
    const value = await response.json();
    if (!response.ok)
      receipt.lastHttpFailure = {
        route,
        status: response.status,
        code:
          typeof value.code === "string" && /^[a-z0-9_]+$/.test(value.code)
            ? value.code
            : null,
      };
    check(response.ok, "http_" + method.toLowerCase() + "_" + response.status);
    return value;
  };
  const publicOnly = (value, secret) => {
    const encoded = JSON.stringify(value);
    check(
      !/apiKeyBinding|credentialFingerprint|fingerprint/.test(encoded),
      "public_response_has_no_binding",
    );
    check(!encoded.includes(secret), "public_response_has_no_synthetic_key");
  };
  try {
    await app.whenReady();
    const { prepareSelfTestDirectory } = await import(
      "../../electron/self-test.mjs"
    );
    isolated = prepareSelfTestDirectory({ tempRoot: runRoot });
    process.env.RJR_DATA_DIR = isolated.dataDir;
    const { installSelfTestNetworkGuard } = await import(
      "../../electron/self-test-network.mjs"
    );
    guard = installSelfTestNetworkGuard();
    app.on("session-created", (value) => guard.attachSession(value));
    guard.attachSession(session.defaultSession);
    const { createCredentialService, registerCredentialIpc } = await import(
      "../../electron/credentials.mjs"
    );
    const { createDesktopBackend } = await import(
      "../../electron/backend/host.mjs"
    );
    const credentials = createCredentialService({
      dataDir: isolated.dataDir,
      safeStorage,
    });
    check(credentials.available() === true, "native_encryption_available");
    receipt.nativeEncryption = true;
    const secret = "sk-synthetic-native-" + randomBytes(32).toString("hex");
    const credentialService = {
      async save(provider, key) {
        receipt.credentialWrites.save++;
        return credentials.save(provider, key);
      },
      async delete(provider) {
        receipt.credentialWrites.delete++;
        return credentials.delete(provider);
      },
    };
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(root, "electron/preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    registerCredentialIpc({
      ipcMain,
      service: credentials,
      getWindow: () => window,
      getOrigin: () => origin,
      onKey: (key) => backend.call("backend.modelKey", { key }),
    });
    // These benign UI reads remain native capabilities. No diagnostic or source
    // login bridge is registered by this isolated credential test.
    ipcMain.handle("directories:list", () => ({}));
    ipcMain.handle("collection:capabilities", () => ({
      available: false,
      canRemember: false,
    }));
    const start = async (modelKey = "") => {
      backend = createDesktopBackend({
        utilityProcess,
        BrowserWindow,
        session,
        sessionStore: {
          resumePending: async () => ({ completed: true }),
          available: () => false,
        },
        credentialService,
        dataDir: isolated.dataDir,
        appRoot: root,
        packaged: false,
        selfTest: true,
        offlineGuard: guard,
        onStage(value) {
          if (value.origin) {
            origin = value.origin;
            guard.setAllowedOrigin(origin);
          }
        },
      });
      const state = await backend.start(modelKey);
      check(state.state === "ready", "utility_ready");
      await window.loadURL(origin + "/");
      return api("/settings");
    };
    const stop = async () => {
      const status = await backend.call("backend.status", {});
      check(status.hostRole === "backend", "utility_host_role");
      receipt.network.backends.push(status.network);
      const shutdown = await backend.close();
      receipt.shutdown.push(shutdown);
      check(
        shutdown.cleanupComplete === true && backend.snapshot().pending === 0,
        "utility_closed_without_pending",
      );
      backend = null;
    };
    const inspectBinding = async (configured) => {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(
        path.join(isolated.dataDir, "workspace.sqlite"),
        { readOnly: true },
      );
      try {
        const row = db
          .prepare(
            "SELECT value FROM rows WHERE collection='settings' AND id='apiKeyBinding'",
          )
          .get();
        check(!!row, "sql_binding_row_exists");
        check(
          JSON.parse(row.value).configured === configured,
          "sql_binding_matches_commit",
        );
        check(!row.value.includes(secret), "sql_binding_has_no_plaintext");
      } finally {
        db.close();
      }
    };
    step = "first_configuration";
    let settings = await start();
    check(
      settings.model.configured === false &&
        settings.model.credentialStatus === "not_configured",
      "initial_unconfigured",
    );
    check(
      receipt.credentialWrites.save === 0,
      "default_self_test_did_not_save_key",
    );
    const saved = await window.webContents.executeJavaScript(
      "window.desktopBridge.saveKey('deepseek'," + JSON.stringify(secret) + ")",
      true,
    );
    check(saved.configured === true, "real_renderer_ipc_save_receipt");
    settings = await api("/settings");
    check(
      settings.model.configured === true &&
        settings.model.credentialStatus === "configured",
      "first_key_configures_backend",
    );
    check(
      receipt.credentialWrites.save === 1,
      "explicit_save_writes_encrypted_file_once",
    );
    const encrypted = fs.readFileSync(
      path.join(isolated.dataDir, "credentials.v2.json"),
      "utf8",
    );
    check(!encrypted.includes(secret), "native_credential_file_is_encrypted");
    check(
      (await credentials.readForModel("deepseek")) === secret,
      "native_safe_storage_round_trip",
    );
    publicOnly(settings, secret);
    publicOnly(await api("/workspace/backup", {}), secret);
    await stop();
    await inspectBinding(true);

    step = "restart_matching";
    settings = await start(await credentials.readForModel("deepseek"));
    receipt.restarts++;
    check(
      settings.model.configured === true,
      "restart_retains_matching_binding",
    );
    check(
      receipt.credentialWrites.save === 1,
      "startup_only_verifies_without_saving",
    );
    step = "configuration_mismatch";
    await api(
      "/settings",
      {
        model: {
          baseUrl: "http://127.0.0.1:9/v1",
          model: "synthetic-native-model",
        },
        budgets: { maxCostCny: null, maxModelRequests: 3 },
      },
      "PUT",
    );
    settings = await api("/settings");
    check(
      settings.model.configured === false &&
        settings.model.credentialStatus === "needs_configuration",
      "endpoint_change_requires_configuration",
    );
    check(
      settings.model.credentialMessage ===
        "本地模型凭据与当前配置尚未核对，请重新填写密钥并保存；规则分析仍可使用。",
      "mismatch_has_fixed_public_message",
    );
    check(
      receipt.credentialWrites.save === 1,
      "settings_patch_did_not_write_key",
    );
    publicOnly(settings, secret);
    await stop();
    settings = await start(await credentials.readForModel("deepseek"));
    receipt.restarts++;
    check(
      settings.model.configured === false &&
        settings.model.credentialStatus === "needs_configuration",
      "mismatched_restart_does_not_rebind",
    );

    step = "rules_during_mismatch";
    const profile = await api("/profiles", {
      versionName: "合成原生设置简历",
      submissionId: "native-settings-profile",
      text: "合成简历：本科消防工程专业，2027届毕业，机场消防和应急管理合成课程项目。",
      profile: {
        education: "本科",
        major: "消防工程",
        graduationYear: 2027,
        skills: [],
        certificates: [],
      },
    });
    const target = await api("/targets", {
      versionName: "合成原生设置目标",
      submissionId: "native-settings-target",
      profileRevisionId: profile.revisionId,
      enabled: true,
      roles: ["消防工程"],
      cityMode: "any",
      cities: [],
      jobTypes: ["campus"],
      degreePolicy: "eligibility",
      sourceIds: ["synthetic-desktop"],
      siteIds: [],
      coverageMode: "standard",
      budgets: {},
    });
    const scope = {
      packageId: target.packageId,
      targetRevisionId: target.revisionId,
    };
    const rules = async () => {
      const run = await api(
        "/runs",
        { targetRevisionId: target.revisionId, mode: "rules" },
        "POST",
        scope,
      );
      let result;
      for (let attempt = 0; attempt < 200; attempt++) {
        result = await api("/runs/" + run.runId, undefined, "GET", scope);
        if (["completed", "failed", "cancelled"].includes(result.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      check(result.status === "completed", "rules_run_completed");
      const jobs = await api("/jobs", undefined, "GET", scope);
      check(jobs.total >= 1, "rules_run_saved_synthetic_jobs");
      receipt.rulesRuns++;
    };
    await rules();
    await window.webContents.executeJavaScript(
      "window.desktopBridge.saveKey('deepseek'," + JSON.stringify(secret) + ")",
      true,
    );
    check(
      (await api("/settings")).model.configured === true &&
        receipt.credentialWrites.save === 2,
      "explicit_resave_rebinds_once",
    );
    await stop();
    settings = await start(await credentials.readForModel("deepseek"));
    receipt.restarts++;
    check(
      settings.model.configured === true,
      "rebound_configuration_survives_restart",
    );

    step = "delete_and_restart";
    const removed = await window.webContents.executeJavaScript(
      "window.desktopBridge.deleteKey('deepseek')",
      true,
    );
    check(
      removed.configured === false && receipt.credentialWrites.delete === 1,
      "real_renderer_ipc_delete_once",
    );
    settings = await api("/settings");
    check(
      settings.model.configured === false &&
        settings.model.credentialStatus === "not_configured",
      "delete_unconfigures_backend",
    );
    publicOnly(settings, secret);
    publicOnly(await api("/workspace/backup", {}), secret);
    await stop();
    await inspectBinding(false);
    check(
      (await credentials.readForModel("deepseek")) === "",
      "native_deleted_key_is_absent",
    );
    settings = await start("");
    receipt.restarts++;
    check(
      settings.model.configured === false &&
        settings.model.credentialStatus === "not_configured",
      "deleted_key_stays_unconfigured_after_restart",
    );
    await rules();
    await stop();
    receipt.network.main = guard.report();
    check(
      receipt.network.main.externalRequests === 0 &&
        receipt.network.main.blockedRequests === 0,
      "main_network_zero",
    );
    check(
      receipt.network.backends.every(
        (n) => n.externalRequests === 0 && n.blockedRequests === 0,
      ),
      "all_utility_network_zero",
    );
    for (const file of [
      "electron/backend/entry.cjs",
      "electron/backend/service.mjs",
      "electron/backend/host.mjs",
      "electron/credentials.mjs",
      "electron/main.mjs",
      "electron/backend/synthetic.mjs",
      "electron/backend/synthetic-environment.mjs",
      "electron/self-test-network.mjs",
      "src/application/context.mjs",
      "ui/src/features/settings/SettingsPage.tsx",
      "tests/integration/desktop-settings-native.test.mjs",
    ]) {
      receipt.sourceHashes[file] = createHash("sha256")
        .update(fs.readFileSync(path.join(root, file)))
        .digest("hex");
    }
    receipt.status = "passed";
  } catch (error) {
    receipt.status =
      error.code === "native_encryption_available"
        ? "blocked_native_encryption"
        : "failed";
    receipt.failedStep = step;
    receipt.errorCode = /^[a-zA-Z0-9_.:-]{1,100}$/.test(error.code || "")
      ? error.code
      : "native_assertion_failed";
  } finally {
    if (backend) {
      try {
        receipt.shutdown.push(await backend.close());
      } catch {}
    }
    if (guard) receipt.network.main = guard.report();
    window?.destroy();
    guard?.dispose();
    fs.writeFileSync(
      path.join(runRoot, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    app.exit(receipt.status === "passed" ? 0 : 1);
  }
}
