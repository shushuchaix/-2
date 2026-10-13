import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ApiClient,
  CollectionActivity,
  Scope,
  TargetVersion,
} from "../lib/types";
import { useVersionContext } from "./VersionContext";
import { useCollectionActivity } from "./CollectionContext";
import {
  getPendingStart,
  startRunOnce,
} from "../features/workbench/pending-start";

type Result = {
  scope: Scope;
  run?: Record<string, unknown>;
  message: string;
  error?: unknown;
};
type Value = {
  busy: boolean;
  message: string;
  error?: unknown;
  latest: Result | null;
  manual(): Promise<void>;
};
const Context = createContext<Value | null>(null);
// The API client belongs to one opened application. React effect replay and page
// navigation share the claim; the next application launch has a new client.
const startupClaims = new WeakMap<
  ApiClient,
  { scope: Scope; promise: Promise<Result> }
>();
const sameScope = (a: Scope | null, b: Scope) =>
  a?.packageId === b.packageId && a.targetRevisionId === b.targetRevisionId;

function blockedMessage(activity: CollectionActivity, automatic: boolean) {
  const p = activity.collectionProgress;
  if (p.status === "budget_exhausted")
    return "活动累计额度不足，请在工作台查看额度。";
  if (p.status === "waiting_for_auth")
    return "需要在独立采集窗口登录，完成后可手动继续。";
  if (p.replanRequired) return "来源或查询已变化，请到工作台确认重新规划。";
  if (automatic && p.status === "paused" && p.manualPaused !== false)
    return "活动已主动暂停，可手动继续采集。";
  if (automatic && p.status === "paused" && !p.refreshReady)
    return "当前活动需手动继续，请在工作台查看停止原因。";
  if (automatic && p.status === "cancelled")
    return "活动已取消，可手动重新更新岗位。";
  return null;
}

export function JobUpdateProvider({
  api,
  startupEnabled = true,
  children,
}: {
  api: ApiClient;
  startupEnabled?: boolean;
  children: ReactNode;
}) {
  const version = useVersionContext(),
    collection = useCollectionActivity();
  const key = JSON.stringify([version.scope, version.generation]);
  const current = useRef({ key, scope: version.scope });
  current.current = { key, scope: version.scope };
  const busy = useRef(false);
  const observedStartup = useRef(false);
  const [isBusy, setBusy] = useState(false);
  const [state, setState] = useState<{
    key: string;
    result: Result | null;
  }>({ key, result: null });
  const target = version.targets.find((t) =>
    sameScope(version.scope, {
      packageId: t.packageId,
      targetRevisionId: t.revisionId,
    }),
  );
  const ready =
    !!version.scope &&
    !version.loading &&
    !version.error &&
    !!target?.profileSnapshot?.text?.trim() &&
    target.enabled !== false;

  const perform = useCallback(
    async (
      scope: Scope,
      selected: TargetVersion,
      activity: CollectionActivity | null,
      automatic: boolean,
    ): Promise<Result> => {
      if (!sameScope(current.current.scope, scope))
        return { scope, message: "目标已切换，本次更新未启动。" };
      try {
        const pending = getPendingStart(api, scope);
        if (pending)
          return {
            scope,
            run: await pending,
            message: "已有岗位更新正在进行，继续显示该任务。",
          };
        if (activity) {
          const message = blockedMessage(activity, automatic);
          if (message) return { scope, message };
          const p = activity.collectionProgress;
          if (p.activeSliceRunId || p.status === "collecting")
            return { scope, message: "已有岗位更新正在进行，继续显示该任务。" };
          if (p.status === "paused") {
            const run = await api.request<Record<string, unknown>>(
              "/collections/" + encodeURIComponent(activity.runId) + "/resume",
              {
                method: "POST",
                scope,
                body: {
                  requestId: crypto.randomUUID(),
                  mode: "rules",
                  automatic,
                },
              },
            );
            return {
              scope,
              run,
              message: run.skipped
                ? "活动状态已变化，未自动继续；请查看当前任务。"
                : automatic
                  ? "启动自动更新已开始"
                  : "手动岗位更新已开始",
            };
          }
        }
        const run = await startRunOnce(api, scope, {
          mode: "rules",
          coverageMode:
            selected.coverageMode === "broad" ? "broad" : "standard",
        });
        return {
          scope,
          run,
          message: automatic ? "启动自动更新已开始" : "手动岗位更新已开始",
        };
      } catch (error) {
        return {
          scope,
          message: "岗位更新未能启动，已有岗位保留；可查看错误或手动重试。",
          error,
        };
      }
    },
    [api],
  );

  const observe = useCallback(
    async (promise: Promise<Result>) => {
      const captured = current.current.key;
      busy.current = true;
      setBusy(true);
      setState({ key: captured, result: null });
      try {
        const result = await promise;
        if (
          current.current.key === captured &&
          sameScope(current.current.scope, result.scope)
        )
          setState({ key: captured, result });
      } finally {
        await collection.refresh();
        busy.current = false;
        setBusy(false);
      }
    },
    [collection.refresh],
  );

  useEffect(() => {
    if (!startupEnabled || version.loading || version.error) return;
    const claimed = startupClaims.get(api);
    if (claimed) {
      if (!observedStartup.current) {
        observedStartup.current = true;
        void observe(claimed.promise);
      }
      return;
    }
    if (!version.selection) {
      const enabled = version.targets.filter(
        (t) =>
          t.enabled !== false &&
          (!t.state || t.state === "active") &&
          !t.archivedAt,
      );
      if (enabled.length === 1)
        version.select({
          packageId: enabled[0].packageId,
          targetRevisionId: enabled[0].revisionId,
        });
      return;
    }
    if (!ready || !version.scope || !target || collection.loading) return;
    const scope = { ...version.scope };
    const promise = collection.error
      ? Promise.resolve({
          scope,
          message: "任务状态读取失败，未自动更新；请重新读取任务或手动更新。",
          error: collection.error,
        })
      : perform(scope, target, collection.activity, true);
    startupClaims.set(api, { scope, promise });
    observedStartup.current = true;
    void observe(promise);
  }, [
    api,
    startupEnabled,
    version.loading,
    version.error,
    version.selection,
    version.targets,
    version.select,
    ready,
    target,
    collection.loading,
    collection.error,
    collection.activity,
    perform,
    observe,
  ]);

  const manual = useCallback(async () => {
    if (
      !ready ||
      !version.scope ||
      !target ||
      collection.loading ||
      collection.error ||
      busy.current
    )
      return;
    await observe(
      perform({ ...version.scope }, target, collection.activity, false),
    );
  }, [
    ready,
    version.scope,
    target,
    collection.loading,
    collection.error,
    collection.activity,
    observe,
    perform,
  ]);
  const visible = state.key === key ? state : { key, result: null };
  let hint = "";
  if (
    startupEnabled &&
    !startupClaims.has(api) &&
    !version.loading &&
    !version.error
  ) {
    hint = version.allTargets
      ? "全部目标为只读汇总，请选择单个目标更新。"
      : !version.scope
        ? "选择一个启用目标后，本次启动将自动更新岗位。"
        : target?.enabled === false
          ? "当前目标已停用，启用后可更新岗位。"
          : !target?.profileSnapshot?.text?.trim()
            ? "当前目标缺少简历副本，请完善后更新岗位。"
            : "";
  }
  return (
    <Context.Provider
      value={{
        busy: isBusy,
        latest: visible.result,
        message: visible.result?.message || hint,
        error: visible.result?.error,
        manual,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useJobUpdate() {
  const value = useContext(Context);
  if (!value) throw Error("JobUpdateProvider missing");
  return value;
}
