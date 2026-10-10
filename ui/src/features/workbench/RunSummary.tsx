import { Badge } from "../../components/ui/badge";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const money = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? String(Number(value.toFixed(6)))
    : "未提供";
export function RunSummary({ run }: { run: Record<string, unknown> }) {
  const counts = object(run.counts),
    usage = object(run.usage),
    source = object(usage.sources),
    model = object(usage.model);
  const coverage = Array.isArray(run.coverage) ? run.coverage.map(object) : [],
    issues = Array.isArray(run.issues) ? run.issues.map(object) : [];
  let outcome = "";
  if (run.status === "partial") {
    const failed =
      coverage.some(
        (e) => e.status === "failed" && e.truncationReason !== "request_budget",
      ) ||
      issues.some((i) =>
        /^(source_failed|unavailable|restricted|parse_error)$/.test(
          String(i.code),
        ),
      );
    const requestLimit =
      coverage.some((e) => e.truncationReason === "request_budget") ||
      issues.some((i) => /^(?:source_)?budget_exhausted$/.test(String(i.code)));
    const limited = coverage.filter((e) => e.truncated);
    outcome = failed
      ? "部分来源失败"
      : requestLimit
        ? "采集请求预算已用完，已取得结果保留"
        : limited.length &&
            limited.every((e) => e.truncationReason === "listing_only")
          ? "本轮更新完成，公告仅覆盖当前列表页"
          : limited.some((e) => e.truncationReason === "page_limit")
            ? "本轮更新完成，部分来源达到分页上限"
            : limited.length
              ? "本轮更新完成，部分来源仅覆盖指定页面"
              : "更新未全部完成";
  }
  const truncation: Record<string, string> = {
    listing_only: "仅当前列表页",
    page_limit: "达到分页上限",
    request_budget: "请求预算用完",
  };
  const status: Record<string, string> = {
    complete: "已完成",
    failed: "失败",
    skipped: "已跳过",
    running: "进行中",
  };
  return (
    <div className="flex flex-col gap-3">
      {outcome && <p>{outcome}。已取得的岗位记录保留。</p>}
      {(run.degraded || Number(counts.fallback) > 0) && (
        <Badge variant="secondary">部分模型评价已回退规则</Badge>
      )}
      {Object.keys(counts).length > 0 && (
        <p>
          资格通过 {String(counts.eligible ?? 0)} · 资格待核实{" "}
          {String(counts.qualificationUnknown ?? 0)} · 资格不符合{" "}
          {String(counts.qualificationFailed ?? 0)} · 模型评价{" "}
          {String(counts.aiSuccess ?? 0)} · 规则回退{" "}
          {String(counts.fallback ?? 0)}
        </p>
      )}
      {Object.keys(usage).length > 0 && (
        <p>
          来源请求 {String(source.requests ?? 0)} /{" "}
          {String(source.maxRequests ?? "—")} · 详情{" "}
          {String(source.details ?? 0)} / {String(source.maxDetails ?? "—")} ·
          模型尝试 {String(model.requests ?? 0)} /{" "}
          {String(model.maxRequests ?? "—")}
        </p>
      )}
      {model.costMode === "cny_upper_bound" && (
        <p>
          模型费用上界 ¥{money(model.costUpperBoundCny)} / ¥
          {money(model.maxCostCny)} · 当前预留 ¥{money(model.reservedCostCny)} ·
          用量不确定 ¥{money(model.uncertainCostCny)}
          。费用上界包含预留和不确定用量，不代表服务商最终账单。
        </p>
      )}
      {issues.some((i) => i.code === "model_budget_exhausted") && (
        <p>
          {model.costMode === "cny_upper_bound"
            ? "模型费用预算已达到上限或不足以预留下一次调用，剩余岗位已保留规则评价。"
            : "模型请求预算已达到上限，剩余岗位已保留规则评价。"}
        </p>
      )}
      {coverage.map((entry, index) => (
        <p key={index}>
          {String(entry.siteId ?? entry.sourceId ?? "来源")} ·{" "}
          {status[String(entry.status)] ?? String(entry.status ?? "状态待确认")}
          {entry.pages != null ? " · 已读取 " + entry.pages + " 页" : ""}
          {entry.truncated
            ? " · " +
              (truncation[String(entry.truncationReason)] ?? "采集范围受限")
            : ""}
        </p>
      ))}
    </div>
  );
}
