import {
  createCredentialService,
  registerCredentialIpc,
} from "./credentials.mjs";
// Electron 主进程：把内置服务装进原生窗口
//
// 设计要点：
//  1. 复用同一套 src/ 代码 —— 桌面版和网页版共用全部业务逻辑，不存在两套实现。
//  2. 数据目录必须重定向 —— 打包后代码在只读的 app.asar 里，只能往用户数据目录写。
//     且 RJR_DATA_DIR 必须在 import src/ 之前设置好，因为 config.mjs 在模块加载时
//     就计算出了 DATA_ROOT。
//  3. 只监听 127.0.0.1 的随机空闲端口 —— 不占固定端口、不对外暴露，因此无需登录。
import {
  app,
  BrowserWindow,
  Menu,
  shell,
  dialog,
  ipcMain,
  safeStorage,
  clipboard,
  session,
  utilityProcess,
} from "electron";
import path from "node:path";
import { installClosedPipeGuard } from "./process-output.mjs";
installClosedPipeGuard();
import { createCollectionSessions } from "./collection/sessions.mjs";
import { createDesktopBackend } from "./backend/host.mjs";
import { registerCollectionIpc } from "./collection/ipc.mjs";
import { createResourceShutdown } from "../src/infrastructure/lifecycle/resource-shutdown.mjs";
import { resolveDataLayout } from "../src/infrastructure/storage/layout.mjs";
import { registerDirectoryIpc } from "./directories.mjs";
import { presentDesktopWindow, setDesktopStartupState } from "./startup.mjs";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntimePerformance } from "../src/infrastructure/runtime/performance.mjs";
import { recordDiagnostic } from "../src/infrastructure/diagnostics/log.mjs";
import { createHostDiagnostics as createDiagnosticsLog } from "../src/infrastructure/diagnostics/host-log.mjs";
import {
  registerDiagnosticIpc,
  attachWindowDiagnostics,
} from "./diagnostics.mjs";

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const IS_DEV = !app.isPackaged;
const APP_TITLE = "简历岗位雷达";
// 自检模式：使用隐藏窗口验证内置服务、真实渲染器和预加载桥接。
const SELF_TEST = process.argv.includes("--self-test");
const selfTestEnvironment = SELF_TEST
  ? (await import("./self-test.mjs")).prepareSelfTestDirectory({
      explicitDataDir: process.env.RJR_DATA_DIR,
    })
  : null;
const selfTestNetwork = SELF_TEST
  ? (await import("./self-test-network.mjs")).installSelfTestNetworkGuard()
  : null;
const selfTestRendererErrors = [],
  selfTestExternalIntents = [];
if (SELF_TEST) {
  app.disableHardwareAcceleration();
  process.env.RJR_DATA_DIR = selfTestEnvironment.dataDir;
  process.env.RJR_DESKTOP = "1";
  process.env.RJR_DISABLE_LOCAL_CREDENTIALS = "1";
  for (const name of [
    "AUTH_PASSWORD",
    "DEEPSEEK_API_KEY",
    "TAVILY_API_KEY",
    "BOCHA_API_KEY",
    "SERPER_API_KEY",
  ])
    delete process.env[name];
  process.env.AUTH_SECRET = "synthetic-offline-self-test-secret";
  app.setPath(
    "userData",
    path.join(selfTestEnvironment.dataDir, "electron-session"),
  );
}

// 允许通过环境变量强制指定数据目录（便于排查问题）
function resolveDataDir() {
  if (selfTestEnvironment) return selfTestEnvironment.dataDir;
  if (process.env.RJR_DATA_DIR) return process.env.RJR_DATA_DIR;
  // 开发态直接复用项目里的 data/，这样 npm run desktop 能沿用已有配置与历史
  if (IS_DEV) return path.join(APP_ROOT, "data");
  return path.join(app.getPath("appData"), "ResumeJobRadar");
}

// seedConfig 已移入 src/config.mjs（由 ensureDataDirs 调用），
// 这样 Node 侧的自检 tools/test-desktop.mjs 也能覆盖到「首次运行生成配置」这条路径。

