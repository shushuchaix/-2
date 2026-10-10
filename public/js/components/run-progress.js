import { el } from "./dom.js";
export const RUN_LABELS = {
  queued: "排队中",
  running: "正在更新",
  completed: "更新完成",
  partial: "本轮更新完成，来源采集范围受限",
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
    (run.coverage || []).some(
      (entry) =>
        entry.status === "failed" &&
        entry.truncationReason !== "request_budget",
    ) ||
    (run.issues || []).some((issue) =>
      /^(source_failed|unavailable|restricted|parse_error)$/.test(issue.code),
    );
  if (sourceFailed) return "部分来源失败";
  if (
    (run.coverage || []).some(
      (entry) => entry.truncationReason === "request_budget",
    ) ||
    (run.issues || []).some((issue) =>
      /^(?:source_)?budget_exhausted$/.test(issue.code),
    )
  )
    return "采集请求预算已用完，已取得结果保留";
  const limited = (run.coverage || []).filter((entry) => entry.truncated);
  if (limited.length) {
    if (limited.every((entry) => entry.truncationReason === "listing_only"))
      return "本轮更新完成，公告仅覆盖当前列表页";
    if (limited.some((entry) => entry.truncationReason === "page_limit"))
      return "本轮更新完成，部分来源达到分页上限";
    return "本轮更新完成，部分来源仅覆盖指定页面";
  }
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
function issueText(issue, run) {
  const operation = (issue.operation || "") + " " + (issue.code || ""),
    location = [issue.sourceId, issue.siteId].filter(Boolean).join(" / ");
  const hints =
    issue.code === "model_budget_exhausted"
      ? run.usage?.model?.costMode === "cny_upper_bound"
        ? "本次模型费用预算已达到上限或不足以预留下一次调用（上限 ¥" +
          money(run.usage.model.maxCostCny) +
          "），剩余岗位已保留规则评价。"
        : "本次模型请求达到 " +
          (run.usage?.model?.maxRequests ?? 20) +
          " 次上限，剩余岗位已保留规则评价。"
      : issue.code === "invalid_model_result" ||
          issue.code === "missing_model_result"
        ? "模型返回结果未通过结构或原文证据校验，已保留规则评价；具体校验原因见更新日志。"
        : issue.code === "detail_insufficient"
          ? "原网站未提供完整岗位要求，已保留列表信息。"
          : /^(?:source_)?budget_exhausted$/.test(issue.code)
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
    (issue.affectedCount ? "（影响 " + issue.affectedCount + " 条记录）" : "") +
    (issue.occurrences > 1 && !issue.affectedCount
      ? "（同类提醒 " + issue.occurrences + " 次）"
      : "") +
    (issue.diagnosticId ? "（错误编号：" + issue.diagnosticId + "）" : "") +
    "\n" +
    hints
  );
}
function money(value) {
  return Number.isFinite(value) && value >= 0
    ? value.toFixed(6).replace(/\.?0+$/, "") || "0"
    : "未提供";
}
function groupedIssues(issues) {
  const groups = new Map();
  for (const [index, issue] of issues.entries()) {
    const key = JSON.stringify([
      issue.code,
      issue.code === "model_budget_exhausted"
        ? "budget"
        : issue.diagnosticId || index,
      issue.sourceId,
      issue.siteId,
      issue.operation,
    ]);
    const group = groups.get(key) || {
      issue,
      jobs: new Set(),
      affected: 0,
      occurrences: 0,
    };
    group.occurrences++;
    if (issue.jobId) group.jobs.add(issue.jobId);
    if (Number.isSafeInteger(issue.affectedCount) && issue.affectedCount > 0)
      group.affected += issue.affectedCount;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group.issue,
    affectedCount: group.affected || group.jobs.size || undefined,
    occurrences: group.occurrences,
  }));
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
      ]
        .map(([label, n]) => label + " " + (n ?? 0))
        .join(" → "),
    ),
    el(
      d,
      "p",
      {},
      [
        ["已确认资格通过", c.eligible],
        ...(c.qualificationUnknown != null
          ? [["资格待核实", c.qualificationUnknown]]
          : []),
        ...(c.qualificationFailed != null
          ? [["资格不符合", c.qualificationFailed]]
          : []),
      ]
        .map(([label, n]) => label + " " + (n ?? 0))
        .join(" · ") +
        "；模型评价 " +
        (c.aiSuccess ?? 0) +
        "，规则回退 " +
        (c.fallback ?? 0) +
        "。候选记录可能包含资格待核实项。",
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
        (source.maxDetails != null ? " / " + source.maxDetails : "") +
        (model.costMode === "cny_upper_bound"
          ? " · 模型尝试（辅助上限） "
          : " · 模型尝试 ") +
        (model.requests ?? 0) +
        " / " +
        (model.maxRequests ?? 20) +
        " · 输出 tokens " +
        (model.completionTokens ?? model.outputTokens ?? "未提供"),
    ),
    model.costMode === "cny_upper_bound"
      ? el(
          d,
          "p",
          { className: "muted" },
          "模型费用上界 ¥" +
            money(model.costUpperBoundCny) +
            " / ¥" +
            money(model.maxCostCny) +
            " · 正在进行的预留 ¥" +
            money(model.reservedCostCny) +
            " · 用量不确定的费用上界 ¥" +
            money(model.uncertainCostCny) +
            "（" +
            (model.uncertainRequests ?? 0) +
            " 次） · 已按用量计价 " +
            (model.pricedRequests ?? 0) +
            " 次。费用上界包含预留和不确定用量，不代表服务商最终账单。",
        )
      : null,
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
            (s.pages != null ? " · 已读取 " + s.pages + " 页" : "") +
            (s.truncated && !s.reason
              ? " · " +
                ({
                  listing_only: "仅当前列表页",
                  page_limit: "达到分页上限",
                  request_budget: "请求预算用完",
                }[s.truncationReason] || "采集范围受限")
              : "") +
            (s.reason ? " · " + s.reason : ""),
        ),
      ),
    ),
    el(
      d,
      "div",
      { className: "prose" },
      groupedIssues(run.issues || [])
        .map((issue) => issueText(issue, run))
        .join("\n"),
    ),
  );
}
