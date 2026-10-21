import {
  canonicalSocialUrl,
  parseSocialResponse,
} from "../sources/social-content.mjs";
import { platformPolicy } from "../../electron/collection/network-policy.mjs";
import { parseHTML } from "linkedom";

function isWechatCaptchaResponse(response) {
  if ((response.status ?? 200) !== 200 || !response.url) return false;
  const finalUrl = new URL(response.url);
  // Classification of an already received response only. This route is never
  // admitted for requests, and its query is neither reused nor returned.
  if (
    finalUrl.origin !== "https://mp.weixin.qq.com" ||
    finalUrl.username ||
    finalUrl.password ||
    finalUrl.pathname !== "/mp/wappoc_appmsgcaptcha"
  )
    return false;
  const { document } = parseHTML(response.text || response.html || "");
  if (document.querySelector("#js_content")) return false;
  for (const node of document.querySelectorAll(
    "script,style,template,[hidden],[aria-hidden='true']",
  ))
    node.remove();
  for (const node of document.querySelectorAll("[style]"))
    if (
      /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\s*;|\s*$)/i.test(
        node.getAttribute("style"),
      )
    )
      node.remove();
  return /环境异常|请完成验证|安全验证|验证码|人机验证|访问过于频繁/.test(
    document.documentElement?.textContent || "",
  );
}

export function createContentReadService({
  request: defaultRequest,
  browser,
  anonymousWorker,
  claimEnhancement,
  clock = { now: Date.now },
} = {}) {
  const service = {
    setBrowser(value) {
      browser = value;
    },
    async readBoss(input) {
      if (!browser?.readBoss)
        throw Object.assign(Error("Boss采集窗口不可用。"), {
          code: "collection_browser_unavailable",
          retryable: false,
        });
      return browser.readBoss(input);
    },
    async read(input) {
      const { providerId, signal } = input,
        platform = providerId,
        url = canonicalSocialUrl(input.url, platform),
        request = input.request || defaultRequest;
      signal?.throwIfAborted();
      const parse = (r) => {
        const metadata = {
          status: r.status ?? 200,
          channel: r.channel,
          usage: r.usage,
          nextDueAt: r.nextDueAt,
          checkedAt: new Date(clock.now()).toISOString(),
        };
        if (platform === "wechat" && isWechatCaptchaResponse(r))
          return {
            ...metadata,
            url,
            bodyStatus: "challenge_required",
            retryEligible: true,
            description: null,
            images: [],
            externalLinks: [],
          };
        return {
          ...metadata,
          ...parseSocialResponse({
            platform,
            url: r.url || url,
            status: r.status ?? 200,
            text: r.text || r.html || "",
          }),
        };
      };
      let result;
      try {
        const response = await request(url, {
          signal,
          maxBytes: 6291456,
          maxRetries: 0,
          diagnosticContext: { sourceId: providerId, endpointKind: "detail" },
        });
        result = parse({ ...response, channel: "public_http" });
      } catch (e) {
        signal?.throwIfAborted();
        if (
          [
            "source_budget_exhausted",
            "collection_stale_epoch",
            "workspace_write_failed",
            "collection_route_forbidden",
          ].includes(e.code)
        )
          throw e;
        result = {
          bodyStatus: "incomplete",
          retryEligible: true,
          code: e.code || "body_unavailable",
          url,
        };
      }
      if (
        result.bodyStatus === "complete" ||
        result.bodyStatus === "challenge_required" ||
        result.status === 429 ||
        ((result.status === 403 || result.status === 401) && !input.sessionRef)
      )
        return result;
      if (browser && input.ref && input.token) {
        try {
          result = parse(
            await browser.read({
              ...input,
              url,
              routePolicy: platformPolicy(platform),
            }),
          );
        } catch (e) {
          signal?.throwIfAborted();
          if (
            [
              "source_budget_exhausted",
              "collection_stale_epoch",
              "workspace_write_failed",
            ].includes(e.code)
          )
            throw e;
          result = { ...result, code: e.code || "browser_unavailable" };
        }
        if (
          result.bodyStatus === "complete" ||
          result.bodyStatus === "challenge_required" ||
          result.status === 429 ||
          result.status === 403
        )
          return result;
      }
      if (
        anonymousWorker &&
        (!anonymousWorker.probe ||
          anonymousWorker.probe().capabilities?.enhanced) &&
        !input.sessionRef &&
        input.ref &&
        input.token &&
        (!claimEnhancement || (await claimEnhancement({ ...input, url })))
      ) {
        try {
          const enhanced = await anonymousWorker.read({
            ...input,
            publicRoute: { providerId: platform + "-public", url },
            extractionRule:
              platform === "wechat" ? "wechat_article_v1" : "weibo_post_v1",
            mode: "enhanced",
          });
          if (enhanced.html || enhanced.text) result = parse(enhanced);
        } catch (e) {
          signal?.throwIfAborted();
          if (
            [
              "source_budget_exhausted",
              "collection_stale_epoch",
              "workspace_write_failed",
            ].includes(e.code)
          )
            throw e;
          result = { ...result, code: e.code || "enhancement_unavailable" };
        }
      }
      return { ...result, retryEligible: result.bodyStatus !== "complete" };
    },
  };
  return service;
}
