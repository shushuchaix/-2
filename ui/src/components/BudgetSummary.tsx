import type { BudgetView } from "../lib/budget-view";
const shown = (v: number | undefined) =>
  v === undefined ? "未提供" : String(v);
export function BudgetSummary({
  view,
  label,
}: {
  view: BudgetView;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm"
    >
      <p className="font-medium">
        {label} ·{" "}
        {view.source === "activity"
          ? "当前活动账本"
          : view.source === "saved"
            ? "配置预览"
            : "模式默认"}
      </p>
      <p>
        最多 {shown(view.limits.maxSites)} 站 · {shown(view.limits.maxRequests)}{" "}
        次采集请求 · 每查询 {shown(view.limits.maxPagesPerQuery)} 页 ·{" "}
        {shown(view.limits.maxDetails)} 次详情
      </p>
      {view.costMode === "cny" ? (
        view.source === "activity" ? (
          <p>
            活动累计费用上界{" "}
            {view.usedCostCny === null
              ? "未提供"
              : "¥" + view.usedCostCny.toFixed(2)}{" "}
            / ¥{view.limits.maxCostCny} · 剩余{" "}
            {view.remainingCostCny === null
              ? "未提供"
              : "¥" + view.remainingCostCny.toFixed(2)}
          </p>
        ) : (
          <p>新活动模型费用上限：{view.limits.maxCostCny} 元</p>
        )
      ) : (
        <p>
          {view.costMode === "request_count"
            ? "使用请求次数预算 · 模型尝试上限 " +
              (view.modelRequestLimit ?? "未提供")
            : "模型费用账本未提供"}
        </p>
      )}
      {view.costMode === "cny" && view.limits.maxCostCny === 0 && (
        <p>模型调用已关闭</p>
      )}
      <p className="text-muted-foreground">
        站数是上限，实际受可用来源与证据准入限制。费用上界包含预留，不代表服务商账单；继续采集沿用同一活动累计额度。
      </p>
    </section>
  );
}
