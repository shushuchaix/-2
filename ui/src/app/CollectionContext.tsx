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
  sequence: number;
  controller: AbortController | null;
  pending: Promise<void> | null;
};
const Context = createContext<Value | null>(null);
const polling = new Set([
  "collecting",
  "paused",
  "waiting_for_auth",
  "budget_exhausted",
]);
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
  const refresh = useCallback(async () => {
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
      await session.pending;
      return;
    }
    session.busy = true;
    session.pending = (async () => {
      do {
        session.queued = false;
        const sequence = ++session.sequence;
        const controller = new AbortController();
        session.controller = controller;
        setState((prev) => ({ ...prev, key, loading: true }));
        try {
          const result = await api.request<{
            collections?: CollectionActivity[];
          }>("/collections", {
            scope: session.scope,
            signal: controller.signal,
          });
          if (
            session.live &&
            current.current.key === key &&
            sequence === session.sequence &&
            !controller.signal.aborted
          ) {
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
      } while (session.queued && session.live && current.current.key === key);
      session.busy = false;
    })();
    await session.pending;
  }, [api, key]);

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
    if (
      !ready ||
      !visible.activity ||
      !polling.has(visible.activity.collectionProgress.status)
    )
      return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [ready, key, visible.activity?.collectionProgress.status, refresh]);
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