let mainWindow = null;
let dataDir = "";
let appUrl = "";
let diagnostics;
let backend;
let startupPhase = "started";
const runtimePerformance = createRuntimePerformance();
const runtime = {
  appVersion: app.getVersion(),
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  packaged: app.isPackaged,
  hostRole: "main",
  ...readBuildIdentity(),
};

function readBuildIdentity() {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(APP_ROOT, "build-info.json"), "utf8"),
    );
    if (/^[a-f0-9]{40}$/.test(value.buildId)) return { buildId: value.buildId };
  } catch {}
  return {};
}

// Observe fatal errors without changing Node's default termination behavior.
process.on("uncaughtExceptionMonitor", (error) => {
  try {
    diagnostics?.recordFatal(
      {
        operation: "desktop.failure",
        phase: startupPhase,
        outcome: "failed",
        code: "main_uncaught",
      },
      error,
    );
  } catch {
    // Preserve Node's default fatal error handling if the observer fails.
  }
});

/* ------------------------------ 菜单 ------------------------------ */
function buildMenu() {
  const openTarget = async (p) => {
    try {
      fs.mkdirSync(path.extname(p) ? path.dirname(p) : p, { recursive: true });
      const error = await shell.openPath(p);
      if (error) throw Error("open_failed");
      mainWindow?.webContents
        .executeJavaScript(
          'document.dispatchEvent(new CustomEvent("rjr-notification",{detail:{text:"已请求系统打开所选位置。",error:false}}))',
        )
        .catch(() => {});
    } catch {
      const diagnostic = await recordDiagnostic(diagnostics, {
        operation: "desktop.directories",
        phase: "open",
        outcome: "failed",
        code: "directory_operation_failed",
      });
      dialog.showErrorBox(
        "打开失败",
        "请检查目录权限后重试。" +
          (diagnostic?.diagnosticId
            ? "错误编号：" + diagnostic.diagnosticId
            : ""),
      );
    }
  };

  return Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        {
          label: "打开数据目录",
          accelerator: "CmdOrCtrl+D",
          click: () => openTarget(dataDir),
        },
        {
          label: "打开配置文件 config.json",
          click: () => openTarget(path.join(dataDir, "config.json")),
        },
        {
          label: "打开历史结果目录",
          click: () => openTarget(resolveDataLayout(dataDir).runs),
        },
        {
          label: "打开旧版兼容历史目录",
          click: () => openTarget(resolveDataLayout(dataDir).legacyRuns),
        },
        {
          label: "打开运行日志目录",
          click: () => openTarget(path.join(dataDir, "logs")),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      // 这些角色是剪贴板快捷键可靠工作的前提（简历粘贴强依赖）
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "刷新" },
        { role: "forceReload", label: "强制刷新" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "获取 DeepSeek API Key",
          click: () => shell.openExternal("https://platform.deepseek.com/"),
        },
        {
          label: "获取全网搜索 API Key（Tavily）",
          click: () => shell.openExternal("https://tavily.com/"),
        },
        { type: "separator" },
        {
          label: "关于",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: `关于 ${APP_TITLE}`,
              message: `${APP_TITLE} v${app.getVersion()}`,
              detail:
                `根据简历关键词检索校招 / 实习岗位，并用 DeepSeek 做匹配打分。\n\n` +
                `运行模式：${IS_DEV ? "开发" : "桌面应用"}\n` +
                `数据目录：${dataDir}\n` +
                `内置服务：${appUrl}\n\n` +
                `岗位来源：智联招聘、实习僧（可另接 Tavily / 博查 / Serper 扩展至全网）\n` +
                `本工具仅检索公开招聘信息，请遵守目标网站条款，用于个人求职。`,
              buttons: ["好"],
              noLink: true,
            });
          },
        },
      ],
    },
  ]);
}

