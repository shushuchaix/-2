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
} from "electron";
import path from "node:path";
import { resolveDataLayout } from "../src/infrastructure/storage/layout.mjs";
import { registerDirectoryIpc } from "./directories.mjs";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createDiagnosticsLog,
  recordDiagnostic,
} from "../src/infrastructure/diagnostics/log.mjs";
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
if (SELF_TEST) {
  const isolated = path.join(resolveDataDir(), "electron-self-test-session");
  fs.mkdirSync(isolated, { recursive: true });
  app.setPath("userData", isolated);
}

// 允许通过环境变量强制指定数据目录（便于排查问题）
function resolveDataDir() {
  if (process.env.RJR_DATA_DIR) return process.env.RJR_DATA_DIR;
  // 开发态直接复用项目里的 data/，这样 npm run desktop 能沿用已有配置与历史
  if (IS_DEV) return path.join(APP_ROOT, "data");
  return path.join(app.getPath("appData"), "ResumeJobRadar");
}

// seedConfig 已移入 src/config.mjs（由 ensureDataDirs 调用），
// 这样 Node 侧的自检 tools/test-desktop.mjs 也能覆盖到「首次运行生成配置」这条路径。

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

let mainWindow = null;
let httpServer = null;
let dataDir = "";
let appUrl = "";
let diagnostics;
let startupPhase = "started";
const runtime = {
  appVersion: app.getVersion(),
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  packaged: app.isPackaged,
};

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
    minWidth: 1000,
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
      // 界面只与本机内置服务通信，无需任何额外权限
      webSecurity: true,
    },
  });
  attachWindowDiagnostics({ window: mainWindow, diagnostics });

  // 外部链接（岗位页、DeepSeek 官网等）一律交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Always use the system browser for new windows.
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (appUrl && url.startsWith(appUrl)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // 页面加载失败时给出可读提示，而不是白屏
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3) return; // 用户主动中断
    dialog.showErrorBox(
      "页面加载失败",
      `无法加载 ${url}\n\n${desc}（${code}）`,
    );
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(appUrl);
}

