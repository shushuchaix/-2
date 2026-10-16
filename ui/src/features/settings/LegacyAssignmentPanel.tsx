import { useEffect, useState } from "react";
import type { ApiClient, Scope } from "../../lib/types";
import { useVersionContext } from "../../app/VersionContext";
import { useOperation } from "../../lib/hooks";
import { OperationFeedback } from "../../components/OperationFeedback";
import { RecordCounts } from "../../components/RecordCounts";
import { safeDiagnostic } from "../logs/DiagnosticDetails";
import { applicationLabels } from "../jobs/job-view";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../components/ui/select";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";

type LegacyRecord = {
  recordId: string;
  kind?: string;
  title?: string;
  ownerPackageId?: string;
  counts?: Record<string, number>;
};
type AssignmentPreview = {
  workspaceRevision: number;
  planHash: string;
  recordIds: string[];
  counts: Record<string, number>;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value : fallback;
const kindLabels: Record<string, string> = {
  application: "投递记录",
  applications: "投递记录",
  job: "岗位记录",
  jobs: "岗位记录",
  run: "检索任务",
  runs: "检索任务",
};

function LegacySummary({
  detail,
  record,
}: {
  detail: unknown;
  record: LegacyRecord;
}) {
  const closure = object(detail),
    root = object(closure.root ?? closure);
  const records = Array.isArray(closure.records)
    ? closure.records.map(object)
    : [];
  const owner = records.find(
    (item) => object(item.record).recordId === record.recordId,
  );
  const kind =
    record.kind ||
    text(owner?.collection, "") ||
    (root.applicationId
      ? "applications"
      : root.runId
        ? "runs"
        : root.jobId
          ? "jobs"
          : "");
  const job =
    kind === "jobs" || kind === "job"
      ? root
      : object(records.find((item) => item.collection === "jobs")?.record);
  const canonical = object(job.canonical);
  const date = root.updatedAt ?? root.createdAt ?? root.at;
  const counts = object(closure.counts ?? record.counts);
  return (
    <section aria-label="旧记录内容摘要" className="flex flex-col gap-3">
      <p>{kindLabels[kind] || "旧业务记录"}</p>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[
          ["岗位", canonical.title ?? job.title],
          [
            "企业",
            canonical.company ??
              canonical.organization ??
              job.company ??
              job.organization,
          ],
          ["来源", root.sourceName ?? job.sourceName],
          [
            "记录时间",
            typeof date === "string" && Number.isFinite(Date.parse(date))
              ? new Date(date).toLocaleString("sv-SE", { hour12: false })
              : undefined,
          ],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt className="text-sm text-muted-foreground">{String(label)}</dt>
            <dd>
              {text(value, label === "岗位" ? "岗位标题未提供" : "未提供")}
            </dd>
          </div>
        ))}
        {(kind === "applications" || kind === "application") && (
          <>
            <div>
              <dt className="text-sm text-muted-foreground">投递状态</dt>
              <dd>{applicationLabels[String(root.status)] || "状态未提供"}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">投递备注</dt>
              <dd className="whitespace-pre-wrap">
                {text(root.note, "暂无备注")}
              </dd>
            </div>
          </>
        )}
        {(kind === "runs" || kind === "run") && (
          <div>
            <dt className="text-sm text-muted-foreground">运行结果</dt>
            <dd>
              {(
                {
                  completed: "已完成",
                  partial: "部分完成",
                  failed: "失败",
                  cancelled: "已取消",
                } as Record<string, string>
              )[String(root.status)] || "状态未提供"}
            </dd>
          </div>
        )}
      </dl>
      <RecordCounts counts={counts} label="旧记录关联内容计数" />
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="outline" />}>
          技术详情
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <p>记录编号：{record.recordId}</p>
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(
              safeDiagnostic({ counts, jobId: root.jobId, runId: root.runId }),
              null,
              2,
            )}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export function LegacyAssignmentPanel({
  api,
  onChanged,
}: {
  api: ApiClient;
  onChanged?(): void | Promise<void>;
}) {
  const context = useVersionContext();
  const [records, setRecords] = useState<LegacyRecord[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<LegacyRecord | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [detail, setDetail] = useState<unknown>(null);
  const [preview, setPreview] = useState<{
    plan: AssignmentPreview;
    destination: Scope;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const op = useOperation();
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    api
      .request<{ records?: LegacyRecord[]; items?: LegacyRecord[] }>(
        "/legacy-records",
        { signal: controller.signal },
      )
      .then((data) => {
        if (live) {
          setRecords(data.records || data.items || []);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (live && !controller.signal.aborted) setLoadError(e);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, attempt]);
  useEffect(() => {
    setDetail(null);
    if (!selected) {
      return;
    }
    const controller = new AbortController();
    let live = true;
    api
      .request("/legacy-records/" + encodeURIComponent(selected.recordId), {
        signal: controller.signal,
      })
      .then((data) => {
        if (live) setDetail(data);
      })
      .catch((e) => {
        if (live && !controller.signal.aborted) setLoadError(e);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, selected]);
  const open = (record: LegacyRecord) => {
    op.clear();
    setLoadError(null);
    setSelected(record);
    setDestinationId(
      context.scope?.packageId || context.targets[0]?.packageId || "",
    );
    setPreview(null);
  };
  async function prepare() {
    if (!detail || loadError) return;
    const target = context.targets.find((t) => t.packageId === destinationId);
    if (!selected || !target) {
      setLoadError(new Error("请选择一个可用目标版本。"));
      return;
    }
    const destination = {
      packageId: target.packageId,
      targetRevisionId: target.revisionId,
    };
    await op.run(async () => {
      const plan = await api.request<AssignmentPreview>(
        "/legacy-records/assignment-preview",
        { method: "POST", body: { recordId: selected.recordId, destination } },
      );
      setPreview({ plan, destination });
    }, "归属移动预览已生成");
  }
  async function move() {
    if (!selected || !preview) return;
    const saved = await op.run(
      () =>
        api.request("/legacy-records/assign", {
          method: "POST",
          body: {
            ...preview.plan,
            recordId: selected.recordId,
            destination: preview.destination,
          },
        }),
      "旧记录已移动到所选目标",
    );
    if (saved) {
      setSelected(null);
      setPreview(null);
      setAttempt((v) => v + 1);
      await onChanged?.();
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>待归属旧数据</CardTitle>
        <CardDescription>
          历史投递不能猜测归属。检查记录和关联内容摘要后选择唯一目标移动，评价与事件随之移动。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <OperationFeedback error={loadError} result={op.message} />
        {records.length ? (
          records.map((record) => (
            <div
              key={record.recordId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
            >
              <div>
                <p>{record.title || "旧记录名称未提供"}</p>
                <p className="text-muted-foreground">
                  {kindLabels[record.kind || ""] || "旧业务记录及关联内容"}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => open(record)}
                aria-label={"分配" + (record.title || "旧记录名称未提供")}
              >
                查看并分配
              </Button>
            </div>
          ))
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有待归属记录</EmptyTitle>
              <EmptyDescription>
                已明确归属的历史保留在对应版本内。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={() => setAttempt((v) => v + 1)}>
          刷新待归属记录
        </Button>
      </CardFooter>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(value) => {
          if (!value && !op.busy) {
            setSelected(null);
            setPreview(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>检查旧记录并分配</DialogTitle>
            <DialogDescription>
              一次只能移动到一个目标，不能分配到“全部目标”。
            </DialogDescription>
          </DialogHeader>
          <OperationFeedback error={op.error || loadError} busy={op.busy} />
          {selected && Boolean(detail) && !loadError && (
            <LegacySummary detail={detail} record={selected} />
          )}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="assignmentDestination">
                唯一目标版本
              </FieldLabel>
              <Select
                value={destinationId}
                disabled={op.busy}
                onValueChange={(value) => {
                  setDestinationId(value || "");
                  setPreview(null);
                  op.clear();
                }}
              >
                <SelectTrigger
                  id="assignmentDestination"
                  aria-label="唯一目标版本"
                >
                  <SelectValue placeholder="请选择目标" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {context.targets.map((target) => (
                      <SelectItem
                        key={target.packageId}
                        value={target.packageId}
                      >
                        {target.versionName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          {preview && (
            <div>
              <p>
                将整份记录移入：
                {
                  context.targets.find(
                    (t) => t.packageId === preview.destination.packageId,
                  )?.versionName
                }
              </p>
              <RecordCounts
                counts={preview.plan.counts}
                label="归属移动内容计数"
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={op.busy}
              onClick={() => {
                setSelected(null);
                setPreview(null);
              }}
            >
              取消
            </Button>
            {preview ? (
              <Button disabled={op.busy} onClick={() => void move()}>
                确认移动到此目标
              </Button>
            ) : (
              <Button
                disabled={
                  op.busy || !destinationId || !detail || Boolean(loadError)
                }
                onClick={() => void prepare()}
              >
                预览归属移动
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
