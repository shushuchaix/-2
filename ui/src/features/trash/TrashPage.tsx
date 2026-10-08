import { useEffect, useState } from "react";
import type {
  ApiClient,
  Counts,
  PackageKind,
  Preview,
  PurgeResult,
} from "../../lib/types";
import { useVersionContext } from "../../app/VersionContext";
import { useOperation } from "../../lib/hooks";
import { OperationFeedback } from "../../components/OperationFeedback";
import { TextField } from "../../components/TextField";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { FieldGroup } from "../../components/ui/field";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { PurgeConfirmDialog } from "./PurgeConfirmDialog";
import { TrashDetailsSheet } from "./TrashDetailsSheet";

type TrashRow = {
  packageId: string;
  kind: PackageKind;
  state: string;
  status?: string;
  versionName?: string;
  archiveId?: string | null;
  archivedAt?: string | null;
  purgeAt?: string | null;
  counts: Counts;
  operationId?: string;
  phase?: string;
  code?: string;
  nextRetryAt?: string;
};
const kindLabels: Record<PackageKind, string> = {
  target: "目标版本",
  profile: "简历版本",
  legacy_unassigned: "待归属旧数据",
};
const date = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN")
    : "旧删除时间不可确认";
function state(row: TrashRow, now: number) {
  if (row.state === "purge_pending") return "pending";
  if (
    row.state !== "trashed" ||
    row.status === "expired" ||
    !row.purgeAt ||
    !Number.isFinite(Date.parse(row.purgeAt)) ||
    Date.parse(row.purgeAt) <= now
  )
    return "expired";
  return "unexpired";
}

