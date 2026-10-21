import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import type { EvidenceView } from "./evidence-view";

const labels = { verified: "已核验", unknown: "待核验", unavailable: "不可用" };
export function EvidenceSummary({
  view,
  compact = false,
}: {
  view: EvidenceView;
  compact?: boolean;
}) {
  return (
    <section
      aria-label="岗位证据摘要"
      className={cn(
        "flex min-w-0 flex-col gap-3",
        !compact && "rounded-lg border p-4",
      )}
    >
      {!compact && <h2>岗位证据摘要</h2>}
      <dl className={cn("grid gap-3", !compact && "sm:grid-cols-2")}>
        {view.items.map((item) => (
          <div key={item.key} className="flex min-w-0 flex-col gap-1">
            <dt className="flex flex-wrap items-center gap-2">
              {item.label}
              <Badge
                variant={item.state === "verified" ? "secondary" : "outline"}
              >
                {labels[item.state]}
              </Badge>
            </dt>
            {item.reason && (!compact || item.state !== "verified") && (
              <dd className="text-sm text-muted-foreground">{item.reason}</dd>
            )}
          </div>
        ))}
      </dl>
      {!!view.conflicts.length && (
        <p className="text-sm text-muted-foreground">
          存在来源冲突：{view.conflicts.join("、")}；推荐结论需结合冲突复核。
        </p>
      )}
    </section>
  );
}
