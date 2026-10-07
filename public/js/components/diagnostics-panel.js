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
      entry.requestId && "请求编号：" + entry.requestId,
      entry.parentRequestId && "原请求编号：" + entry.parentRequestId,
      entry.sessionId && "启动会话：" + entry.sessionId,
      entry.jobId && "内部岗位编号：" + entry.jobId,
      entry.parentDiagnosticId && "关联错误：" + entry.parentDiagnosticId,
      entry.category && "分类：" + entry.category,
      entry.phase && "步骤：" + entry.phase,
      entry.failurePhase && "失败步骤：" + entry.failurePhase,
      entry.dnsResolver && "DNS 方式：" + entry.dnsResolver,
      entry.endpointKind && "请求用途：" + entry.endpointKind,
      entry.outcome && "结果：" + entry.outcome,
      entry.method && [entry.method, entry.route].filter(Boolean).join(" "),
      entry.httpStatus != null && "HTTP：" + entry.httpStatus,
      entry.resource && "资源：" + entry.resource,
      entry.retryCount != null && "重试：" + entry.retryCount,
      entry.retryDelayMs != null && "重试间隔：" + entry.retryDelayMs + "ms",
      entry.attempt != null && "尝试：" + entry.attempt,
      entry.recordCount != null && "记录数：" + entry.recordCount,
      entry.responseBytes != null && "响应字节数：" + entry.responseBytes,
      entry.exitCode != null && "退出代码：" + entry.exitCode,
      entry.errorNumber != null && "加载错误代码：" + entry.errorNumber,
      entry.durationMs != null && "耗时：" + entry.durationMs + "ms",
      entry.queueMs != null && "排队：" + entry.queueMs + "ms",
      entry.dnsMs != null && "DNS：" + entry.dnsMs + "ms",
      entry.transportMs != null && "传输：" + entry.transportMs + "ms",
      entry.timeoutMs != null && "超时上限：" + entry.timeoutMs + "ms",
      entry.page != null && "页码：" + entry.page,
      entry.queryIndex != null && "检索序号：" + entry.queryIndex,
      entry.redirectCount != null && "重定向：" + entry.redirectCount,
      entry.issueCount != null && "问题数：" + entry.issueCount,
      entry.revision != null && "工作区版本：" + entry.revision,
      entry.budgetKind && "预算类别：" + entry.budgetKind,
    ]
      .filter(Boolean)
      .join(" · "),
    entry.counts ? "计数：" + JSON.stringify(entry.counts) : null,
    entry.coverage ? "来源覆盖：" + JSON.stringify(entry.coverage) : null,
    entry.usage ? "预算与用量：" + JSON.stringify(entry.usage) : null,
    entry.parser ? "解析结构：" + JSON.stringify(entry.parser) : null,
    entry.runtime ? "运行环境：" + JSON.stringify(entry.runtime) : null,
    entry.error ? JSON.stringify(entry.error, null, 2) : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function diagnosticsPanel({ document: d, api }) {
  const status = feedback(d),
    scope = el(
      d,
      "p",
      { className: "muted" },
      "运行诊断：最近的全部更新日志及软件操作。",
    ),
    storage = el(d, "p", { className: "muted" }),
    summary = el(d, "p", { className: "muted diagnostics-summary" }),
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
    selectedRunId = null,
    filters = {},
    version = 0,
    destroyed = false,
    loaded = false,
    reading = null,
    exporting = null;
  const refresh = button(d, "刷新日志", () => void load()),
    download = button(d, "导出日志", () => void exportLogs()),
    all = button(d, "查看全部日志", () => {
      runId = runId ? null : selectedRunId;
      all.textContent = runId
        ? "查看全部日志"
        : selectedRunId
          ? "查看当前任务"
          : "查看全部日志";
      reset();
    }),
    level = el(
      d,
      "select",
      { name: "diagnosticLevel", "aria-label": "日志级别" },
      ...[
        ["", "全部级别"],
        ["problem", "错误与提醒"],
        ["error", "错误"],
        ["warn", "提醒"],
        ["info", "信息"],
      ].map(([value, label]) => el(d, "option", { value }, label)),
    ),
    category = el(
      d,
      "select",
      { name: "diagnosticCategory", "aria-label": "日志分类" },
      ...[
        ["", "全部分类"],
        ["run", "更新任务"],
        ["network", "网络"],
        ["storage", "存储"],
        ["http", "操作请求"],
        ["source", "招聘来源"],
        ["model", "模型"],
        ["desktop", "桌面与界面"],
        ["application", "工作区操作"],
      ].map(([value, label]) => el(d, "option", { value }, label)),
    ),
    diagnosticId = el(d, "input", {
      name: "diagnosticId",
      "aria-label": "错误编号",
      placeholder: "按错误编号查找",
      maxLength: 38,
    }),
    apply = button(d, "筛选日志", () => {
      const id = diagnosticId.value.trim();
      if (id && !/^d-[a-f0-9-]{36}$/.test(id)) {
        status.show("请填写完整的错误编号（d- 开头）。", true);
        return;
      }
      filters = {
        ...(level.value ? { level: level.value } : {}),
        ...(category.value ? { category: category.value } : {}),
        ...(id ? { diagnosticId: id } : {}),
      };
      reset();
    });
  all.hidden = !selectedRunId;
  node.append(
    scope,
    el(d, "div", { className: "row" }, level, category, diagnosticId, apply),
    el(d, "div", { className: "row" }, refresh, download, all),
    status.node,
    storage,
    summary,
    entries,
  );
  const query = (limit = false) => {
    const parts = [];
    if (runId) parts.push("runId=" + encodeURIComponent(runId));
    if (limit) parts.push("limit=200");
    for (const [key, value] of Object.entries(filters))
      parts.push(key + "=" + encodeURIComponent(value));
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
      const meta = result.summary;
      summary.textContent = [
        meta &&
          "显示 " +
            meta.returned +
            " / " +
            meta.total +
            " 条；错误 " +
            meta.errors +
            " 条，提醒 " +
            meta.warnings +
            " 条。",
        meta?.truncated && "当前仅显示最近记录，导出可取得全部保留日志。",
        meta?.oldestAt && "范围：" + meta.oldestAt + " 至 " + meta.newestAt,
        meta?.damagedLines && "已跳过 " + meta.damagedLines + " 条损坏记录。",
        meta?.rotated && "包含轮转保留日志。",
        result.retention &&
          "保留范围：" +
            (result.retention.fileCount ?? result.retention.maxFiles ?? 2) +
            " 个文件，每个 " +
            result.retention.maxFileBytes / 1048576 +
            " MiB；内存最多 " +
            result.retention.maxMemoryEntries +
            " 条。",
        result.runtime &&
          "运行环境：" +
            [
              result.runtime.appVersion && "软件 " + result.runtime.appVersion,
              result.runtime.nodeVersion &&
                "Node " + result.runtime.nodeVersion,
              result.runtime.electronVersion &&
                "Electron " + result.runtime.electronVersion,
              result.runtime.chromeVersion &&
                "Chromium " + result.runtime.chromeVersion,
              result.runtime.osRelease && "系统 " + result.runtime.osRelease,
              [result.runtime.platform, result.runtime.arch]
                .filter(Boolean)
                .join("/"),
            ]
              .filter(Boolean)
              .join(" · "),
      ]
        .filter(Boolean)
        .join("\n");
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
  function reset() {
    version++;
    reading?.controller.abort();
    exporting?.controller.abort();
    reading = exporting = null;
    loaded = false;
    controls();
    status.show("");
    storage.textContent = summary.textContent = "";
    scope.textContent = runId
      ? "当前任务：" + runId
      : "运行诊断：最近的全部更新日志及软件操作。";
    entries.replaceChildren(
      el(d, "p", { className: "muted" }, "展开后读取最近的更新日志。"),
    );
    if (node.open) void load();
  }
  return {
    node,
    refresh() {
      if (destroyed) return;
      loaded = false;
      reading?.controller.abort();
      reading = null;
      controls();
      if (node.open) return load();
    },
    setRunId(id) {
      const next = id || null;
      if (destroyed || next === selectedRunId) return;
      selectedRunId = next;
      runId = next;
      all.hidden = !selectedRunId;
      all.textContent = "查看全部日志";
      reset();
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
