import { el } from "./dom.js";
export const RUN_LABELS = {
  queued: "排队中",
  running: "正在更新",
  completed: "更新完成",
  partial: "部分来源失败或达到采集上限",
  failed: "更新失败",
  cancelled: "已取消",
  interrupted: "进程中断，可重新更新",
};
const STAGE_LABELS = {
  queued: "等待开始",
  planning: "准备采集计划",
  collecting: "采集招聘来源",
  details: "读取招聘详情",
  expanding: "整理与扩展岗位",
  evaluating: "评价岗位匹配",
  finished: "更新结束",
};
function issueText(issue) {
  const operation = issue.operation || "";
  const hints = /source|collect|detail|fetch|network|timeout/i.test(
    operation + " " + issue.code,
  )
    ? "建议检查网络及该来源的可用状态，然后重试；查看更新日志了解失败操作。"
    : /model|evaluat|ai/i.test(operation + " " + issue.code)
      ? "建议检查模型设置，或使用规则模式重试；查看更新日志了解失败操作。"
      : "查看更新日志了解失败操作和详细原因后重试。";
  return (
    issue.code +
    "：" +
    (issue.message || issue.siteId || "") +
    (issue.diagnosticId ? "（错误编号：" + issue.diagnosticId + "）" : "") +
    "\n" +
    hints
  );
}
export function runProgress({ document: d, run }) {
  if (!run)
    return el(d, "p", { className: "muted" }, "选择目标后更新招聘来源。");
  const c = run.counts || {},
    usage = run.usage || {},
    source = usage.sources || {},
    model = usage.model || {};
  return el(
    d,
    "div",
    { className: "stack" },
    el(
      d,
      "div",
      { className: "row" },
      el(
        d,
        "span",
        { className: "badge" },
        RUN_LABELS[run.status] || run.status,
      ),
      run.degraded
        ? el(d, "span", { className: "badge" }, "部分模型评价已回退规则")
        : null,
    ),
    el(
      d,
      "p",
      {},
      "阶段：" +
        (STAGE_LABELS[run.stage || "queued"] || run.stage) +
        " · 新发现 " +
        (c.newForTarget || 0) +
        " 条",
    ),
    el(
      d,
      "div",
      { className: "prose" },
      [
        ["采集原始记录", c.raw],
        ["归一化", c.normalized],
        ["保留独立记录", c.deduplicated],
        ["公告", c.notices],
        ["资格通过", c.eligible],
        ["模型评价", c.aiSuccess],
        ["规则回退", c.fallback],
      ]
        .map(([label, n]) => label + " " + (n ?? 0))
        .join(" → "),
    ),
    el(
      d,
      "p",
      { className: "muted" },
      "来源请求 " +
        (source.requests ?? 0) +
        " / " +
        (source.maxRequests ?? "—") +
        " · 详情 " +
        (source.details ?? 0) +
        " · 模型尝试 " +
        (model.requests ?? 0) +
        " / " +
        (model.maxRequests ?? 20) +
        " · 输出 tokens " +
        (model.completionTokens ?? model.outputTokens ?? "未提供"),
    ),
    el(
      d,
      "div",
      { className: "source-list" },
      (run.coverage || []).map((s) =>
        el(
          d,
          "div",
          { className: "source-row" },
          s.siteId +
            " · " +
            s.status +
            (s.truncated ? " · 已截断" : "") +
            (s.reason ? " · " + s.reason : ""),
        ),
      ),
    ),
    el(
      d,
      "div",
      { className: "prose" },
      (run.issues || []).map(issueText).join("\n"),
    ),
  );
}
