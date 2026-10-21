import { useEffect, useState } from "react";
import type { ApiClient, CollectionActivity, Scope } from "../../lib/types";
import { useOperation } from "../../lib/hooks";
import { useVersionContext } from "../../app/VersionContext";
import { buildHash } from "../../app/router";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import type { SourceSite, SourceHealth } from "./SiteDialog";
import {
  sourceStatusLabels,
  probeStatus,
  sourceIssueLabel,
} from "./source-view";
import { formatDate } from "../../../../public/js/format.js";

export function SiteProbeCard({
  api,
  sourceId,
  site,
  health,
  activity,
  scope,
  onHealth,
}: {
  api: ApiClient;
  sourceId: string;
  site: SourceSite;
  health?: SourceHealth;
  activity: CollectionActivity | null;
  scope: Scope | null;
  onHealth(health: SourceHealth): void;
}) {
  const [current, setCurrent] = useState(health);
  const context = useVersionContext();
  const op = useOperation();
  const active =
    activity?.collectionProgress.status === "collecting" ? activity : null;
  useEffect(() => setCurrent(health), [health]);
  return (
    <section
      aria-label={site.name + "站点探针"}
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>{site.name}</h3>
        <Badge variant="outline">
          {sourceStatusLabels[probeStatus(current)] || "状态待检查"}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        目录状态：{site.status === "candidate" ? "候选，待检查" : "已收录"}
      </p>
      <p className="break-all text-muted-foreground">
        {site.origin || "未提供公开地址"}
      </p>
      <p>
        本次尝试：{formatDate(current?.lastAttemptAt || current?.checkedAt)}
      </p>
      <p>
        最近成功：
        {formatDate(
          current?.lastSuccessAt ||
            (probeStatus(current) === "ready" ? current?.checkedAt : undefined),
        )}
      </p>
      <p className="text-sm">
        {Object.entries({
          list: "列表",
          body: "正文",
          attachments: "附件",
          apply: "投递入口",
        })
          .map(
            ([key, label]) =>
              label +
              "：" +
              (current?.capabilities?.[key] === "verified"
                ? "已验证"
                : "待验证"),
          )
          .join(" · ")}
      </p>
      <p className="text-sm text-muted-foreground">
        探针记录表示当时读取结果；当前招聘时效和投递入口仍需岗位证据核验。
      </p>
      {current?.sampleCount != null && (
        <p>
          列表样本：{current.sampleCount} 条
          {current.truncated ? " · 检查范围受限" : ""}
        </p>
      )}
      <OperationFeedback
        busy={op.busy}
        error={op.error}
        result={op.message}
        busyLabel="正在检查此站点的读取能力…"
      />
      {current?.issues?.map((issue, i) => (
        <p key={i}>
          {sourceIssueLabel(issue)}
          {issue.diagnosticId && (
            <a
              className="ml-2 text-primary underline"
              href={buildHash({
                page: "logs",
                selection: context.selection,
                filters: { tab: "system", diagnosticId: issue.diagnosticId },
              })}
            >
              查看更新日志
            </a>
          )}
        </p>
      ))}
      <Button
        variant="outline"
        disabled={op.busy || !scope || !active}
        aria-label={"检查" + site.name}
        onClick={() => {
          if (op.busy || !scope || !active) return;
          void op.run(async () => {
            const result = await api.request<SourceHealth>(
              "/sources/" + encodeURIComponent(sourceId) + "/probe",
              {
                method: "POST",
                scope,
                body: { siteId: site.siteId, activityId: active.runId },
              },
            );
            const next = {
              ...result,
              lastSuccessAt:
                result.status === "ready"
                  ? result.checkedAt
                  : result.lastSuccessAt || current?.lastSuccessAt,
            };
            setCurrent(next);
            onHealth(next);
          }, "来源检查已完成");
        }}
      >
        {op.busy ? "正在检查来源…" : "检查来源"}
      </Button>
      {!active && (
        <p className="text-sm text-muted-foreground">
          开始或继续本版本采集后，可使用累计额度检查来源。
        </p>
      )}
    </section>
  );
}
