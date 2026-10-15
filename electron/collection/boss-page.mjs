import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import {
  BOSS_OPERATION_HEADER,
  validBossOperationToken,
} from "./boss-operation-ownership.mjs";
const failure = (code) =>
  Object.assign(Error("Boss页面读取不可用。"), { code, retryable: false });
export function validateBossOperation(operation) {
  if (!operation || !operation.parameters)
    throw failure("boss_request_invalid");
  const { kind, parameters } = operation;
  const canonical = buildBossOperation(
    kind === "boss.search"
      ? {
          kind,
          query: parameters.query,
          ...(parameters.city === undefined ? {} : { city: parameters.city }),
          page: parameters.page,
          pageSize: parameters.pageSize,
        }
      : { kind, securityId: parameters.securityId, lid: parameters.lid },
  );
  if (
    operation.url !== canonical.url ||
    operation.method !== canonical.method ||
    Object.keys(operation).some(
      (k) => !["kind", "url", "method", "parameters"].includes(k),
    ) ||
    Object.keys(parameters).length !==
      Object.keys(canonical.parameters).length ||
    Object.entries(canonical.parameters).some(([k, v]) => parameters[k] !== v)
  )
    throw failure("boss_request_invalid");
  return canonical;
}
function pageRead(operation, id, ownership) {
  return new Promise((resolve) => {
    const $ = window.$;
    const key = "__rjrBoss_" + id;
    let done = false,
      readinessTimer;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (readinessTimer !== undefined) clearTimeout(readinessTimer);
      delete window[key];
      resolve(JSON.stringify(value));
    };
    if (
      typeof $?.ajax !== "function" ||
      typeof $.ajaxSettings?.beforeSend !== "function"
    ) {
      // A loaded SPA may not have mounted its native request hooks yet.
      // Wait only for local initialization: no refresh, transport or retry.
      window[key] = {
        abort() {
          finish({ status: 0, code: "collection_cancelled" });
        },
      };
      const initializeNative = (attempt = 0) => {
        if (done) return;
        try {
          const candidates = [window.Vue?.app?.$ajax];
          if (typeof document !== "undefined") {
            const nodes = document.querySelectorAll(
              "body > *,body > div > div",
            );
            if (nodes.length > 64)
              throw Error("Native client discovery overflow");
            for (const node of nodes) candidates.push(node.__vue__?.$ajax);
          }
          const clients = [
            ...new Set(
              candidates.filter(
                (client) =>
                  typeof client?.post === "function" &&
                  typeof client?.get === "function" &&
                  client.interceptors?.request &&
                  client.interceptors?.response,
              ),
            ),
          ];
          const hooksPending =
            clients.length === 1 &&
            Array.isArray(clients[0].interceptors.request.handlers) &&
            !clients[0].interceptors.request.handlers.some(
              (handler) => typeof handler?.fulfilled === "function",
            );
          if (
            (clients.length === 0 || hooksPending) &&
            attempt < 50 &&
            typeof setTimeout === "function"
          ) {
            readinessTimer = setTimeout(
              () => initializeNative(attempt + 1),
              100,
            );
            return;
          }
          if (clients.length !== 1)
            throw Error("Unsupported native page client");
          const client = clients[0];
          const requestHandlers = client.interceptors.request.handlers;
          if (
            !Array.isArray(requestHandlers) ||
            !requestHandlers.some(
              (handler) => typeof handler?.fulfilled === "function",
            ) ||
            requestHandlers.some(
              (handler) => handler && typeof handler.fulfilled !== "function",
            ) ||
            typeof client.axios?.create !== "function"
          )
            throw Error("Native request hooks not initialized");
          const adapter =
            typeof client.defaults?.adapter === "function"
              ? client.defaults.adapter
              : client.axios?.getAdapter?.(client.defaults?.adapter);
          if (
            typeof adapter !== "function" ||
            typeof client.axios?.CancelToken?.source !== "function"
          )
            throw Error("Unsupported native page transport");
          // Use the page's own factory/defaults and initialized authentication
          // functions in a per-read instance. No native recovery chain is copied.
          const isolated = client.axios.create(client.defaults);
          if (
            isolated === client ||
            typeof isolated?.post !== "function" ||
            typeof isolated?.get !== "function" ||
            typeof isolated.interceptors?.request?.use !== "function" ||
            !Array.isArray(isolated.interceptors.request.handlers) ||
            isolated.interceptors.request.handlers.length !== 0 ||
            !Array.isArray(isolated.interceptors?.response?.handlers) ||
            isolated.interceptors.response.handlers.length !== 0
          )
            throw Error("Native transport isolation unavailable");
          for (const handler of requestHandlers)
            if (handler)
              isolated.interceptors.request.use(handler.fulfilled, undefined, {
                runWhen: handler.runWhen,
              });
          const cancellation = client.axios.CancelToken.source();
          let cancelled = false;
          window[key] = {
            abort() {
              cancelled = true;
              cancellation.cancel();
              finish({ status: 0, code: "collection_cancelled" });
            },
          };
          const stopped = Error("Controlled page response captured");
          const options = {
            timeout: 45000,
            responseType: "text",
            cancelToken: cancellation.token,
            // Capture raw responses with no native success/error recovery
            // interceptors, so neither branch can refresh, retry or challenge.
            adapter: async (config) => {
              if (done || cancelled) throw stopped;
              let response;
              try {
                // Authentication hooks have finished. This local marker never
                // reaches the server: Electron validates and strips it first.
                const marked = ownership
                  ? {
                      ...config,
                      headers: {
                        ...(typeof config.headers?.toJSON === "function"
                          ? config.headers.toJSON()
                          : config.headers || {}),
                        [ownership.name]: ownership.value,
                      },
                    }
                  : config;
                response = await adapter(marked);
              } catch (error) {
                response = error?.response;
                if (!response) {
                  finish({
                    status: 0,
                    code: cancelled
                      ? "collection_cancelled"
                      : "boss_transport_failed",
                  });
                  throw stopped;
                }
              }
              if (!done) {
                const status =
                  Number.isInteger(response?.status) &&
                  response.status >= 0 &&
                  response.status <= 599
                    ? response.status
                    : 0;
                let payload = response?.data;
                if (typeof payload === "string") {
                  try {
                    if (payload.length > 6291456) throw stopped;
                    payload = JSON.parse(payload);
                  } catch {
                    payload = undefined;
                  }
                }
                finish({
                  status,
                  ...(payload && typeof payload === "object"
                    ? { payload }
                    : {}),
                });
              }
              throw stopped;
            },
          };
          const pending =
            operation.method === "POST"
              ? isolated.post(
                  operation.url,
                  new URLSearchParams(operation.parameters).toString(),
                  {
                    ...options,
                    headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                  },
                )
              : isolated.get(operation.url, {
                  ...options,
                  params: operation.parameters,
                });
          Promise.resolve(pending).then(
            () => {
              if (!done) finish({ status: 0, code: "boss_transport_failed" });
            },
            () => {
              if (!done)
                finish({
                  status: 0,
                  code: cancelled
                    ? "collection_cancelled"
                    : "boss_transport_failed",
                });
            },
          );
        } catch {
          finish({ status: 0, code: "boss_ajax_unavailable" });
        }
      };
      initializeNative();
      return;
    }
    try {
      const xhr = $.ajax({
        url: operation.url,
        type: operation.method,
        data: operation.parameters,
        dataType: "json",
        timeout: 45000,
        ...(ownership
          ? {
              beforeSend(xhr, settings) {
                const allowed = $.ajaxSettings.beforeSend.call(
                  this,
                  xhr,
                  settings,
                );
                if (allowed === false) return false;
                xhr.setRequestHeader(ownership.name, ownership.value);
              },
            }
          : {}),
        success: (payload, _text, xhr) =>
          finish({ status: xhr?.status || 200, payload }),
        error: (xhr, text) =>
          finish(
            text === "abort"
              ? { status: 0, code: "collection_cancelled" }
              : {
                  status: xhr?.status || 0,
                  ...(xhr?.responseJSON
                    ? { payload: xhr.responseJSON }
                    : { code: "boss_transport_failed" }),
                },
          ),
      });
      if (!done)
        window[key] = {
          abort() {
            xhr.abort();
          },
        };
    } catch {
      finish({ status: 0, code: "boss_ajax_unavailable" });
    }
  });
}
function pageAbort(id) {
  window["__rjrBoss_" + id]?.abort();
}
export function bossPageScript(operation, id, token) {
  if (token !== undefined && !validBossOperationToken(token))
    throw failure("boss_request_invalid");
  return `(${pageRead.toString()})(${JSON.stringify(validateBossOperation(operation))},${JSON.stringify(id)},${JSON.stringify(token ? { name: BOSS_OPERATION_HEADER, value: token } : null)})`;
}
export function bossAbortScript(id) {
  return `(${pageAbort.toString()})(${JSON.stringify(id)})`;
}
export function decodeBossPageResult(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 6291456)
    throw failure("collection_browser_output_limit");
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw failure("boss_response_invalid");
  }
  if (
    !result ||
    !Number.isInteger(result.status) ||
    result.status < 0 ||
    result.status > 599
  )
    throw failure("boss_response_invalid");
  return {
    status: result.status,
    ...(result.payload && typeof result.payload === "object"
      ? { payload: result.payload }
      : {}),
    ...(result.code &&
    [
      "boss_ajax_unavailable",
      "collection_cancelled",
      "boss_transport_failed",
      "collection_route_forbidden",
    ].includes(result.code)
      ? { code: result.code }
      : {}),
  };
}
