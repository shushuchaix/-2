import type { JobItem } from "./job-view";
import { factOf } from "./job-view";
import { Badge } from "../../components/ui/badge";
import { safeExternalUrl } from "../../../../public/js/format.js";
export function RecruitmentEvidence({ row }: { row: JobItem }) {
  const f = factOf(row),
    e = (row.recruitmentEvidence ?? {}) as Record<string, unknown>,
    proofs = Array.isArray(f.sourceEvidence)
      ? (f.sourceEvidence as Record<string, unknown>[])
      : [],
    conditions = Array.isArray(f.conditions)
      ? (f.conditions as Record<string, unknown>[])
      : [];
  const opening: Record<string, string> = {
      open: "当前招聘",
      closed: "已截止",
      historical: "历史结果公告",
      unknown: "招聘时效待核验",
    },
    apply: Record<string, string> = {
      available: "投递入口已核验",
      login_required: "投递入口需登录",
      unavailable: "投递入口不可用",
      unknown: "投递入口待核验",
    };
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 className="font-semibold">招聘证据与时效</h2>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">
          {e.bodyVerified ? "正文已核验" : "正文待补全"}
        </Badge>
        <Badge variant="outline">
          {opening[String(e.openingStatus)] ?? opening.unknown}
        </Badge>
        <Badge variant="outline">
          {apply[String(e.applicationStatus)] ?? apply.unknown}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        核验时间：
        {String(e.checkedAt ?? e.observedAt ?? f.retrievedAt ?? "暂无核验时间")}
        ；长期招聘与入口证据需定期复查。
      </p>
      {Array.isArray(e.conflicts) && e.conflicts.length > 0 && (
        <p role="status">
          存在多来源字段冲突，暂不作为已核实推荐：
          {e.conflicts
            .map((x) => String((x as Record<string, unknown>).field ?? "条件"))
            .join("、")}
        </p>
      )}
      {conditions.map((c, i) => (
        <p key={i}>
          {String(c.type ?? "条件")} ·{" "}
          {c.required === false ? "优先条件" : "必需条件"} ·{" "}
          {String(c.operator ?? "待核实")}{" "}
          {Array.isArray(c.values)
            ? c.values.join(" / ")
            : String(c.value ?? "")}
        </p>
      ))}
      {proofs.map((s, i) => {
        const url = safeExternalUrl(s.sourceUrl ?? s.url),
          loc = s.location as Record<string, unknown> | undefined;
        return (
          <div key={i} className="border-t pt-3">
            <p className="whitespace-pre-wrap">
              {String(s.quote ?? s.sourceExcerpt ?? "原文片段缺失")}
            </p>
            <p className="text-sm text-muted-foreground">
              {s.page || loc?.page ? `第 ${s.page ?? loc?.page} 页 · ` : ""}
              {String(
                s.cell ??
                  loc?.cell ??
                  loc?.cellRange ??
                  s.rowNumber ??
                  "位置待核实",
              )}{" "}
              · {String(s.field ?? "原文")} · 置信度{" "}
              {String(s.confidence ?? "未知")}
            </p>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                查看字段原始来源
              </a>
            )}
          </div>
        );
      })}
      {!proofs.length && <p>暂无字段原文与位置证据，缺失条件保持待核实。</p>}
    </section>
  );
}
