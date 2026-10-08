import { useState } from "react";
import type { ApiClient, Scope } from "../../lib/types";
import { useQuery, useOperation } from "../../lib/hooks";
import { useVersionContext } from "../../app/VersionContext";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { FormFeedback } from "../../components/FormFeedback";
import { OperationFeedback } from "../../components/OperationFeedback";
import { ApplicationEditor } from "../applications/ApplicationEditor";
import { EvaluationDetails } from "./EvaluationDetails";
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
  onClose: () => void;
  onChanged?: () => void;
}) {
  const query = useQuery<JobItem>(
    api,
    "/jobs/" + encodeURIComponent(jobId),
    scope,
  );
  const op = useOperation();
  const [editing, setEditing] = useState(false);
  const { targets } = useVersionContext();
  const target = targets.find((t) => t.packageId === scope.packageId);
  const row = query.data;
  const fact = row ? factOf(row) : null;
  const sourceUrl = safeExternalUrl(fact?.url),
    applyUrl = safeExternalUrl(fact?.applyUrl);
  return (
    <>
      <Sheet
        open
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <SheetContent className="flex flex-col gap-4 overflow-y-auto p-6 sm:!max-w-xl">
          <SheetHeader>
            <SheetTitle>{fact?.title ?? "岗位详情"}</SheetTitle>
            <SheetDescription>
              {target?.versionName ?? "当前目标版本"} ·
              本版本事实、评价与投递记录
            </SheetDescription>
          </SheetHeader>
          <FormFeedback error={query.error} />
          {query.loading && <Skeleton className="h-24 w-full" />}
          {row && fact && (
            <>
              <p>{fact.organization ?? fact.company ?? "单位待核实"}</p>
              <div className="flex flex-wrap gap-2">
                <Badge>{qualificationOf(row)}</Badge>
                <Badge variant="secondary">{recommendationOf(row)}</Badge>
                <Badge variant="outline">
                  {row.evaluation?.score ?? "—"} 分
                </Badge>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-4">
                <dt>薪资</dt>
                <dd>{formatSalary(fact.salary)}</dd>
                <dt>城市</dt>
                <dd>{fact.cities?.join("、") ?? "待核实"}</dd>
                <dt>截止日期</dt>
                <dd>{fact.deadline ?? "待核实"}</dd>
                <dt>招聘原文</dt>
                <dd className="whitespace-pre-wrap">
                  {fact.description ?? "请通过来源链接查看完整公告。"}
                </dd>
              </dl>
              {sourceUrl && (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  查看公开来源
                </a>
              )}
              {applyUrl && (
                <a
                  href={applyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  前往投递
                </a>
              )}
              <p className="text-sm text-muted-foreground">
                {row.fact?.status === "verified"
                  ? "本版本招聘事实已核实"
                  : "本版本事实尚待核实，历史评价请结合当时依据查看。"}
              </p>
              {row.evaluation && (
                <section className="flex flex-col gap-3">
                  <h2 className="font-semibold">当前评价依据</h2>
                  <EvaluationDetails evaluation={row.evaluation} />
                </section>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setEditing(true)}>记录投递</Button>
                <Button
                  variant="outline"
                  disabled={op.busy}
                  onClick={() =>
                    void op.run(async () => {
                      await api.request(
                        "/jobs/" + encodeURIComponent(jobId) + "/evaluations",
                        {
                          method: "POST",
                          scope,
                          body: {
                            mode: "rules",
                            ...(target?.profileSnapshot?.revisionId
                              ? {
                                  profileRevisionId:
                                    target.profileSnapshot.revisionId,
                                }
                              : {}),
                          },
                        },
                      );
                      query.refresh();
                      onChanged?.();
                    }, "岗位已按规则重新评价")
                  }
                >
                  规则重新评价
                </Button>
              </div>
              <OperationFeedback
                result={op.message}
                busy={op.busy}
                error={op.error}
              />
              <section className="flex flex-col gap-3">
                <h2 className="font-semibold">来源观察</h2>
                {row.observations?.length ? (
                  row.observations.map((o, i) => (
                    <p key={String(o.observationId ?? i)}>
                      {String(o.sourceName ?? o.sourceId ?? "公开来源")} ·{" "}
                      {String(o.observedAt ?? "时间待核实")}
                    </p>
                  ))
                ) : (
                  <p>本版本暂无来源观察。</p>
                )}
              </section>
              <section className="flex flex-col gap-3">
                <h2 className="font-semibold">评价历史</h2>
                {row.evaluations?.length ? (
                  row.evaluations.map((e, i) => (
                    <div
                      key={String(e.evaluationId ?? i)}
                      className="rounded-md border p-3"
                    >
                      <p>
                        {String(e.score ?? "—")} 分 ·{" "}
                        {e.matchesCurrentFact
                          ? "当前事实对应评价"
                          : "历史事实对应评价"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {String(e.createdAt ?? e.evaluatedAt ?? "时间待核实")}
                      </p>
                      <EvaluationDetails evaluation={e} />
                    </div>
                  ))
                ) : (
                  <p>本版本尚无评价历史。</p>
                )}
              </section>
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
