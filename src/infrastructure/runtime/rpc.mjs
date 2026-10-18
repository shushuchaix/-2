import { randomUUID } from "node:crypto";

const requestId = /^q-[a-f0-9-]{36}$/;
const methodName = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){1,4}$/;
const codeName = /^[A-Za-z0-9_.-]{1,100}$/;
const diagnosticId = /^d-[a-f0-9-]{36}$/;
const failure = (code) =>
  Object.assign(Error("后台连接未完成，请重试并查看运行日志。"), { code });

/** Only plain, bounded data may cross a process boundary. In particular this
 * rejects functions, AbortSignals, native handles, prototypes and cyclic data. */
export function assertRpcValue(value, { maxBytes = 10 * 1024 * 1024 } = {}) {
  let bytes = 0,
    nodes = 0;
  const seen = new Set();
  const visit = (item, depth) => {
    if (++nodes > 50000 || depth > 20) throw failure("rpc_payload_invalid");
    if (item === null || typeof item === "boolean") {
      bytes += 5;
      return;
    }
    if (
      typeof item === "number" &&
      Number.isFinite(item) &&
      !Object.is(item, -0)
    ) {
      bytes += 24;
      return;
    }
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8") + 2;
      if (bytes > maxBytes) throw failure("rpc_payload_limit");
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item))
      throw failure("rpc_payload_invalid");
    const proto = Object.getPrototypeOf(item);
    const array = Array.isArray(item);
    if (array) {
      if (item.length > 10000) throw failure("rpc_payload_limit");
    } else if (proto !== Object.prototype && proto !== null)
      throw failure("rpc_payload_invalid");
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array) delete descriptors.length;
    const entries = Object.entries(descriptors);
    if (entries.length > 10000 || Object.getOwnPropertySymbols(item).length)
      throw failure("rpc_payload_limit");
    if (
      array &&
      (entries.length !== item.length ||
        entries.some(([key], index) => key !== String(index)))
    )
      throw failure("rpc_payload_invalid");
    for (const [key, descriptor] of entries) {
      if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
        throw failure("rpc_payload_invalid");
      if (
        ["__proto__", "constructor", "prototype"].includes(key) ||
        key.length > 160
      )
        throw failure("rpc_payload_invalid");
      bytes += Buffer.byteLength(key, "utf8") + 4;
      visit(descriptor.value, depth + 1);
      if (bytes > maxBytes) throw failure("rpc_payload_limit");
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (bytes > maxBytes) throw failure("rpc_payload_limit");
  return value;
}

export function cleanRpcError(error) {
  const result = {
    code: codeName.test(error?.code || "")
      ? error.code
      : "backend_operation_failed",
  };
  // No exception message, stack, URL, path, response body or arbitrary fields.
  if (diagnosticId.test(error?.diagnosticId || ""))
    result.diagnosticId = error.diagnosticId;
  if (requestId.test(error?.requestId || ""))
    result.requestId = error.requestId;
  if (
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status <= 599
  )
    result.status = error.status;
  for (const key of ["retryable", "runFatal", "committed"])
    if (typeof error?.[key] === "boolean") result[key] = error[key];
  for (const [key, allowed] of Object.entries({
    phase: [
      "queue",
      "dns",
      "budget",
      "transport",
      "response",
      "parse",
      "commit",
      "cleanup",
    ],
    budgetKind: ["requests", "details", "attachments", "model"],
  }))
    if (allowed.includes(error?.[key])) result[key] = error[key];
  return result;
}

/** Fixed capability RPC. Dispatches each incoming request independently: a
 * browser operation awaiting a reverse ledger RPC must not occupy a FIFO. */
