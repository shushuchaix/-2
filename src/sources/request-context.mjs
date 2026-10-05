import { AsyncLocalStorage } from "node:async_hooks";
import { createRequestClient } from "../infrastructure/http/client.mjs";
const contexts = new AsyncLocalStorage();
export function withSourceContext(context, fn) {
  return contexts.run(context, fn);
}
export function getSourceContext() {
  return contexts.getStore() || {};
}
export async function sourceFetch(url, options = {}) {
  const context = getSourceContext();
  const signal =
    options.signal && context.signal
      ? AbortSignal.any([options.signal, context.signal])
      : options.signal || context.signal;
  signal?.throwIfAborted();
  const request = context.request || createRequestClient({ signal });
  const result = await request(String(url), { ...options, signal });
  if (
    result.status === 200 &&
    /captcha|人机验证|安全验证|访问过于频繁|验证码/.test(
      result.text?.slice(0, 2000) || "",
    )
  ) {
    const e = Error("captcha: source challenge");
    e.code = "captcha";
    throw e;
  }
  return new Response([204, 304].includes(result.status) ? null : result.text, {
    status: result.status,
    headers: result.headers,
  });
}