/* ---------------------------- 窗口创建 ---------------------------- */
async function createWindow() {
  const iconPath = path.join(APP_ROOT, "build", "icon.ico");

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: SELF_TEST ? 0 : 375,
    minHeight: 660,
    show: false,
    title: APP_TITLE,
    backgroundColor: "#f5f6f8",
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(APP_ROOT, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      ...(SELF_TEST
        ? {
            backgroundThrottling: false,
            // Electron 42+ OSR defaults to 1 independently of the display CLI flag.
            offscreen: {
              deviceScaleFactor: Number(
                app.commandLine.getSwitchValue("force-device-scale-factor") ||
                  "1",
              ),
            },
          }
        : {}),
      // 界面只与本机内置服务通信，无需任何额外权限
      webSecurity: true,
    },
  });
  attachWindowDiagnostics({ window: mainWindow, diagnostics });

  // 外部链接（岗位页、DeepSeek 官网等）一律交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Always use the system browser for new windows.
    if (/^https?:/i.test(url)) {
      if (SELF_TEST) selfTestExternalIntents.push({ kind: "external-link" });
      else shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url === "rjr-startup:logs") {
      e.preventDefault();
      if (!SELF_TEST) void shell.openPath(path.join(dataDir, "logs"));
      return;
    }
    if (appUrl && new URL(url).origin === appUrl) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) {
      if (SELF_TEST) selfTestExternalIntents.push({ kind: "external-link" });
      else shell.openExternal(url);
    }
  });

  // 页面加载失败时给出可读提示，而不是白屏
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3) return; // 用户主动中断
    if (SELF_TEST) {
      selfTestRendererErrors.push({ code: "renderer_load_failed" });
      return;
    }
    void showStartupFailure("renderer_load_failed");
  });

  let startupWindowPresented = false;
  mainWindow.once("ready-to-show", () => {
    startupWindowPresented = presentDesktopWindow(mainWindow, {
      selfTest: SELF_TEST,
    });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!SELF_TEST)
      shutdownDesktop()
        .then(() => app.quit())
        .catch(() => app.quit());
  });

  if (SELF_TEST) {
    selfTestNetwork.attachSession(mainWindow.webContents.session);
    mainWindow.webContents.on("console-message", (_event, ...legacy) => {
      const details =
        _event && typeof _event === "object" && "level" in _event
          ? _event
          : { level: legacy[0], message: legacy[1] };
      if (details.level === "error" || details.level === 3)
        selfTestRendererErrors.push({
          code: "renderer_console_error",
          message: String(details.message).slice(0, 500),
          phase: mainWindow.__selfTestPhase || "startup",
        });
    });
  }
  if (!appUrl) {
    await mainWindow.loadFile(path.join(APP_ROOT, "electron", "startup.html"));
    presentDesktopWindow(mainWindow, { selfTest: SELF_TEST });
    return;
  }
  // The offline self-test controls task mutations in its synthetic workspace.
  await mainWindow.loadURL(
    SELF_TEST ? appUrl + "?fixtureStartup=disabled" : appUrl,
  );
  // A launcher may keep the first window hidden without a ready-to-show event.
  // Successful local-page loading is also a safe point to present the workspace.
  if (!startupWindowPresented)
    presentDesktopWindow(mainWindow, { selfTest: SELF_TEST });
  if (SELF_TEST)
    await mainWindow.webContents.executeJavaScript(
      "window.__rjrSelfTestIssues=[];window.addEventListener('securitypolicyviolation',e=>window.__rjrSelfTestIssues.push({code:'csp_violation',directive:e.violatedDirective}));window.addEventListener('error',()=>window.__rjrSelfTestIssues.push({code:'renderer_error'}));window.addEventListener('unhandledrejection',()=>window.__rjrSelfTestIssues.push({code:'renderer_rejection'}));",
    );
}

