import { useState } from "react";
import type { ApiClient, Scope } from "../../lib/types";
import { useQuery, useOperation } from "../../lib/hooks";
import { useVersionContext } from "../../app/VersionContext";
import { useCollectionActivity } from "../../app/CollectionContext";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../components/ui/tabs";
import { Button, buttonVariants } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { FormFeedback } from "../../components/FormFeedback";
import { OperationFeedback } from "../../components/OperationFeedback";
import { ApplicationEditor } from "../applications/ApplicationEditor";
import { EvaluationDetails } from "./EvaluationDetails";
import { RecruitmentEvidence } from "./RecruitmentEvidence";
import { EvidenceSummary } from "./EvidenceSummary";
import { evidenceView } from "./evidence-view";
import {
  factOf,
  qualificationOf,
  recommendationOf,
  type JobItem,
} from "./job-view";
import { safeExternalUrl, formatSalary } from "../../../../public/js/format.js";

export function JobDetailsSheet({
  api,
  jobId,
  scope,
  onClose,
  onChanged,
}: {
  api: ApiClient;
  jobId: string;
  scope: Scope;
  onClose(): void;
  onChanged?(): void;
}) {
  const query = useQuery<JobItem>(
    api,
    "/jobs/" + encodeURIComponent(jobId),
    scope,
  );
  const op = useOperation();
  const collections = useCollectionActivity();
  const activity = collections.activity;
  const [editing, setEditing] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "verify" | "evaluate" | null
  >(null);
  const { targets } = useVersionContext();
  const target = targets.find(
    (t) =>
      t.packageId === scope.packageId &&
      t.revisionId === scope.targetRevisionId,
  );
  const row = query.data;
  const fact = row ? factOf(row) : null;
  const view = row ? evidenceView(row) : null;
  const sourceUrl = safeExternalUrl(fact?.url);
  const requestLimit =
    activity?.collectionProgress.limits.maxRequests ??
    activity?.collectionUsage?.maxRequests;
  const usedRequests = activity?.collectionUsage?.usedRequests;
  const noRequestAllowance =
    typeof requestLimit === "number" &&
    (requestLimit === 0 ||
      (typeof usedRequests === "number" && usedRequests >= requestLimit));
  const verifyUnavailable = !activity
    ? collections.loading
      ? "正在读取本版本采集活动。"
      : collections.error
        ? "本版本活动读取失败，请在工作台重试。"
        : "请先到工作台创建本版本采集活动后核验。"
    : ["completed", "cancelled"].includes(activity.collectionProgress.status)
      ? "本版本采集活动已结束，请在工作台创建新活动后核验。"
      : noRequestAllowance
        ? "本版本活动的采集请求额度已用尽，核验需使用剩余额度。"
        : null;
  const missing =
    view?.items
      .filter((item) => item.state !== "verified")
      .map((item) => item.reason || item.label) || [];
  async function verify() {
    if (op.busy || verifyUnavailable || !activity) return;
    setPendingAction("verify");
    await op.run(async () => {
      await api.request("/jobs/" + encodeURIComponent(jobId) + "/verify", {
        method: "POST",
        scope,
        body: { activityId: activity.runId },
      });
      query.refresh();
      onChanged?.();
      await collections.refresh();
    }, "岗位正文与投递入口核验已完成");
  }
  async function evaluate() {
    if (op.busy) return;
    setPendingAction("evaluate");
    await op.run(async () => {
      await api.request("/jobs/" + encodeURIComponent(jobId) + "/evaluations", {
        method: "POST",
        scope,
        body: {
          mode: "rules",
          ...(target?.profileSnapshot?.revisionId
            ? { profileRevisionId: target.profileSnapshot.revisionId }
            : {}),
        },
      });
      query.refresh();
      onChanged?.();
    }, "岗位已按规则重新评价");
  }
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent className="flex flex-col gap-4 overflow-y-auto p-6 sm:!max-w-3xl">
          <SheetHeader>
            <SheetTitle>{fact?.title ?? "岗位详情"}</SheetTitle>
            <SheetDescription>
              {target?.versionName ?? "当前目标版本"} ·
              本版本事实、评价与投递记录
            </SheetDescription>
          </SheetHeader>
          <FormFeedback error={query.error} />
          {query.loading && <Skeleton className="h-24 w-full" />}
          {row && fact && view && (
            <>
              <p>{fact.organization ?? fact.company ?? "单位待核实"}</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                <dt>城市</dt>
                <dd>{fact.cities?.join("、") || "待核实"}</dd>
                <dt>薪资</dt>
                <dd>{formatSalary(fact.salary)}</dd>
                <dt>截止日期</dt>
                <dd>{fact.deadline ?? "待核实"}</dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{qualificationOf(row)}</Badge>
              </div>
              <EvidenceSummary view={view} />
              <section aria-label="岗位操作" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {view.entryUrl && view.entryLabel && (
                    <a
                      data-slot="button"
                      className={buttonVariants({ variant: "outline" })}
                      href={view.entryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {view.entryLabel}
                    </a>
                  )}
                  <Button onClick={() => setEditing(true)}>记录投递</Button>
                  <Button
                    variant="outline"
                    disabled={op.busy || Boolean(verifyUnavailable)}
                    onClick={() => void verify()}
                  >
                    {op.busy && pendingAction === "verify"
                      ? "正在核验正文与入口…"
                      : "核验正文与投递入口"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={op.busy}
                    onClick={() => void evaluate()}
                  >
                    {op.busy && pendingAction === "evaluate"
                      ? "正在按规则评价…"
                      : "规则重新评价"}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  {verifyUnavailable ||
                    "核验沿用本版本根活动的累计额度；暂停后的核验也不会重置账本，具体额度以服务检查为准。"}
                </p>
                <OperationFeedback
                  result={op.message}
                  busy={op.busy}
                  error={op.error}
                  busyLabel={
                    pendingAction === "verify"
                      ? "正在核验岗位正文与投递入口…"
                      : "正在按规则重新评价…"
                  }
                />
              </section>
              <p className="text-sm text-muted-foreground">
                服务评价：{recommendationOf(row)}
                {missing.length
                  ? "；证据不足：" + missing.join("、")
                  : "；四项证据状态请结合核验时间复查。"}
              </p>
              <p className="text-sm text-muted-foreground">
                辅助评分：
                {typeof row.evaluation?.score === "number"
                  ? row.evaluation.score + " 分"
                  : "未提供"}
              </p>
              <Tabs defaultValue="original">
                <TabsList>
                  <TabsTrigger value="original">岗位原文</TabsTrigger>
                  <TabsTrigger value="evaluation">评价依据</TabsTrigger>
                  <TabsTrigger value="history">来源与核验历史</TabsTrigger>
                </TabsList>
                <TabsContent value="original" className="flex flex-col gap-4">
                  <p className="whitespace-pre-wrap break-words">
                    {fact.description ?? "请通过来源链接查看完整公告。"}
                  </p>
                  {sourceUrl && (
                    <a
                      data-slot="button"
                      className={buttonVariants({ variant: "outline" })}
                      href={sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      查看公开来源
                    </a>
                  )}
                </TabsContent>
                <TabsContent value="evaluation" className="flex flex-col gap-4">
                  {row.evaluation ? (
                    <section className="flex flex-col gap-3">
                      <h2>当前评价依据</h2>
                      <EvaluationDetails evaluation={row.evaluation} />
                    </section>
                  ) : (
                    <p>本版本尚无岗位评价。</p>
                  )}
                </TabsContent>
                <TabsContent value="history" className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    {row.fact?.status === "verified"
                      ? "已保存本版本事实依据；招聘时效和条件以以下证据为准。"
                      : "本版本事实尚待核实，历史评价请结合当时依据查看。"}
                  </p>
                  <RecruitmentEvidence row={row} />
                  <section className="flex flex-col gap-3">
                    <h2>来源观察</h2>
                    {row.observations?.length ? (
                      row.observations.map((observation, index) => (
                        <p key={String(observation.observationId ?? index)}>
                          {String(
                            observation.sourceName ??
                              observation.sourceId ??
                              "公开来源",
                          )}{" "}
                          · {String(observation.observedAt ?? "时间待核实")}
                        </p>
                      ))
                    ) : (
                      <p>本版本暂无来源观察。</p>
                    )}
                  </section>
                  <section className="flex flex-col gap-3">
                    <h2>评价历史</h2>
                    {row.evaluations?.length ? (
                      row.evaluations.map((evaluation, index) => (
                        <div
                          key={String(evaluation.evaluationId ?? index)}
                          className="rounded-md border p-3"
                        >
                          <p>
                            {String(evaluation.score ?? "未提供")} 分 ·{" "}
                            {evaluation.matchesCurrentFact
                              ? "当前事实对应评价"
                              : "历史事实对应评价"}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {String(
                              evaluation.createdAt ??
                                evaluation.evaluatedAt ??
                                "时间待核实",
                            )}
                          </p>
                          <EvaluationDetails evaluation={evaluation} />
                        </div>
                      ))
                    ) : (
                      <p>本版本尚无评价历史。</p>
                    )}
                  </section>
                </TabsContent>
              </Tabs>
            </>
          )}
        </SheetContent>
      </Sheet>
      {editing && row && (
        <ApplicationEditor
          api={api}
          applicationId={row.application?.applicationId}
          jobId={jobId}
          scope={scope}
          initial={row.application}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            query.refresh();
            onChanged?.();
          }}
        />
      )}
    </>
  );
}
