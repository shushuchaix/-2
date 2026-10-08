import { useEffect, useState } from "react";
import type { ApiClient, Scope } from "../../lib/types";
import { useVersionContext } from "../../app/VersionContext";
import { useOperation } from "../../lib/hooks";
import { OperationFeedback } from "../../components/OperationFeedback";
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
};
type AssignmentPreview = {
  workspaceRevision: number;
  planHash: string;
  recordIds: string[];
  counts: Record<string, number>;
};

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
          历史投递不能猜测归属。检查整份记录后选择唯一目标移动，评价与事件随之移动。
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
                <p>{record.title || record.recordId}</p>
                <p className="text-muted-foreground">
                  {record.kind || "旧业务记录"}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => open(record)}
                aria-label={"分配" + (record.title || record.recordId)}
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
          <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap break-all">
            {JSON.stringify(detail || selected, null, 2)}
          </pre>
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
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(preview.plan.counts, null, 2)}
              </pre>
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