export function createRpcPeer({
  send,
  capabilities,
  handlers = {},
  maxPending = 96,
  maxIncoming = 96,
  timeoutMs = 30000,
} = {}) {
  if (typeof send !== "function" || !capabilities)
    throw TypeError("RPC transport and capability contract required");
  const pending = new Map(),
    incoming = new Map();
  let closed = false;
  const post = (frame) => {
    if (closed) throw failure("rpc_closed");
    assertRpcValue(frame);
    send(frame);
  };
  const finish = (id, action) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    item.signal?.removeEventListener("abort", item.abort);
    action(item);
  };
  const cancel = (id, code) => {
    finish(id, (item) => item.reject(failure(code)));
    try {
      post({ version: 1, type: "cancel", requestId: id });
    } catch {}
  };
  const contract = (method) =>
    methodName.test(method || "") &&
    Object.hasOwn(capabilities, method) &&
    capabilities[method];
  return {
    call(method, input = {}, { signal, timeoutMs: deadline = timeoutMs } = {}) {
      if (closed) return Promise.reject(failure("rpc_closed"));
      const descriptor = contract(method);
      try {
        assertRpcValue(input);
        if (!descriptor || !descriptor.input(input))
          throw failure("rpc_capability_invalid");
        if (pending.size >= maxPending) throw failure("rpc_pending_limit");
        if (
          !Number.isSafeInteger(deadline) ||
          deadline < 1 ||
          deadline > 300000
        )
          throw failure("rpc_timeout_invalid");
        signal?.throwIfAborted();
      } catch (error) {
        return Promise.reject(error);
      }
      const id = "q-" + randomUUID();
      return new Promise((resolve, reject) => {
        const item = {
          resolve,
          reject,
          descriptor,
          signal,
          abort: () => cancel(id, "rpc_cancelled"),
        };
        item.timer = setTimeout(() => cancel(id, "rpc_timeout"), deadline);
        pending.set(id, item);
        signal?.addEventListener("abort", item.abort, { once: true });
        if (signal?.aborted) {
          item.abort();
          return;
        }
        try {
          post({ version: 1, type: "request", requestId: id, method, input });
        } catch (error) {
          finish(id, (entry) => entry.reject(error));
        }
      });
    },
    receive(frame) {
      if (closed) return;
      try {
        assertRpcValue(frame);
        if (
          !frame ||
          frame.version !== 1 ||
          !requestId.test(frame.requestId || "")
        )
          return;
        if (frame.type === "cancel") {
          incoming.get(frame.requestId)?.abort(failure("rpc_cancelled"));
          return;
        }
        if (frame.type === "response") {
          finish(frame.requestId, (item) => {
            if (frame.ok === true && item.descriptor.output(frame.result))
              item.resolve(frame.result);
            else if (
              frame.ok === false &&
              frame.error &&
              typeof frame.error === "object"
            ) {
              const safe = cleanRpcError(frame.error),
                error = failure(safe.code);
              Object.assign(error, safe);
              if (safe.diagnosticId)
                error.message += "（错误编号：" + safe.diagnosticId + "）";
              item.reject(error);
            } else item.reject(failure("rpc_response_invalid"));
          });
          return;
        }
        if (frame.type !== "request" || incoming.has(frame.requestId)) return;
        const descriptor = contract(frame.method),
          handler =
            Object.hasOwn(handlers, frame.method) && handlers[frame.method];
        if (
          !descriptor ||
          !handler ||
          !descriptor.input(frame.input) ||
          incoming.size >= maxIncoming
        ) {
          post({
            version: 1,
            type: "response",
            requestId: frame.requestId,
            ok: false,
            error: {
              code:
                incoming.size >= maxIncoming
                  ? "rpc_incoming_limit"
                  : "rpc_capability_invalid",
            },
          });
          return;
        }
        const controller = new AbortController();
        incoming.set(frame.requestId, controller);
        // Deliberately do not await the task here (reverse RPC remains reentrant).
        Promise.resolve()
          .then(() =>
            handler(frame.input, {
              signal: controller.signal,
              requestId: frame.requestId,
            }),
          )
          .then((result) => {
            if (controller.signal.aborted) throw failure("rpc_cancelled");
            assertRpcValue(result);
            if (!descriptor.output(result))
              throw failure("rpc_response_invalid");
            post({
              version: 1,
              type: "response",
              requestId: frame.requestId,
              ok: true,
              result,
            });
          })
          .catch((error) => {
            try {
              post({
                version: 1,
                type: "response",
                requestId: frame.requestId,
                ok: false,
                error: cleanRpcError(error),
              });
            } catch {}
          })
          .finally(() => incoming.delete(frame.requestId));
      } catch {
        // Invalid envelopes carry no trusted correlation data or raw logging.
      }
    },
    close(code = "rpc_closed") {
      if (closed) return;
      closed = true;
      for (const [id] of pending)
        finish(id, (item) => item.reject(failure(code)));
      for (const controller of incoming.values())
        controller.abort(failure(code));
      incoming.clear();
    },
    snapshot: () => ({
      closed,
      pending: pending.size,
      incoming: incoming.size,
    }),
  };
}
