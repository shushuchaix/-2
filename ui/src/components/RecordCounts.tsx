import type { Counts as PackageCounts } from "../lib/types";

export type Counts = Partial<PackageCounts>;

const packageLabels: [keyof PackageCounts, string][] = [
  ["profiles", "简历"],
  ["targets", "求职目标"],
  ["jobs", "岗位"],
  ["observations", "来源记录"],
  ["evaluations", "评价"],
  ["runs", "检索任务"],
  ["applications", "投递记录"],
  ["events", "变更事件"],
  ["files", "文件"],
];
const runLabels: [string, string][] = [
  ["raw", "采集"],
  ["newForTarget", "保存"],
  ["normalized", "整理"],
  ["notices", "招聘通知"],
  ["expanded", "展开线索"],
  ["deduplicated", "去重后岗位"],
  ["eligible", "条件通过"],
  ["qualificationUnknown", "条件待核验"],
  ["qualificationFailed", "条件不满足"],
  ["shortlisted", "候选岗位"],
  ["aiSuccess", "模型评价"],
  ["fallback", "规则评价"],
  ["input", "输入记录"],
  ["accepted", "接收记录"],
  ["rejected", "拒绝记录"],
  ["pages", "页面"],
];
function count(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? String(value)
    : "未统计";
}

/** Only service-defined counters enter a business summary. */
export function RecordCounts({
  counts,
  kind = "package",
  label,
  "aria-label": ariaLabel,
}: {
  counts: Record<string, unknown>;
  kind?: "package" | "run";
  label?: string;
  "aria-label"?: string;
}) {
  const labels =
    kind === "package"
      ? packageLabels
      : runLabels.filter(
          ([key]) =>
            key === "raw" ||
            key === "newForTarget" ||
            Object.hasOwn(counts, key),
        );
  return (
    <section
      aria-label={
        ariaLabel ?? label ?? (kind === "package" ? "版本内容计数" : "运行计数")
      }
      className="flex flex-col gap-3"
    >
      {kind === "run" && (
        <p>
          采集 {count(counts.raw)} / 保存 {count(counts.newForTarget)}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {labels.map(([key, text]) => (
          <div key={key} className="flex flex-col gap-1">
            <dt className="text-sm text-muted-foreground">{text}</dt>
            <dd className="font-medium tabular-nums">{count(counts[key])}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
