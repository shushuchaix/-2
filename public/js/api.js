import { safeApiRoute } from "./diagnostic-rules.js";

export async function* decodeNdjson(chunks) {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw Object.assign(Error("任务事件格式无效，请重新连接。"), {
        code: "event_format_error",
      });
    }
  };
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 8 * 1024 * 1024)
      throw Object.assign(Error("任务事件超过大小限制。"), {
        code: "event_size_limit",
      });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) yield parse(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield parse(buffer);
}
export function createApiClient({
  fetchImpl = globalThis.fetch,
  reportDiagnostic = async () => undefined,
  now = Date.now,
  waitForRetry = (delay, signal) =>
    new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", stop);
        resolve();
      }, delay);
      signal?.addEventListener("abort", stop, { once: true });
    }),
  onAuthRequired = () => {
    globalThis.location.href = "/login";
  },
} = {}) {
  const requestId = () =>
    "q-" +
    (globalThis.crypto?.randomUUID?.() ||
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const n = Math.floor(Math.random() * 16);
        return (c === "x" ? n : (n & 3) | 8).toString(16);
      }));
  const context = (path, options = {}) => ({
    requestId: requestId(),
    route: safeApiRoute("/api/v2" + path),
    method: options.method || "GET",
    started: now(),
  });
  async function report(path, error, meta, event = {}) {
    if (path.startsWith("/diagnostics/") || error?.name === "AbortError")
      return;
    const knownCodes = [
      "network_error",
      "response_format_error",
      "event_format_error",
      "event_size_limit",
      "stream_disconnected",
      "system_error",
      "permission_denied",
      "request_failed",
    ];
    let timer;
    try {
      const eventReport = reportDiagnostic({
        operation: "renderer.request",
        phase:
          error?.code === "response_format_error"
            ? "parse"
            : error?.status
              ? "response"
              : "transport",
        outcome: "failed",
        route: meta.route,
        method: meta.method,
        requestId: meta.requestId,
        durationMs: Math.max(0, Math.round(now() - meta.started)),
        ...(error?.status ? { httpStatus: error.status } : {}),
        ...(error?.diagnosticId
          ? { parentDiagnosticId: error.diagnosticId }
          : {}),
        code: knownCodes.includes(error?.code) ? error.code : "request_failed",
        ...event,
      });
      const result = await Promise.race([
        eventReport,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(undefined), 500);
        }),
      ]);
      if (
        error &&
        !error.diagnosticId &&
        /^d-[a-f0-9-]{36}$/.test(result?.diagnosticId || "")
      ) {
        error.diagnosticId = result.diagnosticId;
        error.message += "（错误编号：" + result.diagnosticId + "）";
      }
    } catch {
      /* Diagnostics cannot change the result of the user operation. */
    } finally {
      clearTimeout(timer);
    }
  }
  async function response(path, options = {}, meta) {
    const { body, ...rest } = options;
    let res;
    try {
      res = await fetchImpl("/api/v2" + path, {
        ...rest,
        credentials: "same-origin",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...rest.headers,
          "X-RJR-Request-Id": meta.requestId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error.name === "AbortError" || rest.signal?.aborted) throw error;
      throw Object.assign(
        Error("连接失败，请检查网络或确认软件服务仍在运行后重试。"),
        { code: "network_error" },
      );
    }
    if (!res.ok) {
      let data = {};
      try {
        data = await res.json();
      } catch {}
      if (res.status === 401) onAuthRequired();
      const error = Error(data.error || "请求失败（" + res.status + "）");
      if (
        typeof data.diagnosticId === "string" &&
        data.diagnosticId.length <= 160 &&
        data.diagnosticId
      ) {
        error.diagnosticId = data.diagnosticId;
        error.message += "（错误编号：" + data.diagnosticId + "）";
      }
      error.status = res.status;
      error.code =
        data.code ||
        (res.status === 403
          ? "permission_denied"
          : res.status >= 500
            ? "system_error"
            : "request_failed");
      if (
        data.fieldErrors &&
        typeof data.fieldErrors === "object" &&
        !Array.isArray(data.fieldErrors)
      )
        error.fieldErrors = Object.fromEntries(
          Object.entries(data.fieldErrors).filter(
            ([k, v]) =>
              k.length <= 160 && typeof v === "string" && v.length <= 2000,
          ),
        );
      throw error;
    }
    return res;
  }
  return {
    async request(path, options) {
      const meta = context(path, options);
      try {
        const res = await response(path, options, meta);
        try {
          return await res.json();
        } catch (error) {
          if (options?.signal?.aborted || error.name === "AbortError")
            throw error;
          throw Object.assign(Error("服务响应格式无效，请重试。"), {
            code: "response_format_error",
            status: res.status,
          });
        }
      } catch (error) {
        if (!options?.signal?.aborted) await report(path, error, meta);
        throw error;
      }
    },
    async download(path, options) {
      const meta = context(path, options);
      try {
        return await (await response(path, options, meta)).blob();
      } catch (error) {
        if (!options?.signal?.aborted) await report(path, error, meta);
        throw error;
      }
    },
    async streamRun(runId, { afterSeq = 0, onEvent, signal } = {}) {
      let cursor = afterSeq,
        retries = 0;
      for (;;) {
        signal?.throwIfAborted();
        const path =
            "/runs/" + encodeURIComponent(runId) + "/events?afterSeq=" + cursor,
          meta = context(path, { signal });
        try {
          const res = await response(path, { signal }, meta);
          for await (const event of decodeNdjson(res.body)) {
            if (event.type === "heartbeat") continue;
            if (event.seq <= cursor && event.type !== "snapshot") continue;
            cursor = Math.max(cursor, event.seq || 0);
            await onEvent(event);
            if (
              event.type === "done" ||
              (event.type === "snapshot" &&
                [
                  "completed",
                  "partial",
                  "failed",
                  "cancelled",
                  "interrupted",
                ].includes(event.payload?.run?.status))
            )
              return;
          }
          throw Object.assign(Error("事件连接已断开"), {
            code: "stream_disconnected",
          });
        } catch (error) {
          if (signal?.aborted || error.name === "AbortError") throw error;
          const final =
            error.status === 401 || error.status === 400 || retries >= 4;
          const delay = final ? 0 : Math.min(500 * 2 ** (retries + 1), 5000);
          await report(path, error, meta, {
            operation: "renderer.stream",
            runId,
            phase: error.code?.startsWith("event_") ? "parse" : "transport",
            outcome: final ? "failed" : "retrying",
            retryCount: retries,
            retryDelayMs: delay,
          });
          if (final) throw error;
          retries++;
          signal?.throwIfAborted();
          await waitForRetry(delay, signal);
        }
      }
    },
  };
}
