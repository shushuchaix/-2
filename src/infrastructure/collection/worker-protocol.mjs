import path from "node:path";
import {
  publicCollectionUrl,
  platformPolicy,
  allowsRoute,
} from "../../../electron/collection/network-policy.mjs";
const error = () =>
  Object.assign(Error("匿名采集协议无效。"), {
    code: "collection_worker_protocol",
  });
export const RULES = new Set([
  "wechat_article_v1",
  "weibo_post_v1",
  "official_article_v1",
]);
export function validateWorkerRequest(input) {
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          "protocolVersion",
          "kind",
          "requestId",
          "mode",
          "publicRoute",
          "ruleId",
          "limits",
          "timeoutMs",
        ].includes(k),
    ) ||
    input.protocolVersion !== 1 ||
    input.kind !== "read" ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(input.requestId) ||
    !["static", "dynamic", "enhanced"].includes(input.mode) ||
    !RULES.has(input.ruleId)
  )
    throw error();
  const route = input.publicRoute;
  if (
    !route ||
    Object.keys(route).some(
      (k) => !["providerId", "url", "allowedDomains"].includes(k),
    )
  )
    throw error();
  const url = publicCollectionUrl(route.url),
    provider = route.providerId;
  let policy;
  if (provider === "wechat-public") policy = platformPolicy("wechat");
  else if (provider === "weibo-public") policy = platformPolicy("weibo");
  else if (
    provider === "official-public" &&
    input.ruleId === "official_article_v1" &&
    Array.isArray(route.allowedDomains) &&
    route.allowedDomains.length <= 30
  )
    policy = { hosts: route.allowedDomains };
  else throw error();
  if (
    !allowsRoute(url.href, policy) ||
    (provider === "wechat-public" && input.ruleId !== "wechat_article_v1") ||
    (provider === "weibo-public" && input.ruleId !== "weibo_post_v1")
  )
    throw error();
  const l = input.limits;
  if (
    !l ||
    Object.keys(l).some(
      (k) => !["maxRequests", "maxWireBytes", "maxDomBytes"].includes(k),
    ) ||
    !Number.isSafeInteger(l.maxRequests) ||
    l.maxRequests < 1 ||
    l.maxRequests > 60 ||
    !Number.isSafeInteger(l.maxWireBytes) ||
    l.maxWireBytes < 1 ||
    l.maxWireBytes > 20971520 ||
    !Number.isSafeInteger(l.maxDomBytes) ||
    l.maxDomBytes < 1 ||
    l.maxDomBytes > 6291456 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 45000
  )
    throw error();
  return { ...input, publicUrl: url.href, routePolicy: policy };
}
export function workerEnvironment(source, root) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (typeof source[key] === "string") env[key] = source[key];
  env.PLAYWRIGHT_BROWSERS_PATH = path
    .join(root, "browsers")
    .replaceAll("\\", "/");
  env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}
export function createJsonLineReader({
  maxBytes = 8388608,
  onMessage = () => {},
} = {}) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let index;
      while ((index = pending.indexOf(10)) >= 0) {
        if (index > maxBytes) throw error();
        const line = pending.subarray(0, index);
        pending = pending.subarray(index + 1);
        if (!line.length) continue;
        let value;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          throw error();
        }
        onMessage(value);
      }
      if (pending.length > maxBytes) throw error();
    },
    finish() {
      if (pending.length) throw error();
    },
  };
}
export function validateWorkerResult(value, request) {
  if (
    !value ||
    value.protocolVersion !== 1 ||
    value.kind !== "result" ||
    value.requestId !== request.requestId ||
    ![
      "complete",
      "incomplete",
      "restricted",
      "challenge_required",
      "login_required",
      "unavailable",
      "redirect_required",
    ].includes(value.bodyStatus) ||
    !Number.isInteger(value.status) ||
    value.status < 0 ||
    value.status > 599 ||
    typeof value.html !== "string" ||
    Buffer.byteLength(value.html) > request.limits.maxDomBytes ||
    publicCollectionUrl(value.url).href !== request.publicUrl ||
    !Number.isSafeInteger(value.requests) ||
    value.requests < 0 ||
    value.requests > request.limits.maxRequests
  )
    throw error();
  return {
    status: value.status,
    url: value.url,
    html: value.html,
    text: value.html,
    bodyStatus: value.bodyStatus,
    channel: "anonymous_" + request.mode,
    usage: { requests: value.requests },
  };
}