/* ---------------------------- 自检模式 ---------------------------- */
async function runSelfTest() {
  if (!mainWindow) await createWindow();
  const { runWorkspaceSelfTest } = await import("./self-test.mjs");
  let report;
  try {
    report = await runWorkspaceSelfTest({
      window: mainWindow,
      backend,
      dataDir,
      networkGuard: selfTestNetwork,
      rendererErrors: selfTestRendererErrors,
      externalIntents: selfTestExternalIntents,
    });
    if (app.isPackaged) {
      try {
        const { runBundledResourcesSelfTest } = await import(
          "./bundled-runtime-self-test.mjs"
        );
        const bundled = await runBundledResourcesSelfTest({
          resourcesRoot: process.resourcesPath,
          dataDir,
          networkGuard: selfTestNetwork,
        });
        report.bundled = bundled;
        report.results.push(...bundled.checks);
        report.passed += bundled.checks.length;
      } catch (error) {
        console.error("Synthetic bundled self-test failure:", error);
        report.results.push({
          name: "成品运行时/OCR/会话自检",
          ok: false,
          details: { code: error.code || error.name },
        });
        report.failed++;
        await recordDiagnostic(
          diagnostics,
          { operation: "desktop.failure", code: "bundled_self_test_failed" },
          error,
        );
      }
    }
    fs.writeFileSync(
      path.join(dataDir, "desktop-self-test.json"),
      JSON.stringify(report, null, 2),
    );
  } finally {
    await backend?.close();
    selfTestNetwork.dispose();
  }
  app.exit(report?.failed ? 1 : 0);
}

/* ------------------------------ 启动 ------------------------------ */
async function showStartupFailure(code, diagnosticId) {
  if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  appUrl = "";
  await mainWindow.loadFile(path.join(APP_ROOT, "electron", "startup.html"));
  await setDesktopStartupState(mainWindow, {
    state: "failed",
    code,
    diagnosticId,
  });
  presentDesktopWindow(mainWindow, { selfTest: SELF_TEST });
}

async function boot() {
  const started = Date.now();
  dataDir = resolveDataDir();
  process.env.RJR_DESKTOP = "1";
  process.env.RJR_DATA_DIR = dataDir;
  diagnostics = createDiagnosticsLog({ dataDir, runtime });
  await recordDiagnostic(diagnostics, {
    operation: "desktop.start",
    stage: "startup",
    phase: "started",
    outcome: "success",
    hostRole: "main",
  });
  // Present a responsive native surface before importing or recovering business
  // storage. All application construction happens in the formal utility child.
  await createWindow();
  if (!SELF_TEST) Menu.setApplicationMenu(buildMenu());
  const credentials = createCredentialService({ dataDir, safeStorage });
  const collectionSessions = createCollectionSessions({ dataDir, safeStorage });
  let modelKey = "";
  if (!SELF_TEST) {
    try {
      modelKey = await credentials.readForModel("deepseek");
    } catch (error) {
      await recordDiagnostic(
        diagnostics,
        {
          operation: "desktop.credentials",
          stage: "startup",
          phase: "read",
          outcome: "failed",
          code: "credential_read_failed",
        },
        error,
      );
    }
  }
  registerCredentialIpc({
    ipcMain,
    service: credentials,
    diagnostics,
    getWindow: () => mainWindow,
    getOrigin: () => appUrl,
    onKey: (key) => backend.call("backend.modelKey", { key }),
  });
  registerDiagnosticIpc({
    ipcMain,
    diagnostics,
    getWindow: () => mainWindow,
    getOrigin: () => appUrl,
  });
  registerDirectoryIpc({
    ipcMain,
    shell: SELF_TEST
      ? {
          openPath: async () => {
            selfTestExternalIntents.push({ kind: "directory-open" });
            return "";
          },
        }
      : shell,
    clipboard,
    getWindow: () => mainWindow,
    getOrigin: () => appUrl,
    layout: resolveDataLayout(dataDir),
    diagnostics,
  });
  startupPhase = "load";
  backend = createDesktopBackend({
    utilityProcess,
    BrowserWindow,
    session,
    sessionStore: collectionSessions,
    credentialService: credentials,
    diagnostics,
    dataDir,
    appRoot: APP_ROOT,
    resourcesRoot: process.resourcesPath,
    packaged: app.isPackaged,
    selfTest: SELF_TEST,
    offlineGuard: selfTestNetwork,
    runtime,
    onStage: async (value) => {
      if (value.origin && !appUrl) {
        appUrl = value.origin;
        selfTestNetwork?.setAllowedOrigin(appUrl);
        await mainWindow.loadURL(
          SELF_TEST ? appUrl + "?fixtureStartup=disabled" : appUrl,
        );
        presentDesktopWindow(mainWindow, { selfTest: SELF_TEST });
      } else if (!appUrl) await setDesktopStartupState(mainWindow, value);
    },
    onExit: async (value) => {
      const entry = await recordDiagnostic(diagnostics, {
        operation: "desktop.failure",
        phase: "finished",
        hostRole: "main",
        code: value.code,
        outcome: "failed",
        exitCode: value.exitCode,
      });
      await showStartupFailure(value.code, entry?.diagnosticId);
    },
  });
  registerCollectionIpc({
    ipcMain,
    backend,
    getWindow: () => mainWindow,
    getOrigin: () => appUrl,
  });
  const state = await backend.start(modelKey);
  await recordDiagnostic(diagnostics, {
    operation: "desktop.ready",
    stage: "startup",
    phase: "load",
    hostRole: "main",
    outcome: state.state === "ready" ? "success" : "partial",
    code: state.state === "ready" ? "server_ready" : "server_maintenance",
    durationMs: Date.now() - started,
    ...runtimePerformance.snapshot(),
  });
}

