import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/types";
import { useVersionContext } from "../../app/VersionContext";
import { buildHash, parseRoute } from "../../app/router";
import { useOperation } from "../../lib/hooks";
import { OperationFeedback } from "../../components/OperationFeedback";
import { FormFeedback } from "../../components/FormFeedback";
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
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../components/ui/tabs";
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
import { Skeleton } from "../../components/ui/skeleton";
import {
  CollectionProgress,
  type CollectionActivity,
} from "../workbench/CollectionProgress";
import {
  DiagnosticDetails,
  safeDiagnostic,
  type DiagnosticEntry,
} from "./DiagnosticDetails";

type RunSummary = {
  runId: string;
  ownerPackageId?: string;
  targetRevisionId?: string;
  status: string;
  stage?: string;
  createdAt?: string;
  counts?: Record<string, number>;
  issues?: { code?: string; diagnosticId?: string }[];
  collectionRole?: string;
  collectionProgress?: CollectionActivity["collectionProgress"];
  collectionUsage?: Record<string, number>;
};
type DiagnosticResponse = {
  entries: DiagnosticEntry[];
  summary?: {
    returned: number;
    total: number;
    errors?: number;
    warnings?: number;
    truncated?: boolean;
    damagedLines?: number;
  };
  storage?: { mode: string };
};
const status: Record<string, string> = {
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  running: "进行中",
  queued: "等待中",
};

function logRoute(hash: string) {
  const route = parseRoute(hash);
  if (route.page !== "logs") return null;
  return {
    tab: route.filters.tab === "system" ? "system" : "business",
    filters: {
      level: route.filters.level || "",
      category: route.filters.category || "",
      diagnosticId: route.filters.diagnosticId || "",
    },
  };
}

