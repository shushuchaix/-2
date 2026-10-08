import { useEffect, useRef, useState } from "react";
import type { ApiClient, RunEvent, Scope } from "../../lib/types";
import { useQuery, useOperation } from "../../lib/hooks";
import { useVersionContext } from "../../app/VersionContext";
import { buildHash } from "../../app/router";
import { RunOptions } from "./RunOptions";
import { RunSummary } from "./RunSummary";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { OperationFeedback } from "../../components/OperationFeedback";
import { FormFeedback } from "../../components/FormFeedback";
import { factOf, type JobItem } from "../jobs/job-view";
import { validateInput } from "../../../../public/js/validation-rules.js";
const terminal = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);
const resumable = new Set(["queued", "running", "cancelling"]);
const stageLabels: Record<string, string> = {
  queued: "等待开始",
  running: "正在更新",
  collect: "采集岗位",
  collecting: "采集岗位",
  normalize: "整理招聘信息",
  evaluate: "评价岗位",
  scoring: "评价岗位",
  planning: "准备采集计划",
  details: "读取招聘详情",
  expanding: "整理与扩展岗位",
  evaluating: "评价岗位匹配",
  finished: "更新结束",
  snapshot: "保存运行记录",
  completed: "更新结束",
  partial: "部分完成",
  failed: "更新失败",
  cancelling: "等待取消",
  cancelled: "已取消",
  interrupted: "运行中断",
};
export function WorkbenchPage({ api }: { api: ApiClient }) {
  const ctx = useVersionContext();
  const [mode, setMode] = useState<"rules" | "ai">("rules"),
    [userKey, setUserKey] = useState(""),
    [run, setRun] = useState<Record<string, unknown> | null>(null),
    [outcome, setOutcome] = useState(""),
    [streamError, setStreamError] = useState<unknown>(null),
    [recovering, setRecovering] = useState(!!ctx.scope),
    [recoveryError, setRecoveryError] = useState<unknown>(null),
    [recoveryAttempt, setRecoveryAttempt] = useState(0),
    [errors, setErrors] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0);
  const op = useOperation(),
    cancel = useOperation();
  const connecting = useRef(false);
  const target = ctx.targets.find((t) => t.packageId === ctx.scope?.packageId);
  const query = useQuery<{ items: JobItem[]; total: number }>(
    api,
    ctx.selection ? "/jobs?page=1&pageSize=5&recommendation=high" : null,
    ctx.selection ?? undefined,
  );
  const settings = useQuery<{ budgets?: { maxCostCny?: number } }>(
    api,
    "/settings",
  );
  useEffect(() => {
    setUserKey("");
  }, [ctx.generation]);
  useEffect(() => {
    const token = ++generation.current;
    controller.current?.abort();
    connecting.current = false;
    setRun(null);
    setOutcome("");
    setStreamError(null);
    setRecoveryError(null);
    setRecovering(!!ctx.scope && !ctx.error);
    if (ctx.scope && !ctx.loading && !ctx.error) {
      const scope = ctx.scope;
      const read = new AbortController();
      controller.current = read;
      void api
        .request<{ runs: Record<string, unknown>[] }>("/runs", {
          scope,
          signal: read.signal,
        })
        .then((result) => {
          if (token !== generation.current || read.signal.aborted) return;
          const current = result.runs.find(
            (item) =>
              typeof item.runId === "string" &&
              resumable.has(String(item.status)),
          );
          setRecovering(false);
          if (current) {
            setRun(current);
            void connect(String(current.runId), scope);
          }
        })
        .catch((error) => {
          if (token !== generation.current || read.signal.aborted) return;
          setRecoveryError(error);
          setRecovering(false);
        });
    }
    return () => {
      generation.current++;
      controller.current?.abort();
      connecting.current = false;
    };
  }, [api, ctx.generation, ctx.loading, ctx.error, recoveryAttempt]);
  async function connect(runId: string, scope: Scope) {
    if (connecting.current) return;
    connecting.current = true;
    const token = generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setStreamError(null);
    try {
      await api.streamRun(runId, {
        scope,
        signal,
        onEvent: async (event: RunEvent) => {
          if (token !== generation.current || signal.aborted) return;
          const payload = event.payload ?? {},
            next = {
              ...payload,
              ...(payload.run && typeof payload.run === "object"
                ? payload.run
                : {}),
            } as Record<string, unknown>;
          setRun((previous) => ({ ...previous, ...next }));
          if (event.type === "done" || terminal.has(String(next.status))) {
            const status = String(next.status ?? "completed");
            setOutcome(
              status === "completed"
                ? "岗位更新完成"
                : status === "partial"
                  ? "岗位更新部分完成，请查看覆盖与回退提示"
                  : status === "cancelled"
                    ? "任务已取消"
                    : status === "interrupted"
                      ? "任务已中断，请查看运行日志"
                      : "岗位更新失败，请查看运行日志",
            );
            query.refresh();
          }
        },
      });
    } catch (error) {
      if (token === generation.current && !signal.aborted)
        setStreamError(error);
    } finally {
      if (token === generation.current) connecting.current = false;
    }
  }
  async function start() {
    if (
      !ctx.scope ||
      ctx.loading ||
      ctx.error ||
      recovering ||
      recoveryError ||
      (!!run && !terminal.has(String(run.status))) ||
      op.busy
    )
      return;
    const checked = validateInput("run", {
      mode,
      targetRevisionId: ctx.scope.targetRevisionId,
      ...(mode === "ai" && userKey ? { userApiKey: userKey } : {}),
    }) as Record<string, string>;
    if (Object.keys(checked).length) {
      setErrors(checked);
      return;
    }
    setErrors({});
    const scope = ctx.scope,
      token = generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setOutcome("");
    setStreamError(null);
    await op.run(async () => {
      const created = await api.request<Record<string, unknown>>("/runs", {
        method: "POST",
        scope,
        signal,
        body: {
          mode,
          ...(mode === "ai" && userKey ? { userApiKey: userKey } : {}),
        },
      });
      setUserKey("");
      if (token !== generation.current || signal.aborted) return;
      setRun(created);
      void connect(String(created.runId), scope);
    }, "检索任务已创建");
  }
  const running = !!run && !terminal.has(String(run.status)),
    counts = (run?.counts ?? {}) as Record<string, unknown>;
  return (
    <div className="flex flex-col gap-6">
      {(!ctx.profiles.length || !ctx.targets.length) && (
        <Alert>
          <AlertDescription>
            <p>导入简历 → 创建目标 → 更新岗位</p>
            <a href="#/profiles" className="text-primary underline">
              导入简历
            </a>{" "}
            ·{" "}
            <a href="#/targets" className="text-primary underline">
              创建目标
            </a>
          </AlertDescription>
        </Alert>
      )}
      {target && !target.profileSnapshot?.text && (
        <Alert>
          <AlertDescription>
            此目标缺少可核实的简历副本，请在求职目标页创建完整版本。
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>更新当前目标岗位</CardTitle>
          <CardDescription>
            检索与评价保存在当前版本中，其他版本保留各自记录。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunOptions
            mode={mode}
            onMode={setMode}
            userKey={userKey}
            onKey={setUserKey}
            keyError={errors.userApiKey ?? op.error?.fieldErrors?.userApiKey}
            budgetCny={
              typeof target?.budgets?.maxCostCny === "number"
                ? target.budgets.maxCostCny
                : (settings.data?.budgets?.maxCostCny ?? null)
            }
          />
          <FormFeedback
            errors={errors}
            error={op.error}
            onFocusField={(name) =>
              document
                .getElementById(name === "userApiKey" ? "run-key" : name)
                ?.focus()
            }
          />
        </CardContent>
        <CardFooter className="flex flex-wrap gap-4">
          <Button
            disabled={
              !ctx.scope ||
              !target?.profileSnapshot?.text ||
              target?.enabled === false ||
              ctx.loading ||
              !!ctx.error ||
              recovering ||
              !!recoveryError ||
              running ||
              op.busy
            }
            onClick={() => void start()}
          >
            更新岗位
          </Button>
          {running && (
            <Button
              variant="outline"
              disabled={cancel.busy}
              onClick={() =>
                ctx.scope &&
                void cancel.run(async () => {
                  const response = await api.request<Record<string, unknown>>(
                    "/runs/" +
                      encodeURIComponent(String(run.runId)) +
                      "/cancel",
                    { method: "POST", scope: ctx.scope ?? undefined, body: {} },
                  );
                  setRun((prev) => ({ ...prev, ...response }));
                  if (terminal.has(String(response.status)))
                    setOutcome("任务已取消");
                }, "已请求取消，正在等待任务完成")
              }
            >
              取消任务
            </Button>
          )}
        </CardFooter>
      </Card>
      {recovering && ctx.scope && (
        <p role="status">正在读取当前目标的运行任务…</p>
      )}
      <OperationFeedback error={recoveryError} />
      {!!recoveryError && ctx.scope && (
        <Button
          variant="outline"
          disabled={recovering || ctx.loading}
          onClick={() => setRecoveryAttempt((attempt) => attempt + 1)}
        >
          重新读取运行任务
        </Button>
      )}
      <OperationFeedback busy={op.busy} result={op.message} />
      <OperationFeedback
        busy={cancel.busy}
        result={cancel.message}
        error={cancel.error}
      />
      <FormFeedback error={streamError} />
      {!!streamError && ctx.scope && run && (
        <Button
          variant="outline"
          onClick={() => {
            if (ctx.scope) void connect(String(run.runId), ctx.scope);
          }}
        >
          重新连接任务
        </Button>
      )}
      {run && (
        <Card>
          <CardHeader>
            <CardTitle>运行进度</CardTitle>
            <CardDescription>
              任务状态：
              {stageLabels[String(run.status)] ??
                String(run.status ?? "准备中")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p>
              阶段：
              {stageLabels[String(run.phase ?? run.stage ?? run.status)] ??
                String(run.phase ?? run.stage ?? run.status ?? "准备中")}
            </p>
            <p>
              采集{" "}
              {String(
                counts.collected ??
                  counts.raw ??
                  run.collected ??
                  run.collectedCount ??
                  0,
              )}{" "}
              条 · 保存{" "}
              {String(
                counts.saved ??
                  counts.deduplicated ??
                  counts.normalized ??
                  run.saved ??
                  run.savedCount ??
                  0,
              )}{" "}
              条 · 候选{" "}
              {String(
                counts.candidates ??
                  counts.shortlisted ??
                  run.candidates ??
                  run.candidateCount ??
                  0,
              )}{" "}
              条
            </p>
            <RunSummary run={run} />
            {Array.isArray(run.warnings) &&
              run.warnings.map((w, i) => <p key={i}>{String(w)}</p>)}
            {Array.isArray(run.issues) &&
              run.issues.map((item, i) => {
                const issue = item as Record<string, unknown>;
                return (
                  <p key={i}>
                    {String(issue.message ?? issue.code ?? "需检查的运行问题")}
                    {typeof issue.diagnosticId === "string" && (
                      <a
                        className="ml-2 text-primary underline"
                        href={buildHash({
                          page: "logs",
                          selection: ctx.selection,
                          filters: {
                            tab: "system",
                            diagnosticId: issue.diagnosticId,
                          },
                        })}
                      >
                        查看故障详情
                      </a>
                    )}
                  </p>
                );
              })}
            {outcome && <p role="status">{outcome}</p>}
          </CardContent>
          <CardFooter>
            <a
              href={buildHash({
                page: "logs",
                selection: ctx.selection,
                filters: { runId: String(run.runId) },
              })}
              className="text-primary underline"
            >
              查看检索日志与故障详情
            </a>
          </CardFooter>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>推荐岗位</CardTitle>
          <CardDescription>
            当前版本的优先机会；没有评价的岗位仍可在岗位库浏览。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormFeedback error={query.error} />
          {query.data?.items.map((row) => (
            <p key={row.jobId}>{factOf(row).title}</p>
          ))}
          {!query.data?.items.length && (
            <p className="text-muted-foreground">
              暂无推荐岗位，更新后进入岗位库查看全部结果。
            </p>
          )}
        </CardContent>
        <CardFooter>
          <a
            href={buildHash({
              page: "jobs",
              selection: ctx.selection,
              filters: {},
            })}
            className="text-primary underline"
          >
            打开岗位库
          </a>
        </CardFooter>
      </Card>
    </div>
  );
}
