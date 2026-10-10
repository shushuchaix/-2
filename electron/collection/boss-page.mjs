import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
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
function pageRead(operation, id) {
  return new Promise((resolve) => {
    const $ = window.$;
    if (
      typeof $?.ajax !== "function" ||
      typeof $.ajaxSettings?.beforeSend !== "function"
    ) {
      resolve(JSON.stringify({ status: 0, code: "boss_ajax_unavailable" }));
      return;
    }
    const key = "__rjrBoss_" + id;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      delete window[key];
      resolve(JSON.stringify(value));
    };
    try {
      const xhr = $.ajax({
        url: operation.url,
        type: operation.method,
        data: operation.parameters,
        dataType: "json",
        timeout: 45000,
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
export function bossPageScript(operation, id) {
  return `(${pageRead.toString()})(${JSON.stringify(validateBossOperation(operation))},${JSON.stringify(id)})`;
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
    ].includes(result.code)
      ? { code: result.code }
      : {}),
  };
}