function LogSelect({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  options: [string, string][];
  onChange(value: string): void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Select value={value} onValueChange={(v) => onChange(v || "")}>
        <SelectTrigger id={name} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {options.map(([key, text]) => (
              <SelectItem key={key} value={key}>
                {text}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

export function LogsPage({ api }: { api: ApiClient }) {
  const context = useVersionContext();
  const initialRoute = useRef(
    logRoute(window.location.hash) || {
      tab: "business",
      filters: { level: "", category: "", diagnosticId: "" },
    },
  ).current;
  const routeKey = useRef(JSON.stringify(initialRoute));
  const [tab, setTab] = useState(initialRoute.tab);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [data, setData] = useState<DiagnosticResponse>({ entries: [] });
  const [selected, setSelected] = useState<DiagnosticEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const [maintenance, setMaintenance] = useState(false);
  const [filters, setFilters] = useState(initialRoute.filters);
  const [applied, setApplied] = useState(filters);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const download = useOperation();
  useEffect(() => {
    const sync = () => {
      const next = logRoute(window.location.hash);
      if (!next) return;
      const nextKey = JSON.stringify(next);
      // Only a changed log destination replaces the local draft. Scope-only
      // and unrelated hash updates must not turn unsaved fields into a query.
      if (nextKey === routeKey.current) return;
      routeKey.current = nextKey;
      setTab(next.tab);
      setFilters(next.filters);
      setApplied(next.filters);
      setErrors({});
      setSelected(null);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const readScope =
    context.scope ||
    (context.allTargets ? { allTargets: true as const } : null);
  const scopeKey = context.scope
    ? context.scope.packageId + ":" + context.scope.targetRevisionId
    : context.allTargets
      ? "all"
      : "none";
  const query = (limit: boolean) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(applied))
      if (value) search.set(key, value);
    if (limit) search.set("limit", "200");
    return search.size ? "?" + search.toString() : "";
  };
  function navigateTab(value: string) {
    const nextTab = value === "system" ? "system" : "business";
    const route = parseRoute(window.location.hash);
    const nextHash = buildHash({
      ...route,
      page: "logs",
      selection: context.selection,
      filters: { ...route.filters, tab: nextTab },
    });
    // Local tab navigation keeps the unapplied draft. Register the new URL
    // before its hashchange; external links and browser history still sync.
    routeKey.current = JSON.stringify(logRoute(nextHash));
    setTab(nextTab);
    window.location.hash = nextHash;
  }
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    let live = true;
    setSelected(null);
    setReadError(null);
    setMaintenance(false);
    if (tab === "system") setData({ entries: [] });
    if (tab === "business") setRuns([]);
    if (context.loading || (tab === "business" && !readScope)) {
      setLoading(false);
      return () => {
        live = false;
        controller.abort();
      };
    }
    setLoading(true);
    const request = (async () => {
      let safeMaintenance = false;
      if (tab === "system" && context.error) {
        const health = await api.request<{ maintenance: boolean }>(
          "/maintenance",
          { signal: controller.signal },
        );
        safeMaintenance = health.maintenance === true;
        if (!live || current !== generation.current) return { entries: [] };
        setMaintenance(safeMaintenance);
      }
      return tab === "business"
        ? Promise.all([
            api.request<{ runs: RunSummary[] }>("/runs", {
              scope: readScope || undefined,
              signal: controller.signal,
            }),
            api.request<{ collections?: RunSummary[] }>("/collections", {
              scope: readScope || undefined,
              signal: controller.signal,
            }),
          ]).then(([old, roots]) => ({
            runs: [
              ...(roots.collections ?? []),
              ...(old.runs ?? []).filter((r) => !r.collectionRole),
            ],
          }))
        : api.request<DiagnosticResponse>("/diagnostics/logs" + query(true), {
            scope: safeMaintenance
              ? undefined
              : (readScope ?? { allTargets: true }),
            signal: controller.signal,
          });
    })();
    request
      .then((result) => {
        if (!live || current !== generation.current) return;
        if (tab === "business")
          setRuns((result as { runs: RunSummary[] }).runs || []);
        else setData(result as DiagnosticResponse);
      })
      .catch((e) => {
        if (
          live &&
          current === generation.current &&
          !controller.signal.aborted
        )
          setReadError(e);
      })
      .finally(() => {
        if (live && current === generation.current) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, scopeKey, context.loading, context.error, tab, applied, refresh]);
  function filter() {
    const invalid: Record<string, string> =
      filters.diagnosticId &&
      !/^d-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        filters.diagnosticId.trim(),
      )
        ? { diagnosticId: "请填写完整的错误编号（d- 开头）。" }
        : {};
    setErrors(invalid);
    if (!Object.keys(invalid).length)
      setApplied({ ...filters, diagnosticId: filters.diagnosticId.trim() });
  }
  async function exportLogs() {
    await download.run(async () => {
      const blob = await api.download(
        "/diagnostics/logs/export" + query(false),
        {
          scope: maintenance ? undefined : (readScope ?? { allTargets: true }),
        },
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "job-radar-diagnostics.log";
      anchor.click();
      URL.revokeObjectURL(url);
    }, "日志已生成，已开始下载");
  }
  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1>运行日志</h1>
        <p className="text-muted-foreground">
          检索历史按目标隔离，系统诊断帮助定位网络、解析、模型和保存错误。
        </p>
      </header>
      <Tabs value={tab} onValueChange={(v) => navigateTab(String(v))}>
        <TabsList>
          <TabsTrigger value="business">业务历史</TabsTrigger>
          <TabsTrigger value="system">系统诊断</TabsTrigger>
        </TabsList>
        <TabsContent value="business">
          <div className="flex flex-col gap-4">
            <OperationFeedback error={readError} />
            {!readScope ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>先选择目标版本</EmptyTitle>
                  <EmptyDescription>
                    选定目标后查看其检索历史，也可选择全部目标查看只读汇总。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : loading ? (
              <Skeleton className="h-40 w-full" />
            ) : runs.length ? (
              runs.map((run) => (
                <Card key={run.runId}>
                  <CardHeader>
                    <CardTitle>{run.runId}</CardTitle>
                    <CardDescription>
                      {run.createdAt || ""}
                      {context.allTargets &&
                        " · 归属：" +
                          (run.targetRevisionId ||
                            run.ownerPackageId ||
                            "需确认")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {run.collectionProgress && (
                      <CollectionProgress
                        readOnly
                        api={api}
                        activity={run as CollectionActivity}
                      />
                    )}
                    <Badge
                      variant={
                        run.status === "failed" ? "destructive" : "secondary"
                      }
                    >
                      {run.collectionProgress
                        ? "采集活动"
                        : status[run.status] || run.status}
                    </Badge>
                    <p>阶段：{run.stage || "未记录"}</p>
                    <pre className="whitespace-pre-wrap break-all">
                      {JSON.stringify(run.counts || {}, null, 2)}
                    </pre>
                  </CardContent>
                  <CardFooter>
                    {run.issues?.map((issue, i) => (
                      <p key={i}>
                        {issue.code}
                        {issue.diagnosticId && (
                          <a
                            className="ml-2 underline"
                            href={buildHash({
                              page: "logs",
                              selection: context.selection,
                              filters: {
                                tab: "system",
                                diagnosticId: issue.diagnosticId,
                              },
                            })}
                          >
                            查看更新日志
                          </a>
                        )}
                      </p>
                    ))}
                  </CardFooter>
                </Card>
              ))
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>暂无检索记录</EmptyTitle>
                  <EmptyDescription>
                    前往工作台开始更新招聘来源。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            <Button
              variant="outline"
              disabled={loading || !readScope}
              onClick={() => setRefresh((v) => v + 1)}
            >
              刷新历史
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="system">
          <div className="flex flex-col gap-4">
            {maintenance && (
              <p role="status">
                维护模式：仅显示安全系统诊断，暂时无法验证版本归属。请根据错误编号处理工作区问题。
              </p>
            )}
            {!maintenance && (
              <p>
                范围：
                {context.scope
                  ? context.targets.find(
                      (v) => v.packageId === context.scope?.packageId,
                    )?.versionName
                  : "全部目标 · 安全诊断汇总"}
              </p>
            )}
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                filter();
              }}
              className="flex flex-col gap-4"
            >
              <FormFeedback errors={errors} />
              <FieldGroup className="md:grid md:grid-cols-3">
                <LogSelect
                  name="diagnosticLevel"
                  label="日志级别"
                  value={filters.level}
                  onChange={(v) => setFilters((f) => ({ ...f, level: v }))}
                  options={[
                    ["", "全部级别"],
                    ["problem", "错误与提醒"],
                    ["error", "错误"],
                    ["warn", "提醒"],
                    ["info", "信息"],
                  ]}
                />
                <LogSelect
                  name="diagnosticCategory"
                  label="日志分类"
                  value={filters.category}
                  onChange={(v) => setFilters((f) => ({ ...f, category: v }))}
                  options={[
                    ["", "全部分类"],
                    ["run", "更新任务"],
                    ["network", "网络"],
                    ["storage", "存储"],
                    ["http", "操作请求"],
                    ["source", "招聘来源"],
                    ["model", "模型"],
                    ["desktop", "桌面与界面"],
                    ["application", "工作区操作"],
                  ]}
                />
                <TextField
                  name="diagnosticId"
                  label="错误编号"
                  value={filters.diagnosticId}
                  onChange={(v) => {
                    setFilters((f) => ({ ...f, diagnosticId: v }));
                    setErrors({});
                  }}
                  error={errors.diagnosticId}
                />
              </FieldGroup>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={loading}>
                  筛选日志
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading}
                  onClick={() => setRefresh((v) => v + 1)}
                >
                  刷新日志
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={download.busy || loading || Boolean(readError)}
                  onClick={() => void exportLogs()}
                >
                  导出日志
                </Button>
              </div>
            </form>
            <OperationFeedback
              error={readError || download.error}
              result={download.message}
              busy={download.busy}
            />
            {data.storage?.mode === "memory" && (
              <p role="status">
                日志文件不可写，当前使用内存日志；重启后这些记录会丢失。
              </p>
            )}
            {data.summary && (
              <p>
                显示 {data.summary.returned} / {data.summary.total} 条；错误{" "}
                {data.summary.errors || 0}，提醒 {data.summary.warnings || 0}。
                {data.summary.truncated &&
                  "仅显示最近记录，导出可获取全部保留日志。"}
                {data.summary.damagedLines
                  ? "已跳过 " + data.summary.damagedLines + " 条损坏记录。"
                  : ""}
              </p>
            )}
            {loading && !data.entries.length ? (
              <Skeleton className="h-40 w-full" />
            ) : data.entries.length ? (
              data.entries.map((entry, i) => {
                const safe = safeDiagnostic(entry);
                return (
                  <Card key={String(safe.diagnosticId || i)}>
                    <CardHeader>
                      <CardTitle>
                        {String(safe.operation || "诊断事件")}
                      </CardTitle>
                      <CardDescription>
                        {String(safe.at || "")} · {String(safe.level || "info")}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p>{String(safe.code || "过程记录")}</p>
                      {safe.diagnosticId ? (
                        <p>错误编号：{String(safe.diagnosticId)}</p>
                      ) : null}
                    </CardContent>
                    <CardFooter>
                      <Button
                        variant="outline"
                        onClick={() => setSelected(entry)}
                        aria-label={
                          "查看诊断 " + String(safe.diagnosticId || i + 1)
                        }
                      >
                        查看详情
                      </Button>
                    </CardFooter>
                  </Card>
                );
              })
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>暂无系统诊断</EmptyTitle>
                  <EmptyDescription>
                    发生操作错误后可按提示中的错误编号查找。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </TabsContent>
      </Tabs>
      <DiagnosticDetails entry={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
