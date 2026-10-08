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
  ProfileVersion,
  ReadScope,
  Scope,
  TargetVersion,
} from "../lib/types";
import { parseRoute, buildHash } from "./router";
type ContextValue = {
  profiles: ProfileVersion[];
  targets: TargetVersion[];
  trashCount: number | null;
  scope: Scope | null;
  selection: ReadScope | null;
  allTargets: boolean;
  generation: number;
  loading: boolean;
  error: unknown;
  select: (s: ReadScope | null) => void;
  refresh: () => Promise<void>;
};
const VersionContext = createContext<ContextValue | null>(null);
export function VersionProvider({
  api,
  children,
}: {
  api: ApiClient;
  children: ReactNode;
}) {
  const [profiles, setProfiles] = useState<ProfileVersion[]>([]),
    [targets, setTargets] = useState<TargetVersion[]>([]),
    [selection, setSelection] = useState<ReadScope | null>(
      () => parseRoute(window.location.hash).selection,
    ),
    [generation, setGeneration] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null);
  const [trashCount, setTrashCount] = useState<number | null>(null);
  const request = useRef(0),
    selectionRef = useRef(selection);
  selectionRef.current = selection;
  const select = useCallback((next: ReadScope | null) => {
    setSelection(next);
    setGeneration((x) => x + 1);
    const route = parseRoute(window.location.hash);
    window.location.hash = buildHash({ ...route, selection: next });
  }, []);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const [p, t, trash] = await Promise.all([
        api.request<{ profiles: ProfileVersion[] }>("/profiles"),
        api.request<{ targets: TargetVersion[] }>("/targets"),
        api
          .request<{
            packageCount?: number;
            items?: { state: string }[];
          }>("/trash")
          .catch(() => null),
      ]);
      if (id !== request.current) return;
      if (trash)
        setTrashCount(
          trash.packageCount ??
            trash.items?.filter((p) => p.state !== "purged").length ??
            0,
        );
      setProfiles(
        (p.profiles ?? []).filter(
          (v) => !v.archivedAt && (!v.state || v.state === "active"),
        ),
      );
      setTargets(
        (t.targets ?? []).filter(
          (v) => !v.archivedAt && (!v.state || v.state === "active"),
        ),
      );
      setError(null);
      const current = selectionRef.current;
      if (
        current &&
        "packageId" in current &&
        !(t.targets ?? []).some(
          (v) =>
            v.packageId === current.packageId &&
            v.revisionId === current.targetRevisionId &&
            !v.archivedAt &&
            (!v.state || v.state === "active"),
        )
      )
        select(null);
    } catch (e) {
      if (id === request.current) setError(e);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [api, select]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const update = () => {
      const next = parseRoute(window.location.hash).selection;
      if (JSON.stringify(next) !== JSON.stringify(selectionRef.current)) {
        setSelection(next);
        setGeneration((x) => x + 1);
      }
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const scope = selection && "packageId" in selection ? selection : null;
  return (
    <VersionContext.Provider
      value={{
        profiles,
        targets,
        trashCount,
        selection,
        scope,
        allTargets: !!selection && "allTargets" in selection,
        generation,
        loading,
        error,
        select,
        refresh,
      }}
    >
      {children}
    </VersionContext.Provider>
  );
}
export function useVersionContext() {
  const value = useContext(VersionContext);
  if (!value) throw Error("VersionProvider missing");
  return value;
}
