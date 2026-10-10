import { useEffect, useRef, useState } from "react";
import type { ApiClient, Scope, CollectionQuality } from "../../lib/types";
import { useOperation } from "../../lib/hooks";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { TextField } from "../../components/TextField";
import { OperationFeedback } from "../../components/OperationFeedback";
export type CollectionActivity = {
  runId: string;
  collectionRole?: string;
  status?: string;
  createdAt?: string;
  ownerPackageId?: string;
  targetSnapshot?: { revisionId: string };
  collectionUsage?: Record<string, number>;
  quality?: CollectionQuality;
  collectionProgress: {
    status: string;
    revision: number;
    activeSliceRunId?: string | null;
    limits: Record<string, number>;
    metrics?: Record<string, number>;
    lastErrorCode?: string;
    replanRequired?: boolean;
    units: Record<
      string,
      { status: string; siteId: string; committedPages: number }
    >;
  };
};
export const collectionStatus: Record<string, string> = {
  collecting: "正在采集",
  paused: "已暂停，可继续",
  waiting_for_auth: "等待独立窗口登录",
  budget_exhausted: "累计额度不足",
  completed: "计划范围已完成",
  cancelled: "活动已取消",
};
export function CollectionProgress({
  activity,
  api,
  scope,
  onChanged,
  readOnly = false,
  mode = "rules",
  userKey = "",
  onKeyUsed,
}: {
  activity: CollectionActivity;
  api: ApiClient;
  scope?: Scope;
  onChanged?(a: CollectionActivity): void;
  readOnly?: boolean;
  mode?: string;
  userKey?: string;
  onKeyUsed?(): void;
}) {
  const p = activity.collectionProgress,
    u = activity.collectionUsage ?? {},
    op = useOperation(),
    live = useRef(true);
  const [requests, setRequests] = useState(String(p.limits.maxRequests)),
    [cost, setCost] = useState(String(p.limits.maxCostCny));
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const units = Object.values(p.units ?? {}),
    sites = new Set(units.map((x) => x.siteId)),
    actualSites = new Set(
      units.filter((x) => x.committedPages > 0).map((x) => x.siteId),
    ),
    pending = units.filter((x) => x.status !== "completed").length;
  const prefix = "/collections/" + encodeURIComponent(activity.runId);
  async function action(kind: string, replan = false) {
    if (!scope || op.busy) return;
    await op.run(
      async () => {
        await api.request(prefix + "/" + kind, {
          method: "POST",
          scope,
          body:
            kind === "resume"
              ? {
                  requestId: crypto.randomUUID(),
                  ...(replan ? { replan: true } : {}),
                  mode,
                  ...(mode === "ai" && userKey ? { userApiKey: userKey } : {}),
                }
              : {},
        });
        if (kind === "resume") onKeyUsed?.();
        const next = await api.request<CollectionActivity>(prefix, { scope });
        if (live.current) onChanged?.(next);
      },
      kind === "pause"
        ? "活动已暂停"
        : kind === "resume"
          ? "已继续采集，沿用活动累计额度"
          : "活动已取消",
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>持续采集活动</CardTitle>
        <CardDescription>
          {activity.runId} ·{" "}
          <Badge variant="secondary">
            {collectionStatus[p.status] ?? p.status}
          </Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {p.replanRequired && (
          <p role="status">
            来源或查询已变化，请确认重新规划。沿用当前活动，累计用量和10元费用上限保留。
          </p>
        )}
        <p>
          已提交{" "}
          {p.metrics?.committedPages ??
            units.reduce((n, x) => n + x.committedPages, 0)}{" "}
          页 · 计划 {sites.size} 站 · 实际 {actualSites.size} 站 ·
          未覆盖或未完成 {pending} 个单元
        </p>
        <p>
          活动累计费用上界 ¥{Number(u.costUpperBoundCny ?? 0).toFixed(2)} / ¥
          {p.limits.maxCostCny} · 剩余 ¥
          {Math.max(
            0,
            p.limits.maxCostCny - (u.costUpperBoundCny ?? 0),
          ).toFixed(2)}
        </p>
        <p>
          累计请求占额 {u.usedRequests ?? 0} / {p.limits.maxRequests} ·
          未结算占额 {u.reservedRequests ?? 0} · 流量占额{" "}
          {((u.usedBytes ?? 0) / 1048576).toFixed(2)} MB
        </p>
        <p className="text-sm text-muted-foreground">
          已核实物理请求 {u.knownPhysicalRequests ?? 0} · 未核实请求上界{" "}
          {u.unknownRequestUpperBound ?? 0}；每100次请求新增有效岗位：
          {u.unknownRequestUpperBound
            ? "分母未完全核实"
            : u.knownPhysicalRequests
              ? (
                  ((p.metrics?.validNewUnique ?? 0) * 100) /
                  u.knownPhysicalRequests
                ).toFixed(2)
              : "暂无请求"}
          。
          浏览器资源、重试、重定向和详情均计入；未知用量保留预约上界，不能当作实际成功请求数。分批继续不会重置费用。人工登录流量单列。
        </p>
        <p>
          本版本新增记录 {p.metrics?.newUnique ?? 0}{" "}
          条；达到分页或预算上限仍可能存在未覆盖岗位。
        </p>
        <p>
          有效新增且不重复 {p.metrics?.validNewUnique ?? 0}{" "}
          条（正文、当前招聘、资格、投递入口全部通过）。
        </p>
        {activity.quality && (
          <section
            aria-label="本活动岗位质量"
            className="grid gap-2 rounded-lg border p-3 text-sm"
          >
            <p>
              正文已核验 {activity.quality.bodyVerified} /{" "}
              {activity.quality.uniqueRecords} · 当前招聘{" "}
              {activity.quality.open} / {activity.quality.uniqueRecords} ·
              投递入口已核验 {activity.quality.applicationAvailable} /{" "}
              {activity.quality.uniqueRecords}
            </p>
            <p>
              资格通过 {activity.quality.qualificationPass} /{" "}
              {activity.quality.uniqueRecords} · 待核实{" "}
              {activity.quality.qualificationUnknown} /{" "}
              {activity.quality.uniqueRecords} · 不符合{" "}
              {activity.quality.qualificationFail} /{" "}
              {activity.quality.uniqueRecords}
            </p>
            <p>
              历史或已截止 {activity.quality.historicalOrExpired} /{" "}
              {activity.quality.uniqueRecords} · 疑似重复{" "}
              {activity.quality.suspectedDuplicates} /{" "}
              {activity.quality.uniqueRecords}
            </p>
            <p>
              有效新增 {activity.quality.validNewUnique} / 已核实请求{" "}
              {activity.quality.knownRequests} · 每100次已核实请求{" "}
              {activity.quality.validPer100KnownRequests === null
                ? "未测量"
                : activity.quality.validPer100KnownRequests.toFixed(2)}{" "}
              · 未知请求上界 {activity.quality.unknownRequestUpperBound}
            </p>
            <p className="text-muted-foreground">
              分类可重叠，不能相加当作阶段转化率。召回率与误合并率：未测量。未知请求未进入已核实分母。
            </p>
          </section>
        )}
        {p.lastErrorCode && (
          <p role="status">
            停止原因：{p.lastErrorCode}；请在运行日志查看此活动。
          </p>
        )}
        {!readOnly && scope && (
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              name="activity-requests"
              label="活动请求上限"
              type="number"
              value={requests}
              onChange={setRequests}
              description="暂停后可调整，不能小于累计占额"
            />
            <TextField
              name="activity-cost"
              label="活动模型费用上限（元）"
              type="number"
              value={cost}
              onChange={setCost}
              description="最多10元，不能小于已用及未结算费用"
            />
            <Button
              variant="outline"
              disabled={op.busy || p.status !== "paused"}
              onClick={() =>
                void op.run(async () => {
                  await api.request(prefix + "/limits", {
                    method: "PUT",
                    scope,
                    body: {
                      expectedRevision: p.revision,
                      limits: {
                        ...p.limits,
                        maxRequests: Number(requests),
                        maxCostCny: Number(cost),
                      },
                    },
                  });
                  const next = await api.request<CollectionActivity>(prefix, {
                    scope,
                  });
                  if (live.current) onChanged?.(next);
                }, "活动额度已保存")
              }
            >
              保存活动额度
            </Button>
          </div>
        )}
        <OperationFeedback
          busy={op.busy}
          error={op.error}
          result={op.message}
        />
      </CardContent>
      {!readOnly && scope && (
        <CardFooter className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={op.busy || p.status !== "collecting"}
            onClick={() => void action("pause")}
          >
            暂停采集
          </Button>
          <Button
            disabled={
              op.busy ||
              !["paused", "waiting_for_auth", "budget_exhausted"].includes(
                p.status,
              )
            }
            onClick={() => void action("resume", p.replanRequired === true)}
          >
            {p.replanRequired ? "确认重新规划并继续" : "继续采集"}
          </Button>
          <Button
            variant="outline"
            disabled={op.busy || ["completed", "cancelled"].includes(p.status)}
            onClick={() => void action("cancel")}
          >
            取消活动
          </Button>
          <span className="text-sm text-muted-foreground">
            调整额度须先暂停；登录完成后继续并重新核验正文。
          </span>
        </CardFooter>
      )}
    </Card>
  );
}
