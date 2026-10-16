import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../components/ui/toast";
import type { ApiClient, ApiError, ReadScope } from "./types";
export function useOperation() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<ApiError | null>(null),
    [message, setMessage] = useState("");
  const active = useRef(false),
    generation = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const clear = useCallback(() => {
    if (active.current) return;
    generation.current++;
    setError(null);
    setMessage("");
  }, []);
  const run = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      if (active.current) return false;
      active.current = true;
      const token = generation.current;
      setBusy(true);
      setError(null);
      setMessage("");
      try {
        await action();
        if (!mounted.current || token !== generation.current) return false;
        setMessage(success);
        if (success) toast.add({ type: "success", title: success });
        return true;
      } catch (e) {
        if (mounted.current && token === generation.current)
          setError(
            e instanceof Error
              ? (e as ApiError)
              : new Error("操作失败，请重试。"),
          );
        return false;
      } finally {
        if (token === generation.current) {
          active.current = false;
          if (mounted.current) setBusy(false);
        }
      }
    },
    [],
  );
  return { busy, error, message, run, clear };
}
export function useQuery<T>(
  api: ApiClient,
  path: string | null,
  scope?: ReadScope,
) {
  const key = JSON.stringify([path, scope]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: ApiError | null;
    loading: boolean;
  }>({ key, data: null, error: null, loading: !!path });
  useEffect(() => {
    if (!path) {
      setState({ key, data: null, error: null, loading: false });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setState((prev) => ({
      key,
      data: prev.key === key ? prev.data : null,
      error: null,
      loading: true,
    }));
    api.request<T>(path, { scope, signal: controller.signal }).then(
      (data) => {
        if (active) setState({ key, data, error: null, loading: false });
      },
      (e) => {
        if (active && e.name !== "AbortError")
          setState((prev) => ({ ...prev, key, error: e, loading: false }));
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, key, attempt]);
  return {
    ...(state.key === key
      ? state
      : { key, data: null, error: null, loading: !!path }),
    refresh: () => setAttempt((x) => x + 1),
  };
}
