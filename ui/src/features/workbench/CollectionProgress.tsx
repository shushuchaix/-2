import { useEffect, useRef, useState } from "react";
import type { ApiClient, Scope, CollectionActivity } from "../../lib/types";
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
import { BudgetSummary } from "../../components/BudgetSummary";
import { budgetView } from "../../lib/budget-view";
import { deriveActivityView, activityLabels } from "./activity-view";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible";
import { validateCollectionLimits } from "../../../../public/js/validation-rules.js";
import { FormFeedback } from "../../components/FormFeedback";
import { toast } from "../../components/ui/toast";
export type { CollectionActivity } from "../../lib/types";
export const collectionStatus = activityLabels;
const stat = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : "未统计";
export function CollectionProgress({
  activity,
  api,
  scope,
  onChanged,
  readOnly = false,
  mode = "rules",
  userKey = "",
  onKeyUsed,
  slice,
}: {
  activity: CollectionActivity;
  api: ApiClient;
  scope?: Scope;
  onChanged?(a: CollectionActivity): void;
  readOnly?: boolean;
  mode?: string;
  userKey?: string;
  onKeyUsed?(): void;
  slice?: Record<string, unknown> | null;
}) {
  const p = activity.collectionProgress,
    u = activity.collectionUsage ?? {},
    op = useOperation(),
    live = useRef(true);
  const [requests, setRequests] = useState(
      p.limits.maxRequests === undefined ? "" : String(p.limits.maxRequests),
    ),
    [cost, setCost] = useState(
      p.limits.maxCostCny === undefined ? "" : String(p.limits.maxCostCny),
    );
  const view = deriveActivityView(activity, slice ?? null);
  const [limitErrors, setLimitErrors] = useState<Record<string, string>>({});
  const pendingStop = useRef<"pause" | "cancel" | null>(null);
  const [stopMessage, setStopMessage] = useState("");
  const quality = activity.quality;
  const phases: Record<string, string> = {
    collecting: "采集岗位",
    collect: "采集岗位",
    details: "读取招聘详情",
    expanding: "整理与扩展岗位",
    evaluating: "评价岗位匹配",
    finished: "更新结束",
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    const kind = pendingStop.current;
    if (
      !kind ||
      p.draining ||
      p.status !== (kind === "pause" ? "paused" : "cancelled")
    )
      return;
    const message = kind === "pause" ? "活动已暂停" : "活动已取消";
    pendingStop.current = null;
    setStopMessage(message);
    toast.add({ type: "success", title: message });
  }, [p.draining, p.status]);
  const units = Object.values(p.units ?? {}),
    completeLegacyUnits = p.units !== undefined && p.unitPage?.hasMore !== true,
    siteKey = (unit: (typeof units)[number]) => JSON.stringify([unit.sourceId ?? null, unit.siteId]),
    plannedSites = p.unitSummary?.plannedSites ?? (completeLegacyUnits ? new Set(units.map(siteKey)).size : undefined),
    actualSites = p.unitSummary?.actualSites ?? (completeLegacyUnits ? new Set(units.filter((unit) => unit.committedPages > 0).map(siteKey)).size : undefined),
    pending = p.unitSummary?.pendingUnits ?? (completeLegacyUnits ? units.filter((unit) => unit.status !== "completed").length : undefined);
  const prefix = "/collections/" + encodeURIComponent(activity.runId);
  async function action(kind: string, replan = false) {
    if (!scope || op.busy) return;
    setStopMessage("");
    if (kind === "pause" || kind === "cancel") pendingStop.current = kind;
    const ok = await op.run(
      async () => {
        const receipt = await api.request<Partial<CollectionActivity>>(
          prefix + "/" + kind,
          {
            method: "POST",
            scope,
            body:
              kind === "resume"
                ? {
                    requestId: crypto.randomUUID(),
                    ...(replan ? { replan: true } : {}),
                    mode,
                    ...(mode === "ai" && userKey
                      ? { userApiKey: userKey }
                      : {}),
                  }
                : {},
          },
        );
        if (kind === "resume") onKeyUsed?.();
        const next = receipt.collectionProgress
          ? (receipt as CollectionActivity)
          : await api.request<CollectionActivity>(prefix, { scope });
        if (live.current) onChanged?.(next);
      },
      kind === "resume" ? "已继续采集，沿用活动累计额度" : "",
    );
    if (!ok) pendingStop.current = null;
  }
  return (
    <Card role="region" aria-label={readOnly ? "历史采集活动" : "当前采集活动"}>
      <CardHeader>
        <CardTitle>持续采集活动</CardTitle>
        <CardDescription>
          <Badge variant="secondary">{view.label}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {view.phase && <p>阶段：{phases[view.phase] ?? view.phase}</p>}
        {p.replanRequired && (
          <p role="status">
            来源或查询已变化，请确认重新规划。沿用当前活动，累计用量和10元费用上限保留。
          </p>
        )}
        <p>
          已提交{" "}
          {stat(p.metrics?.committedPages ??
            (completeLegacyUnits ? units.reduce((n, x) => n + x.committedPages, 0) : undefined))}{" "}
          页 · 计划 {stat(plannedSites)} 站 · 实际 {stat(actualSites)} 站 ·
          未覆盖或未完成 {stat(pending)} 个单元
        </p>
        <BudgetSummary
          view={budgetView({ activity })}
          label="活动预算与累计用量"
        />
        <p>
          本版本新增记录 {stat(p.metrics?.newUnique)}{" "}
          条；达到分页或预算上限仍可能存在未覆盖岗位。
        </p>
        <p>
          有效新增且不重复 {stat(p.metrics?.validNewUnique)}{" "}
          条（正文、当前招聘、资格、投递入口全部通过）。
        </p>
        {
          <section
            aria-label="本活动岗位质量"
            className="grid gap-2 rounded-lg border p-3 text-sm"
          >
            <p>
              正文已核验 {stat(quality?.bodyVerified)} /{" "}
              {stat(quality?.uniqueRecords)} · 当前招聘 {stat(quality?.open)} /{" "}
              {stat(quality?.uniqueRecords)} · 投递入口已核验{" "}
              {stat(quality?.applicationAvailable)} /{" "}
              {stat(quality?.uniqueRecords)}
            </p>
            <p>
              资格通过 {stat(quality?.qualificationPass)} /{" "}
              {stat(quality?.uniqueRecords)} · 待核实{" "}
              {stat(quality?.qualificationUnknown)} /{" "}
              {stat(quality?.uniqueRecords)} · 不符合{" "}
              {stat(quality?.qualificationFail)} /{" "}
              {stat(quality?.uniqueRecords)}
            </p>
            <p>
              历史或已截止 {stat(quality?.historicalOrExpired)} /{" "}
              {stat(quality?.uniqueRecords)} · 疑似重复{" "}
              {stat(quality?.suspectedDuplicates)} /{" "}
              {stat(quality?.uniqueRecords)}
            </p>
            <p>
              有效新增 {stat(quality?.validNewUnique)} / 已核实请求{" "}
              {stat(quality?.knownRequests)} · 每100次已核实请求{" "}
              {typeof quality?.validPer100KnownRequests !== "number" ||
              !Number.isFinite(quality.validPer100KnownRequests)
                ? "未测量"
                : quality.validPer100KnownRequests.toFixed(2)}{" "}
              · 未知请求上界 {stat(quality?.unknownRequestUpperBound)}
            </p>
            <p className="text-muted-foreground">
              分类可重叠，不能相加当作阶段转化率。召回率与误合并率：未测量。未知请求未进入已核实分母。
            </p>
          </section>
        }
        {p.lastErrorCode && (
          <p role="status">
            停止原因：{p.lastErrorCode}；请在运行日志查看此活动。
          </p>
        )}
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" />}>
            高级计数与额度
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-4 pt-4">
            <p>活动编号：{activity.runId}</p>
            <p>
              累计请求占额 {stat(u.usedRequests)} / {stat(p.limits.maxRequests)}{" "}
              · 未结算占额 {stat(u.reservedRequests)} · 已核实物理请求{" "}
              {stat(u.knownPhysicalRequests)} · 未核实请求上界{" "}
              {stat(u.unknownRequestUpperBound)}
            </p>
            <p className="text-sm text-muted-foreground">
              浏览器资源、重试、重定向和详情均计入；未知用量保留预约上界，人工登录流量单列。
            </p>
            <p>
              详情占额 {stat(u.usedDetails)} / {stat(p.limits.maxDetails)} ·
              附件占额 {stat(u.usedAttachments)} /{" "}
              {stat(p.limits.maxAttachments)}
            </p>
            <p>
              累计字节占额 {stat(u.usedBytes)} /{" "}
              {stat(p.limits.maxTotalAttachmentBytes)} 字节
            </p>
            <p className="text-sm text-muted-foreground">
              请求次数、详情、附件和字节各自受限。失败或未确认完成的请求保留用量上界；请求次数仍有余额也可能达到字节上限。
            </p>
            {!readOnly && scope && (
              <div className="grid gap-4 md:grid-cols-2">
                <TextField
                  name="activity-requests"
                  label="活动请求上限"
                  type="number"
                  value={requests}
                  onChange={(v) => {
                    setRequests(v);
                    setLimitErrors({});
                  }}
                  error={limitErrors["activity-requests"]}
                  description="暂停后可调整，不能小于累计占额"
                />
                <TextField
                  name="activity-cost"
                  label="活动模型费用上限（元）"
                  type="number"
                  value={cost}
                  onChange={(v) => {
                    setCost(v);
                    setLimitErrors({});
                  }}
                  error={limitErrors["activity-cost"]}
                  description="最多10元，不能小于已用及未结算费用"
                />
                <Button
                  variant="outline"
                  disabled={op.busy || p.draining || p.status !== "paused"}
                  onClick={() => {
                    const errors: Record<string, string> = {};
                    if (!/^\d+$/.test(requests))
                      errors["activity-requests"] =
                        "请填写有效的请求上限整数。";
                    if (
                      (Object.hasOwn(p.limits, "maxCostCny") || cost !== "") &&
                      !/^\d+(?:\.\d{1,2})?$/.test(cost)
                    )
                      errors["activity-cost"] =
                        "请填写0–10元费用上限，最多两位小数。";
                    const limits = {
                      ...p.limits,
                      maxRequests: Number(requests),
                      ...(cost !== "" ? { maxCostCny: Number(cost) } : {}),
                    };
                    try {
                      validateCollectionLimits(limits);
                    } catch (e) {
                      const fields =
                        (e as { fieldErrors?: Record<string, string> })
                          .fieldErrors ?? {};
                      if (fields.maxRequests)
                        errors["activity-requests"] = fields.maxRequests;
                      if (fields.maxCostCny)
                        errors["activity-cost"] = fields.maxCostCny;
                    }
                    setLimitErrors(errors);
                    if (Object.keys(errors).length) return;
                    void op.run(async () => {
                      await api.request(prefix + "/limits", {
                        method: "PUT",
                        scope,
                        body: {
                          expectedRevision: p.revision,
                          limits,
                        },
                      });
                      const next = await api.request<CollectionActivity>(
                        prefix,
                        {
                          scope,
                        },
                      );
                      if (live.current) onChanged?.(next);
                    }, "活动额度已保存");
                  }}
                >
                  保存活动额度
                </Button>
              </div>
            )}
            <FormFeedback errors={limitErrors} />
          </CollapsibleContent>
        </Collapsible>
        <OperationFeedback
          busy={op.busy}
          error={op.error}
          result={p.draining ? view.label : stopMessage || op.message}
        />
      </CardContent>
      {!readOnly && scope && (
        <CardFooter className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={op.busy || p.draining || p.status !== "collecting"}
            onClick={() => void action("pause")}
          >
            暂停采集
          </Button>
          <Button
            disabled={
              op.busy ||
              p.draining ||
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
            disabled={
              op.busy ||
              (p.draining && p.stopIntent === "cancel") ||
              ["completed", "cancelled"].includes(p.status)
            }
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
