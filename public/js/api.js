export async function* decodeNdjson(chunks) {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw Error("任务事件格式无效，请重新连接。");
    }
  };
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 8 * 1024 * 1024) throw Error("任务事件超过大小限制。");
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
  onAuthRequired = () => {
    globalThis.location.href = "/login";
  },
} = {}) {
  async function response(path, options = {}) {
    const { body, ...rest } = options;
    let res;
    try {
      res = await fetchImpl("/api/v2" + path, {
        ...rest,
        credentials: "same-origin",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...rest.headers,
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
      if (typeof data.diagnosticId === "string" && data.diagnosticId.length <= 160 && data.diagnosticId) {
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
      return (await response(path, options)).json();
    },
    async download(path, options) {
      return (await response(path, options)).blob();
    },
    async streamRun(runId, { afterSeq = 0, onEvent, signal } = {}) {
      let cursor = afterSeq,
        retries = 0;
      for (;;) {
        signal?.throwIfAborted();
        try {
          const res = await response(
            "/runs/" + encodeURIComponent(runId) + "/events?afterSeq=" + cursor,
            { signal },
          );
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
          throw Error("事件连接已断开");
        } catch (error) {
          if (
            signal?.aborted ||
            error.status === 401 ||
            error.status === 400 ||
            ++retries > 4
          )
            throw error;
          await new Promise((resolve, reject) => {
            const stop = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            const timer = setTimeout(
              () => {
                signal?.removeEventListener("abort", stop);
                resolve();
              },
              Math.min(500 * 2 ** retries, 5000),
            );
            signal?.addEventListener("abort", stop, { once: true });
          });
        }
      }
    },
  };
}
