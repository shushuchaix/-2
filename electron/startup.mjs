// The HTTP server retains a safe maintenance surface when workspace startup fails.
// Normal desktop startup must keep that surface reachable; self-test must fail loudly.
export async function awaitDesktopContext(ready, { selfTest = false } = {}) {
  try {
    return await ready;
  } catch (error) {
    if (selfTest) throw error;
    return null;
  }
}

// Focusing a hidden BrowserWindow does not reveal it. Use the same presentation
// path after loading and when Windows forwards a second launch to this instance.
export function presentDesktopWindow(window, { selfTest = false } = {}) {
  if (selfTest || !window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return window.isVisible();
}

const startupCopy = {
  configuration: "正在准备本地服务…",
  recovery: "正在整理历史数据并检查恢复状态…",
  repository: "正在打开岗位资料…",
  migration: "正在升级历史数据…",
  "storage-opening": "正在打开岗位资料…",
  "storage-recovering": "正在整理历史数据并检查恢复状态…",
  "business-ready": "工作区已就绪。",
  ready: "工作区已就绪。",
};

export async function setDesktopStartupState(
  window,
  { state, stage, diagnosticId, code } = {},
) {
  if (!window || window.isDestroyed()) return;
  const failed = ["failed", "maintenance"].includes(state);
  const copy = failed
    ? "后台未能完成启动。请打开运行日志，检查目录权限和磁盘空间后重新启动软件。"
    : startupCopy[stage] || "正在准备工作区…";
  const safeId = /^d-[a-f0-9-]{36}$/.test(diagnosticId || "")
    ? diagnosticId
    : "";
  const safeCode = [
    "backend_exited",
    "backend_start_failed",
    "backend_bootstrap_failed",
    "renderer_load_failed",
  ].includes(code)
    ? code
    : "backend_start_failed";
  const errorText = failed
    ? safeId
      ? "错误编号：" + safeId
      : "错误代码：" + safeCode
    : "";
  await window.webContents
    .executeJavaScript(
      `(()=>{const status=document.getElementById('startup-status'),error=document.getElementById('startup-error');if(status)status.textContent=${JSON.stringify(copy)};if(error){error.textContent=${JSON.stringify(errorText)};error.hidden=${!errorText};}document.body.dataset.state=${JSON.stringify(failed ? "failed" : "loading")};})()`,
    )
    .catch(() => {});
}
