import {
  canonicalSocialUrl,
  parseSocialResponse,
} from "../sources/social-content.mjs";
import { platformPolicy } from "../../electron/collection/network-policy.mjs";
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
    async read(input) {
      const { providerId, signal } = input,
        platform = providerId,
        url = canonicalSocialUrl(input.url, platform),
        request = input.request || defaultRequest;
      signal?.throwIfAborted();
      const parse = (r) => ({
        status: r.status ?? 200,
        channel: r.channel,
        usage: r.usage,
        nextDueAt: r.nextDueAt,
        ...parseSocialResponse({
          platform,
          url: r.url || url,
          status: r.status ?? 200,
          text: r.text || r.html || "",
        }),
        checkedAt: new Date(clock.now()).toISOString(),
      });
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
