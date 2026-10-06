import { el, button, downloadBlob } from "./dom.js";
import { feedback } from "./feedback.js";

function errorText(error) {
  const message = error.message || "请求失败";
  return error.diagnosticId && !message.includes(error.diagnosticId)
    ? message + "（错误编号：" + error.diagnosticId + "）"
    : message;
}

function entryText(entry) {
  const levels = { error: "错误", warn: "提醒", info: "信息" };
  return [
    [entry.at, levels[entry.level] || entry.level, entry.operation]
      .filter(Boolean)
      .join(" · "),
    entry.message,
    entry.diagnosticId ? "错误编号：" + entry.diagnosticId : null,
    [
      entry.runId && "任务：" + entry.runId,
      entry.sourceId && "来源：" + entry.sourceId,
      entry.siteId && "站点：" + entry.siteId,
      entry.stage && "阶段：" + entry.stage,
      entry.code && "错误代码：" + entry.code,
      entry.durationMs != null && "耗时：" + entry.durationMs + "ms",
    ]
      .filter(Boolean)
      .join(" · "),
    entry.counts ? "计数：" + JSON.stringify(entry.counts) : null,
    entry.error ? JSON.stringify(entry.error, null, 2) : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function diagnosticsPanel({ document: d, api }) {
  const status = feedback(d),
    scope = el(d, "p", { className: "muted" }, "最近的全部更新日志"),
    storage = el(d, "p", { className: "muted" }),
    entries = el(
      d,
      "div",
      { className: "diagnostics-list" },
      el(d, "p", { className: "muted" }, "展开后读取最近的更新日志。"),
    ),
    node = el(
      d,
      "details",
      { className: "card diagnostics-panel" },
      el(d, "summary", {}, "查看更新日志"),
    );
  let runId = null,
    version = 0,
    destroyed = false,
    loaded = false,
    reading = null,
    exporting = null;
  const refresh = button(d, "刷新日志", () => void load()),
    download = button(d, "导出日志", () => void exportLogs());
  node.append(
    scope,
    el(d, "div", { className: "row" }, refresh, download),
    status.node,
    storage,
    entries,
  );
  const query = (limit = false) => {
    const parts = [];
    if (runId) parts.push("runId=" + encodeURIComponent(runId));
    if (limit) parts.push("limit=200");
    return parts.length ? "?" + parts.join("&") : "";
  };
  const current = (request, active) =>
    !destroyed && request === active && request.version === version;
  const controls = () => {
    refresh.disabled = Boolean(reading);
    download.disabled = Boolean(exporting);
  };
  async function load() {
    if (destroyed || reading || !node.open) return;
    const request = { version, controller: new AbortController() };
    reading = request;
    controls();
    status.show("正在读取日志…");
    try {
      const result = await api.request("/diagnostics/logs" + query(true), {
        signal: request.controller.signal,
      });
      if (!current(request, reading)) return;
      if (!Array.isArray(result.entries)) throw Error("日志响应格式无效");
      const rendered = result.entries.map((entry) =>
        el(
          d,
          "pre",
          { className: "prose diagnostics-entry" },
          entryText(entry),
        ),
      );
      entries.replaceChildren(
        ...(rendered.length
          ? rendered
          : [
              el(
                d,
                "p",
                { className: "muted" },
                "暂无更新日志。升级前的任务没有详细日志，请重新更新一次后查看。",
              ),
            ]),
      );
      storage.textContent =
        result.storage?.mode === "memory"
          ? "日志文件写入失败，当前使用内存日志；重启软件后这些日志会丢失。" +
            (result.storage.message || "")
          : "日志文件：" + (result.file || "logs/application.log");
      loaded = true;
      status.show("已读取 " + result.entries.length + " 条日志。");
    } catch (error) {
      if (current(request, reading))
        status.show("日志读取失败：" + errorText(error), true);
    } finally {
      if (reading === request) {
        reading = null;
        controls();
      }
    }
  }
  async function exportLogs() {
    if (destroyed || exporting) return;
    const request = { version, controller: new AbortController() };
    exporting = request;
    controls();
    try {
      const blob = await api.download("/diagnostics/logs/export" + query(), {
        signal: request.controller.signal,
      });
      if (!current(request, exporting)) return;
      downloadBlob(d, blob, "job-radar-update.log");
      status.show("日志已导出。");
    } catch (error) {
      if (current(request, exporting))
        status.show("日志导出失败：" + errorText(error), true);
    } finally {
      if (exporting === request) {
        exporting = null;
        controls();
      }
    }
  }
  const onToggle = () => {
    if (node.open && !loaded) void load();
  };
  node.addEventListener("toggle", onToggle);
  return {
    node,
    setRunId(id) {
      const next = id || null;
      if (destroyed || next === runId) return;
      version++;
      reading?.controller.abort();
      exporting?.controller.abort();
      reading = exporting = null;
      runId = next;
      loaded = false;
      controls();
      status.show("");
      storage.textContent = "";
      scope.textContent = runId ? "当前任务：" + runId : "最近的全部更新日志";
      entries.replaceChildren(
        el(d, "p", { className: "muted" }, "展开后读取最近的更新日志。"),
      );
      if (node.open) void load();
    },
    destroy() {
      destroyed = true;
      version++;
      reading?.controller.abort();
      exporting?.controller.abort();
      node.removeEventListener("toggle", onToggle);
    },
  };
}