/* --------------------------- 应用生命周期 --------------------------- */
let shutdownPromise,
  shutdownComplete = false;
const desktopShutdown = createResourceShutdown({
  resources: () => [{ id: "application", stop: () => backend?.close() }],
  onError: (shutdownResource, error) =>
    recordDiagnostic(
      diagnostics,
      {
        operation: "application.shutdown",
        phase: "finished",
        shutdownResource,
        outcome: "failed",
        code: "shutdown_resource_failed",
      },
      error,
    ),
});
function shutdownDesktop() {
  return (shutdownPromise ||= desktopShutdown.close().finally(() => {
    shutdownComplete = true;
  }));
}
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;
  shutdownDesktop().then(
    () => app.quit(),
    () => app.quit(),
  );
});
// 只允许开一个实例，第二次启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    presentDesktopWindow(mainWindow, { selfTest: SELF_TEST });
  });

  app.setAppUserModelId("com.resumejobradar.desktop");

  app.whenReady().then(async () => {
    try {
      await boot();
      if (SELF_TEST) {
        await runSelfTest();
        return;
      }
      startupPhase = "render";
      Menu.setApplicationMenu(buildMenu());
      presentDesktopWindow(mainWindow, { selfTest: SELF_TEST });
      startupPhase = "finished";
      await recordDiagnostic(diagnostics, {
        operation: "desktop.ready",
        stage: "startup",
        phase: "finished",
        outcome: "success",
        code: "window_ready",
      });
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0)
          void createWindow().catch((error) =>
            recordDiagnostic(
              diagnostics,
              {
                operation: "desktop.failure",
                phase: "render",
                outcome: "failed",
                code: "window_create_failed",
              },
              error,
            ),
          );
        else presentDesktopWindow(mainWindow, { selfTest: SELF_TEST });
      });
    } catch (e) {
      diagnostics ||= createDiagnosticsLog({
        dataDir: resolveDataDir(),
        runtime,
      });
      const diagnostic = await recordDiagnostic(
        diagnostics,
        {
          operation: "desktop.failure",
          stage: "startup",
          phase: startupPhase,
          outcome: "failed",
        },
        e,
      );
      if (SELF_TEST) {
        console.error(e.stack);
        fs.writeFileSync(
          path.join(resolveDataDir(), "desktop-self-test.json"),
          JSON.stringify({ failed: 1, error: e.message, stack: e.stack }),
        );
        app.exit(1);
        return;
      }
      await showStartupFailure(
        "backend_start_failed",
        diagnostic?.diagnosticId,
      );
      return;
    }
  });

  app.on("window-all-closed", async () => {
    await shutdownDesktop();
    app.quit();
  });
}
