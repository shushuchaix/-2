import { useState } from "react";
import { Button } from "../../components/ui/button";
import type { JobItem } from "./job-view";
import { factOf } from "./job-view";
import { Badge } from "../../components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { Separator } from "../../components/ui/separator";
import { safeExternalUrl } from "../../../../public/js/format.js";
export function RecruitmentEvidence({ row }: { row: JobItem }) {
  const [copyFeedback,setCopyFeedback] = useState("");
  const [copying,setCopying] = useState<string | null>(null);
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
      expired: "已过期",
      historical: "历史结果公告",
      unknown: "招聘时效待核验",
    },
    apply: Record<string, string> = {
      available: "投递入口已核验",
      login_required: "投递入口需登录",
      unavailable: "投递入口不可用",
      invalid: "入口失效",
      unknown: "投递入口待核验",
    };
  const platform = f.platformEvidence as
    | {
        opening?: { status?: string; value?: string; checkedAt?: string };
        entry?: { kind?: string; status?: string; checkedAt?: string };
      }
    | undefined;
  const checkedAt = Date.parse(platform?.opening?.checkedAt || "");
  const fresh =
    Number.isFinite(checkedAt) &&
    checkedAt <= Date.now() &&
    Date.now() - checkedAt <= 72 * 3600000;
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <h2>招聘核验记录</h2>
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
      {platform && (
        <Alert role="note">
          <AlertTitle>平台观察</AlertTitle>
          <AlertDescription>
            <p>
              {fresh &&
              platform.opening?.status === "verified" &&
              platform.opening.value === "recruiting"
                ? "在招"
                : "待复核"}
              （平台状态单独展示，仍需核实岗位正文与投递入口）。
            </p>
            {platform.entry?.kind === "communication" && (
              <p>平台沟通入口：不构成投递证据。</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        核验时间：
        {String(
          e.applicationCheckedAt ??
            e.checkedAt ??
            e.observedAt ??
            f.retrievedAt ??
            "暂无核验时间",
        )}
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
      {Array.isArray(f.applicationChannels) && f.applicationChannels.length > 0 && (
        <section aria-label="官网邮件投递候选" className="flex flex-col gap-3 rounded-md border p-3">
          <h3 className="font-medium">官网邮件投递候选</h3>
          <p className="text-sm text-muted-foreground">官网声明的收件渠道，未证明邮箱实际收件或已经提交。邮件候选不等于已核验投递入口。</p>
          {f.applicationChannels.filter(c => c.kind === "manual_email" && c.status === "candidate" && typeof c.address === "string").map(c => {
            const url = safeExternalUrl(c.sourceUrl);
            return <div key={c.channelId} className="flex flex-col gap-2">
              <p className="break-all">{c.address}</p>
              <p className="text-sm text-muted-foreground">{c.instructionExcerpt} · 观察时间：{c.observedAt}</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" className="min-h-11" disabled={copying !== null} onClick={async () => {
                  setCopying(c.channelId); setCopyFeedback("");
                  try { await navigator.clipboard.writeText(c.address); setCopyFeedback("邮箱已复制，尚未发送或记录为已投递。"); }
                  catch { setCopyFeedback("复制未成功，请手动选择邮箱文字。"); }
                  finally { setCopying(null); }
                }}>{copying === c.channelId ? "复制中…" : "复制邮箱"}</Button>
                {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">查看邮箱官方来源</a>}
              </div>
            </div>;
          })}
          {copyFeedback && <p role="status">{copyFeedback}</p>}
        </section>
      )}
      {f.applicationChannelOverflow && <p role="status">官网渠道候选较多，当前只展示有限条目；请回官方原文核对，不能据此自动选择投递邮箱。</p>}
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
          <div key={i} className="flex flex-col gap-3">
            <Separator />
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