export function TrashPage({ api }: { api: ApiClient }) {
  const context = useVersionContext();
  const [rows, setRows] = useState<TrashRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [oldest, setOldest] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [details, setDetails] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [stale, setStale] = useState(false);
  const [result, setResult] = useState<PurgeResult | null>(null);
  const [reason, setReason] = useState<"manual" | "empty">("manual");
  const op = useOperation();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);
    api
      .request<{ items?: TrashRow[]; packages?: TrashRow[] }>("/trash", {
        signal: controller.signal,
      })
      .then((value) => {
        if (live) {
          setRows(
            (value.items || value.packages || []).filter((r) =>
              ["trashed", "purge_pending"].includes(r.state),
            ),
          );
          setError(null);
        }
      })
      .catch((e) => {
        if (live && !controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, attempt]);
  useEffect(() => {
    const operations = [
      ...new Set(
        rows
          .filter((row) => row.state === "purge_pending" && row.operationId)
          .map((row) => row.operationId!),
      ),
    ];
    if (!operations.length) return;
    const controller = new AbortController();
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const updates = await Promise.allSettled(
        operations.map((operationId) =>
          api.request<{
            operationId: string;
            phase: string;
            counts: Counts;
            code?: string;
            nextRetryAt?: string;
          }>("/trash/operations/" + encodeURIComponent(operationId), {
            signal: controller.signal,
          }),
        ),
      );
      if (!live) return;
      let completed = false;
      for (const update of updates)
        if (update.status === "fulfilled" && update.value) {
          const task = update.value;
          if (["purged", "completed"].includes(task.phase)) completed = true;
          else
            setRows((items) =>
              items.map((row) =>
                row.operationId === task.operationId
                  ? {
                      ...row,
                      phase: task.phase,
                      code: task.code,
                      nextRetryAt: task.nextRetryAt,
                      counts: task.counts || row.counts,
                    }
                  : row,
              ),
            );
        }
      if (completed) {
        setAttempt((v) => v + 1);
        void context.refresh();
      } else timer = setTimeout(() => void poll(), 5000);
    }
    timer = setTimeout(() => void poll(), 5000);
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, rows.map((row) => row.operationId || "").join(",")]);
  const visible = rows
    .filter(
      (row) =>
        (filter === "all" || row.kind === filter) &&
        (state(row, now) === "pending"
          ? row.operationId || ""
          : row.versionName || ""
        )
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        ((Date.parse(a.archivedAt || "") || 0) -
          (Date.parse(b.archivedAt || "") || 0)) *
        (oldest ? 1 : -1),
    );
  const detailRow = rows.find((row) => row.packageId === details);
  async function prepare(packageIds?: string[]) {
    if (op.busy) return;
    setStale(false);
    setResult(null);
    setReason(packageIds ? "manual" : "empty");
    await op.run(async () => {
      const plan = await api.request<Preview>("/trash/preview", {
        method: "POST",
        body: packageIds ? { packageIds } : { emptyAll: true },
      });
      setPreview(plan);
    }, "永久清理预览已生成");
  }
  async function purge() {
    if (!preview || stale) return;
    const committed = await op.run(async () => {
      const saved = await api.request<PurgeResult>("/trash/purge", {
        method: "POST",
        body: preview,
      });
      setResult(saved);
      setRows((items) =>
        items.filter((row) => !saved.completed.includes(row.packageId)),
      );
      setDetails(null);
      setPreview(null);
    }, "");
    if (committed) {
      setAttempt((v) => v + 1);
      await context.refresh();
    } else setStale(true);
  }
  async function restore(row: TrashRow) {
    if (state(row, Date.now()) !== "unexpired") {
      setError(new Error("此版本已到期，不能恢复；请刷新回收站查看清理状态。"));
      setDetails(null);
      return;
    }
    const committed = await op.run(
      () =>
        api.request("/trash/restore", {
          method: "POST",
          body: { packageId: row.packageId, archiveId: row.archiveId },
        }),
      "已恢复整个版本",
    );
    if (committed) {
      setRows((items) =>
        items.filter((item) => item.packageId !== row.packageId),
      );
      setDetails(null);
      setAttempt((v) => v + 1);
      await context.refresh();
    }
  }
  const summary = result
    ? "已完成 " +
      result.completed.length +
      "，处理中 " +
      result.pending.length +
      "，失败 " +
      result.failed.length
    : "";
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>回收站</h1>
          <p className="text-muted-foreground">
            移入后保留 72 小时。运行期间每五分钟检查，关闭后下次启动补清理。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={loading || op.busy}
            onClick={() => setAttempt((v) => v + 1)}
          >
            刷新回收站
          </Button>
          <Button
            variant="destructive"
            disabled={loading || op.busy || !rows.length}
            onClick={() => void prepare()}
          >
            清空整个回收站
          </Button>
        </div>
      </header>
      <Tabs value={filter} onValueChange={(v) => setFilter(String(v))}>
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="target">目标版本</TabsTrigger>
          <TabsTrigger value="profile">简历版本</TabsTrigger>
          <TabsTrigger value="legacy_unassigned">待归属旧数据</TabsTrigger>
        </TabsList>
      </Tabs>
      <FieldGroup>
        <TextField
          name="trashSearch"
          label="搜索回收站"
          value={search}
          onChange={setSearch}
        />
      </FieldGroup>
      <Button variant="outline" onClick={() => setOldest((v) => !v)}>
        {oldest ? "最早移入优先" : "最近移入优先"}
      </Button>
      <OperationFeedback
        busy={op.busy}
        error={error || (!preview && op.error)}
        result={op.message}
      />
      {result && (
        <div role="status" className="flex flex-col gap-2">
          <p>{summary}</p>
          {!result.pending.length && !result.failed.length && (
            <p>永久删除完成</p>
          )}
          {result.pending.length > 0 && (
            <p>部分版本已停止访问，清理待重试；所有文件完成后才释放名称。</p>
          )}
          {result.failed.map((item) => (
            <p key={item.operationId}>
              失败操作：{item.operationId} · {item.code}
            </p>
          ))}
        </div>
      )}
      {loading && !rows.length ? (
        <Skeleton className="h-40 w-full" />
      ) : visible.length ? (
        visible.map((row) => {
          const current = state(row, now);
          return (
            <Card key={row.packageId}>
              <CardHeader>
                <CardTitle>
                  {current === "pending"
                    ? "清理操作 " + (row.operationId || "等待登记")
                    : row.versionName || "未命名版本"}
                </CardTitle>
                <CardDescription>{kindLabels[row.kind]}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Badge
                  variant={current === "unexpired" ? "secondary" : "outline"}
                >
                  {current === "pending"
                    ? "清理待重试"
                    : current === "expired"
                      ? "已到期，等待清理"
                      : "三天内可恢复"}
                </Badge>
                {current !== "pending" && (
                  <>
                    <p>移入时间：{date(row.archivedAt)}</p>
                    <p>到期时间：{date(row.purgeAt)}</p>
                    {current === "unexpired" && (
                      <p>
                        剩余{" "}
                        {Math.ceil((Date.parse(row.purgeAt!) - now) / 3600000)}{" "}
                        小时
                      </p>
                    )}
                  </>
                )}
                <p>
                  岗位 {row.counts.jobs || 0} · 评价{" "}
                  {row.counts.evaluations || 0} · 检索 {row.counts.runs || 0} ·
                  投递 {row.counts.applications || 0}
                </p>
                {current === "pending" && (
                  <>
                    <p>
                      步骤：{row.phase || "等待续清理"}
                      {row.code && " · " + row.code}
                    </p>
                    {row.nextRetryAt && (
                      <p>下次重试：{date(row.nextRetryAt)}</p>
                    )}
                  </>
                )}
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                {current === "unexpired" && (
                  <>
                    <Button
                      variant="outline"
                      disabled={op.busy}
                      aria-label={"查看内容" + row.versionName}
                      onClick={() => setDetails(row.packageId)}
                    >
                      查看内容
                    </Button>
                    <Button
                      disabled={op.busy}
                      aria-label={"恢复" + row.versionName}
                      onClick={() => void restore(row)}
                    >
                      恢复整个版本
                    </Button>
                  </>
                )}
                {current === "pending" ? (
                  <Button
                    variant="outline"
                    disabled={op.busy || !row.operationId}
                    onClick={() =>
                      void op.run(async () => {
                        const saved = await api.request<PurgeResult>(
                          "/trash/retry",
                          {
                            method: "POST",
                            body: { operationId: row.operationId },
                          },
                        );
                        if (saved && Array.isArray(saved.completed))
                          setResult(saved);
                        setAttempt((v) => v + 1);
                      }, "已请求续清理，请查看逐项进度")
                    }
                  >
                    重试清理
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    disabled={op.busy}
                    aria-label={"永久删除" + row.versionName}
                    onClick={() => void prepare([row.packageId])}
                  >
                    永久删除
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {rows.length ? "没有符合筛选的版本" : "回收站为空"}
            </EmptyTitle>
            <EmptyDescription>
              清空整个回收站会处理全部回收包，不删除正常或停用版本。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <PurgeConfirmDialog
        preview={preview}
        busy={op.busy}
        error={op.error}
        stale={stale}
        onConfirm={() => void purge()}
        onCancel={() => {
          setPreview(null);
          op.clear();
        }}
      />
      <TrashDetailsSheet
        api={api}
        packageId={
          detailRow && state(detailRow, now) === "unexpired" ? details : null
        }
        purgeAt={detailRow?.purgeAt}
        onClose={() => setDetails(null)}
      />
      <span className="sr-only">
        当前清理范围：{reason === "empty" ? "整个回收站" : "所选版本"}
      </span>
    </section>
  );
}