/* ---------------------------- 自检模式 ---------------------------- */
/** 生成一个最小可用的 PDF，用于验证 pdfjs 在打包后仍能正常解析 */
function makeTestPdf(lines) {
  const esc = (s) =>
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  const content = `BT /F1 14 Tf 40 760 Td 20 TL\n${lines.map((l) => `(${esc(l)}) Tj T*`).join("\n")}\nET`;
  const objs = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    4: `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  let pdf = "%PDF-1.4\n";
  const offsets = {};
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++)
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function runSelfTest() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log(
      `  ${ok ? "✅" : "❌"} ${name}${detail ? "  —  " + detail : ""}`,
    );
  };

  console.log("\n=== 桌面外壳自检 ===\n");
  try {
    check(
      "内置服务监听随机端口",
      /^http:\/\/127\.0\.0\.1:\d+$/.test(appUrl),
      appUrl,
    );

    const page = await fetch(`${appUrl}/`);
    const html = await page.text();
    check(
      "首页可访问且内容正确",
      page.status === 200 && html.includes("简历岗位雷达"),
      `HTTP ${page.status}, ${html.length} 字节`,
    );

    const s = await (await fetch(`${appUrl}/api/session`)).json();
    check("标记为桌面模式", s.desktop === true);
    check(
      "桌面模式免登录",
      s.authRequired === false,
      `authRequired=${s.authRequired}`,
    );
    check("数据目录已重定向到可写位置", s.dataDir === dataDir, s.dataDir);
    check(
      "返回 DeepSeek 配置状态",
      typeof s.deepseekConfigured === "boolean",
      `deepseekConfigured=${s.deepseekConfigured}`,
    );

    for (const f of ["/app.js", "/style.css", "/login.js", "/login"]) {
      const r = await fetch(`${appUrl}${f}`);
      check(`静态资源 ${f}`, r.status === 200, `HTTP ${r.status}`);
    }

    const h = await (await fetch(`${appUrl}/api/health`)).json();
    check("/api/health 正常", h.ok === true && h.version);

    const probe = path.join(dataDir, ".write-probe");
    fs.writeFileSync(probe, "ok", "utf8");
    const wrote = fs.readFileSync(probe, "utf8") === "ok";
    fs.rmSync(probe, { force: true });
    check("数据目录可写", wrote, dataDir);

    check(
      "应用图标存在",
      fs.existsSync(path.join(APP_ROOT, "build", "icon.ico")),
    );
    check(
      "配置文件已就位",
      fs.existsSync(path.join(dataDir, "config.json")),
      path.join(dataDir, "config.json"),
    );

    // 最能暴露打包问题的一项：pdfjs 是 ESM + 动态 import，在 asar 内解析失败会直接抛错
    const { extractResumeText } = await import(
      "../src/resume/extract-text.mjs"
    );
    const pdfBuf = makeTestPdf([
      "Zhang Ming",
      "Java Spring Boot MySQL Redis Docker",
      "Beijing University of Posts and Telecommunications",
    ]);
    const parsed = await extractResumeText(pdfBuf, "self-test.pdf");
    check(
      "PDF 文本提取可用（验证 pdfjs 在 asar 内正常）",
      parsed.format === "pdf" && /Spring/.test(parsed.text),
      `提取 ${parsed.text.length} 字：${parsed.text.replace(/\s+/g, " ").slice(0, 46)}`,
    );
    // Exercise the real sandboxed renderer and preload, not just its HTTP server.
    mainWindow = new BrowserWindow({
      show: false,
      width: 1440,
      height: 1000,
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(APP_ROOT, "electron", "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    attachWindowDiagnostics({ window: mainWindow, diagnostics });
    await mainWindow.loadURL(appUrl);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        await mainWindow.webContents.executeJavaScript(
          "document.querySelectorAll('nav a').length===5",
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    check(
      "真实渲染器加载五页导航",
      await mainWindow.webContents.executeJavaScript(
        "document.querySelectorAll('nav a').length===5",
      ),
    );
    const bridge = await mainWindow.webContents.executeJavaScript(
      "(async()=>({node:typeof require,methods:Object.keys(window.desktopBridge||{}),status:await window.desktopBridge.getKeyStatus('deepseek')}))()",
    );
    check(
      "renderer没有Node访问或明文密钥",
      bridge.node === "undefined" &&
        bridge.methods.length === 5 &&
        bridge.methods.every((method) =>
          [
            "isAvailable",
            "saveKey",
            "deleteKey",
            "getKeyStatus",
            "reportDiagnostic",
          ].includes(method),
        ) &&
        Object.keys(bridge.status).every((k) =>
          ["configured", "encryptionAvailable"].includes(k),
        ),
    );
    if (bridge.status.encryptionAvailable) {
      const result = await mainWindow.webContents.executeJavaScript(
        "(async()=>{await desktopBridge.saveKey('deepseek','synthetic-self-test-key');const saved=await desktopBridge.getKeyStatus('deepseek');await desktopBridge.deleteKey('deepseek');return {saved,cleared:await desktopBridge.getKeyStatus('deepseek')};})()",
      );
      check(
        "系统加密保存与清除可用",
        result.saved.configured &&
          !result.cleared.configured &&
          !fs
            .readFileSync(path.join(dataDir, "credentials.v2.json"), "utf8")
            .includes("synthetic-self-test-key"),
      );
    } else check("系统加密可用", false, "本机加密不可用");
    const rendererReport = await mainWindow.webContents.executeJavaScript(
      "desktopBridge.reportDiagnostic({operation:'renderer.request',code:'network_error',phase:'transport',outcome:'failed',method:'PUT',route:'/api/v2/settings',message:'synthetic-private-report',body:{resumeText:'synthetic-private-report'}})",
    );
    const rendererLogs = await diagnostics.list({
      diagnosticId: rendererReport?.diagnosticId,
    });
    check(
      "桌面界面失败安全上报",
      /^d-/.test(rendererReport?.diagnosticId || "") &&
        rendererLogs.entries.some(
          (entry) => entry.operation === "renderer.request",
        ) &&
        !JSON.stringify(rendererLogs).includes("synthetic-private-report"),
    );
    for (const [route, label] of [
      ["profiles", "简历与目标"],
      ["jobs", "岗位库"],
      ["applications", "投递进度"],
      ["settings", "让来源与设置保持清晰"],
    ]) {
      await mainWindow.webContents.executeJavaScript(
        "location.hash=" + JSON.stringify("#/" + route),
      );
      let loaded = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        loaded = await mainWindow.webContents.executeJavaScript(
          "document.querySelector('main h1')?.textContent===" +
            JSON.stringify(label),
        );
        if (loaded) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      check("桌面页面 " + route, loaded);
    }
    const validation = await mainWindow.webContents.executeJavaScript(`(()=>{
      const budget=[...document.querySelectorAll('input[type="number"]')].find(input=>!input.closest('[hidden]'));
      if(!budget) return {invalid:false,corrected:false};
      budget.value='11';
      budget.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      return {invalid:budget.getAttribute('aria-invalid')==='true' && document.activeElement===budget && budget.value==='11' && !!document.querySelector('.validation-summary:not([hidden])')};
    })()`);
    check("桌面填写错误提示、输入保留与聚焦", validation.invalid);
    await mainWindow.webContents.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    fs.writeFileSync(
      path.join(dataDir, "desktop-validation.png"),
      (await mainWindow.webContents.capturePage()).toPNG(),
    );
    check(
      "桌面修改后清除字段错误",
      await mainWindow.webContents.executeJavaScript(`(()=>{
      const budget=[...document.querySelectorAll('input[type="number"]')].find(input=>!input.closest('[hidden]'));
      budget.value='0';budget.dispatchEvent(new Event('input',{bubbles:true}));
      return !budget.hasAttribute('aria-invalid') && budget.value==='0';
    })()`),
    );
    const logEntry = await diagnostics.record(
      {
        operation: "run.ingest",
        runId: "r-desktop-log",
        sourceId: "synthetic",
        stage: "details",
      },
      Error("Missing source title"),
    );
    const logResponse = await fetch(
      appUrl + "/api/v2/diagnostics/logs?runId=r-desktop-log",
    );
    const logData = await logResponse.json();
    check(
      "桌面日志写入与任务筛选",
      logResponse.ok &&
        logData.entries.some(
          (entry) => entry.diagnosticId === logEntry.diagnosticId,
        ) &&
        fs.existsSync(path.join(dataDir, "logs", "application.log")),
    );
    await mainWindow.webContents.executeJavaScript(
      "document.querySelector('.diagnostics-panel').open=true",
    );
    let logVisible = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      logVisible = await mainWindow.webContents.executeJavaScript(
        "document.querySelector('.diagnostics-list')?.textContent.includes(" +
          JSON.stringify(logEntry.diagnosticId) +
          ")",
      );
      if (logVisible) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check("桌面实际日志查看入口", logVisible);
    const logExport = await fetch(
      appUrl + "/api/v2/diagnostics/logs/export?runId=r-desktop-log",
    );
    check(
      "桌面日志导出",
      logExport.ok && (await logExport.text()).includes(logEntry.diagnosticId),
    );
    await mainWindow.webContents.executeJavaScript(
      "document.querySelector('.diagnostics-panel').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    check(
      "桌面详细日志不撑宽页面",
      await mainWindow.webContents.executeJavaScript(
        "(()=>{const panel=document.querySelector('.diagnostics-panel');return panel.scrollWidth<=panel.clientWidth+1&&document.documentElement.scrollWidth<=window.innerWidth+1})()",
      ),
    );
    fs.writeFileSync(
      path.join(dataDir, "desktop-logs.png"),
      (await mainWindow.webContents.capturePage()).toPNG(),
    );
    check(
      "桌面人民币费用、预算回退、资格统计与重复提醒合并",
      await mainWindow.webContents.executeJavaScript(`(async()=>{
        const {runProgress}=await import('/js/components/run-progress.js');
        const run={status:'partial',stage:'finished',degraded:true,
          counts:{deduplicated:12,shortlisted:7,eligible:1,qualificationUnknown:9,qualificationFailed:2,aiSuccess:2,fallback:10},
          usage:{sources:{requests:4,maxRequests:120,details:3,maxDetails:20},model:{requests:4,maxRequests:1000,maxCostCny:10,costUpperBoundCny:8.516608,reservedCostCny:0,uncertainCostCny:8.516608,uncertainRequests:4,pricedRequests:0,costMode:'cny_upper_bound'}},
          coverage:[{siteId:'synthetic',status:'complete',truncated:true,pages:1,truncationReason:'listing_only'}],
          issues:[{code:'model_budget_exhausted',affectedCount:8,diagnosticId:'d-budget-synthetic'},
            {code:'invalid_model_result',jobId:'j-1',diagnosticId:'d-validation-synthetic'},
            {code:'invalid_model_result',jobId:'j-2',diagnosticId:'d-validation-synthetic'}]};
        const panel=runProgress({document,run});panel.id='desktop-budget-preview';panel.classList.add('card');
        document.body.append(panel);panel.scrollIntoView({block:'start'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const text=panel.textContent;
        return text.includes('资格待核实 9')&&text.includes('影响 8 条')&&text.includes('影响 2 条')&&
          text.split('d-validation-synthetic').length===2&&!text.includes('检查模型设置')&&text.includes('详情 3 / 20')&&
          text.includes('模型费用上界 ¥8.516608 / ¥10')&&text.includes('用量不确定的费用上界 ¥8.516608');
      })()`),
    );
    fs.writeFileSync(
      path.join(dataDir, "desktop-budget.png"),
      (await mainWindow.webContents.capturePage()).toPNG(),
    );
    await mainWindow.webContents.executeJavaScript(
      "document.getElementById('desktop-budget-preview')?.remove()",
    );
    await mainWindow.webContents.executeJavaScript(
      "location.hash='#/workbench'",
    );
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(
      path.join(dataDir, "desktop-smoke.png"),
      (await mainWindow.webContents.capturePage()).toPNG(),
    );
  } catch (e) {
    check("自检执行", false, e.message);
  }

  const failed = results.filter((r) => !r.ok).length;
  fs.writeFileSync(
    path.join(dataDir, "desktop-self-test.json"),
    JSON.stringify(
      {
        version: app.getVersion(),
        electron: process.versions.electron,
        results,
        failed,
      },
      null,
      2,
    ),
  );
  console.log(`\n  通过 ${results.length - failed} 项，失败 ${failed} 项\n`);

  if (httpServer) {
    try {
      httpServer.close();
    } catch {
      /* 忽略 */
    }
  }
  app.exit(failed === 0 ? 0 : 1);
}

/* ------------------------------ 启动 ------------------------------ */
async function boot() {
  const started = Date.now();
  dataDir = resolveDataDir();
  diagnostics = createDiagnosticsLog({ dataDir, runtime });
  await recordDiagnostic(diagnostics, {
    operation: "desktop.start",
    stage: "startup",
    phase: "started",
    outcome: "success",
  });
  process.env.RJR_DESKTOP = "1";
  process.env.RJR_DATA_DIR = dataDir;

  // 必须在 import src/ 之前设好环境变量（config.mjs 在模块加载时就定了 DATA_ROOT）
  startupPhase = "parse";
  await recordDiagnostic(diagnostics, {
    operation: "desktop.start",
    stage: "startup",
    phase: startupPhase,
    code: "config_loading",
    outcome: "success",
  });
  const { loadConfig, ensureDataDirs } = await import("../src/config.mjs");
  const { createServer } = await import("../src/server.mjs");

  // ensureDataDirs 内部会 seedConfig：把 config.example.json 复制到可写数据目录
  ensureDataDirs();

  const cfg = loadConfig({ quiet: true });
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0; // 交给系统分配空闲端口，避免与已装的服务冲突
  cfg.server.trustProxy = false;
  // 桌面外壳只监听本机，不会被外部访问，因此不需要登录流程
  if (!process.env.AUTH_PASSWORD && !cfg.auth.passwordHash)
    cfg.auth.mode = "none";

  const credentials = createCredentialService({ dataDir, safeStorage });
  startupPhase = "read";
  try {
    const key = await credentials.readForModel("deepseek");
    if (key) cfg.deepseek.apiKey = key;
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
    console.error("[desktop] 加密密钥无法读取，请重新设置。");
  }
  registerCredentialIpc({
    ipcMain,
    service: credentials,
    diagnostics,
    getWindow: () => mainWindow,
    getOrigin: () => appUrl,
    onKey: (key) => {
      cfg.deepseek.apiKey = key;
    },
  });
  registerDiagnosticIpc({
    ipcMain,
    diagnostics,
    getWindow: () => mainWindow,
    getOrigin: () => appUrl,
  });
  registerDirectoryIpc({
    ipcMain,
    shell,
    clipboard,
    getWindow: () => mainWindow,
    getOrigin: () => appUrl,
    layout: resolveDataLayout(dataDir),
    diagnostics,
  });
  startupPhase = "load";
  const { server, ready } = createServer(cfg, {
    dataDir,
    dependencies: { diagnostics },
  });
  await ready;
  const port = await listen(server);
  httpServer = server;
  appUrl = `http://127.0.0.1:${port}`;
  await recordDiagnostic(diagnostics, {
    operation: "desktop.ready",
    stage: "startup",
    phase: "load",
    outcome: "success",
    code: "server_ready",
    durationMs: Date.now() - started,
  });

  console.log(`[desktop] 数据目录 ${dataDir}`);
  console.log(`[desktop] 内置服务 ${appUrl}`);
}

/* --------------------------- 应用生命周期 --------------------------- */
// 只允许开一个实例，第二次启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
      await createWindow();
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
      dialog.showErrorBox(
        "启动失败",
        `启动未完成，请检查数据目录的写入权限和磁盘空间。\n\n${diagnostic?.diagnosticId ? "错误编号：" + diagnostic.diagnosticId + "\n" : ""}日志目录：${path.join(resolveDataDir(), "logs")}\n请保留数据目录以便排查。`,
      );
      app.quit();
      return;
    }
  });

  app.on("window-all-closed", () => {
    if (httpServer) {
      try {
        httpServer.close();
      } catch {
        /* 忽略 */
      }
    }
    app.quit();
  });
}
