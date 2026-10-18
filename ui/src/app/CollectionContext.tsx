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
  ApiError,
  CollectionActivity,
  Scope,
} from "../lib/types";
import { useVersionContext } from "./VersionContext";

type Value = {
  activity: CollectionActivity | null;
  loading: boolean;
  error: ApiError | null;
  lastFetchedAt: string | null;
  refresh(): Promise<void>;
  adopt(value: CollectionActivity, scope: Scope): void;
};
type State = Omit<Value, "refresh" | "adopt"> & { key: string };
type Session = {
  key: string;
  scope: Scope;
  live: boolean;
  busy: boolean;
  queued: boolean;
  queuedFull: boolean;
  cursor: number | null;
  expiresAt: number | null;
  sequence: number;
  controller: AbortController | null;
  pending: Promise<void> | null;
};
const Context = createContext<Value | null>(null);
const sameScope = (a: Scope, b: Scope) =>
  a.packageId === b.packageId && a.targetRevisionId === b.targetRevisionId;

export function CollectionProvider({
  api,
  children,
}: {
  api: ApiClient;
  children: ReactNode;
}) {
  const version = useVersionContext();
  const key = JSON.stringify([version.scope, version.generation]);
  const ready = !!version.scope && !version.loading && !version.error;
  const current = useRef({ key, scope: version.scope, ready });
  current.current = { key, scope: version.scope, ready };
  const sessionRef = useRef<Session | null>(null);
  const [state, setState] = useState<State>({
    key,
    activity: null,
    loading: !!version.scope,
    error: null,
    lastFetchedAt: null,
  });
  const refresh = useCallback(
    async (incremental = false) => {
      const session = sessionRef.current;
      if (
        !session ||
        !session.live ||
        session.key !== key ||
        current.current.key !== key ||
        !current.current.ready
      )
        return;
      if (session.busy) {
        session.queued = true;
        session.queuedFull ||= !incremental;
        await session.pending;
        return;
      }
      session.busy = true;
      session.pending = (async () => {
        do {
          const useCursor =
            incremental && session.cursor !== null && !session.queuedFull &&
            (session.expiresAt === null || Date.now() < session.expiresAt);
          session.queued = false;
          session.queuedFull = false;
          const sequence = ++session.sequence;
          const controller = new AbortController();
          session.controller = controller;
          setState((prev) => ({
            ...prev,
            key,
            loading: prev.activity === null && prev.lastFetchedAt === null,
          }));
          try {
            const result = await api.request<{
              collections?: CollectionActivity[];
              cursor?: number;
              changed?: boolean;
              asOf?: string;
              validUntil?: string | null;
            }>(
              useCursor
                ? "/collections?afterSeq=" + session.cursor
                : "/collections",
              {
                scope: session.scope,
                signal: controller.signal,
              },
            );
            if (
              session.live &&
              current.current.key === key &&
              sequence === session.sequence &&
              !controller.signal.aborted
            ) {
              session.cursor =
                typeof result.cursor === "number" &&
                Number.isSafeInteger(result.cursor) &&
                result.cursor >= 0
                  ? result.cursor
                  : null;
              if (useCursor && result.changed === false) {
                setState((previous) => ({
                  ...previous,
                  key,
                  loading: false,
                  error: null,
                  lastFetchedAt: new Date().toISOString(),
                }));
                incremental = !session.queuedFull;
                continue;
              }
              const activity =
                result.collections?.find(
                  (a) =>
                    a.collectionRole !== "collection_slice" &&
                    (!a.ownerPackageId ||
                      a.ownerPackageId === session.scope.packageId) &&
                    (!a.targetSnapshot?.revisionId ||
                      a.targetSnapshot.revisionId ===
                        session.scope.targetRevisionId),
                ) ?? null;
              const until = Date.parse(result.validUntil ?? ""), asOf = Date.parse(result.asOf ?? "");
              session.expiresAt = Number.isFinite(until)
                ? Date.now() + Math.max(0, until - (Number.isFinite(asOf) ? asOf : Date.now()))
                : null;
              setState({
                key,
                activity,
                loading: false,
                error: null,
                lastFetchedAt: new Date().toISOString(),
              });
            }
          } catch (error) {
            if (
              session.live &&
              current.current.key === key &&
              sequence === session.sequence &&
              !controller.signal.aborted
            ) {
              setState((prev) => ({
                ...prev,
                key,
                loading: false,
                error:
                  error instanceof Error
                    ? (error as ApiError)
                    : new Error("采集活动读取失败"),
              }));
            }
          }
          incremental = !session.queuedFull;
        } while (session.queued && session.live && current.current.key === key);
        session.busy = false;
      })();
      await session.pending;
    },
    [api, key],
  );

  const adopt = useCallback(
    (activity: CollectionActivity, scope: Scope) => {
      const now = current.current;
      if (
        now.key !== key ||
        !now.ready ||
        !now.scope ||
        !sameScope(scope, now.scope)
      )
        return;
      if (
        (activity.ownerPackageId &&
          activity.ownerPackageId !== scope.packageId) ||
        (activity.targetSnapshot?.revisionId &&
          activity.targetSnapshot.revisionId !== scope.targetRevisionId)
      )
        return;
      const session = sessionRef.current;
      if (!session || session.key !== key || !session.live) return;
      session.sequence++;
      session.cursor = null;
      const until = Date.parse(activity.quality?.nextTemporalChangeAt ?? ""), asOf = Date.parse(activity.quality?.asOf ?? "");
      session.expiresAt = Number.isFinite(until)
        ? Date.now() + Math.max(0, until - (Number.isFinite(asOf) ? asOf : Date.now()))
        : null;
      session.controller?.abort();
      setState({
        key,
        activity,
        loading: false,
        error: null,
        lastFetchedAt: new Date().toISOString(),
      });
    },
    [key],
  );

  useEffect(() => {
    setState((previous) =>
      previous.key === key
        ? previous
        : {
            key,
            activity: null,
            loading: !!version.scope,
            error: null,
            lastFetchedAt: null,
          },
    );
    if (!ready || !version.scope) return;
    const session: Session = {
      key,
      scope: version.scope,
      live: true,
      busy: false,
      queued: false,
      queuedFull: false,
      cursor: null,
      expiresAt: null,
      sequence: 0,
      controller: null,
      pending: null,
    };
    sessionRef.current = session;
    void refresh();
    return () => {
      session.live = false;
      session.sequence++;
      session.controller?.abort();
    };
  }, [key, ready, refresh]);

  const visible =
    state.key === key
      ? state
      : {
          key,
          activity: null,
          loading: !!version.scope,
          error: null,
          lastFetchedAt: null,
        };
  useEffect(() => {
    if (!ready) return;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    // Active work needs live controls. Waiting/paused/budget/terminal states
    // retain a low-frequency fallback so another process remains observable.
    const interval =
      visible.activity?.collectionProgress.status === "collecting" ||
      visible.activity?.collectionProgress.draining
        ? 2000
        : 30000;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh(true);
    }, interval);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [
    ready,
    key,
    visible.activity?.collectionProgress.status,
    visible.activity?.collectionProgress.draining,
    refresh,
  ]);
  return (
    <Context.Provider value={{ ...visible, refresh, adopt }}>
      {children}
    </Context.Provider>
  );
}
export function useCollectionActivity() {
  const value = useContext(Context);
  if (!value) throw Error("CollectionProvider missing");
  return value;
}
