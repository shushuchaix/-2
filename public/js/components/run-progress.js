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
function runLabel(run) {
  if (run.status !== "partial") return RUN_LABELS[run.status] || run.status;
  const sourceFailed =
    (run.coverage || []).some((entry) => entry.status === "failed") ||
    (run.issues || []).some((issue) =>
      /^(source_failed|unavailable|restricted|parse_error)$/.test(issue.code),
    );
  if (sourceFailed) return "部分来源失败";
  if (
    (run.coverage || []).some((entry) => entry.truncated) ||
    (run.issues || []).some((issue) => issue.code === "budget_exhausted")
  )
    return "达到采集上限，结果未覆盖全部来源";
  return "更新未全部完成";
}
export function runOutcomeText(run) {
  const counts = run.counts || {};
  return (
    runLabel(run) +
    "。" +
    (counts.deduplicated == null
      ? "已保存结果保留"
      : "已保存 " + counts.deduplicated + " 条记录") +
    (counts.shortlisted == null ? "" : "，候选 " + counts.shortlisted + " 条") +
    "。"
  );
}
function issueText(issue) {
  const operation = (issue.operation || "") + " " + (issue.code || ""),
    location = [issue.sourceId, issue.siteId].filter(Boolean).join(" / ");
  const hints =
    issue.code === "detail_insufficient"
      ? "原网站未提供完整岗位要求，已保留列表信息。"
      : issue.code === "budget_exhausted"
        ? "本次达到采集预算或分页上限，已取得的列表信息已保留。"
        : /model|evaluat|llm|(?:^|[.\s_-])ai(?:$|[.\s_-])/i.test(operation)
          ? "建议检查模型设置，或使用规则模式重试；查看更新日志了解失败操作。"
          : location ||
              /source|collect|detail|fetch|network|timeout|unavailable|restricted|parse_error/i.test(
                operation,
              )
            ? "建议检查网络及该来源的可用状态，然后重试；查看更新日志了解失败操作。"
            : "查看更新日志了解失败操作和详细原因后重试。";
  return (
    issue.code +
    (location ? "（" + location + "）" : "") +
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
      el(d, "span", { className: "badge" }, runLabel(run)),
      run.degraded
        ? el(d, "span", { className: "badge" }, "部分模型评价已回退规则")
        : null,
    ),
    ["completed", "partial", "failed", "cancelled", "interrupted"].includes(
      run.status,
    )
      ? el(d, "p", {}, runOutcomeText(run))
      : null,
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
