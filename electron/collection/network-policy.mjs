import { validatePublicUrl } from "../../src/infrastructure/http/public-url.mjs";
import {
  BOSS_SEARCH_URL,
  BOSS_DETAIL_URL,
} from "../../src/sources/boss/protocol.mjs";
import {
  isNativePublicSearchPolicy,
  allowsNativePublicSearchUrl,
  allowsNativePublicPage,
  isNativePublicSearchRequest,
} from "./native-public-search.mjs";
import {
  bossOperationHeader,
  stripBossOperationHeader,
  validBossOperationToken,
} from "./boss-operation-ownership.mjs";
const material =
  /^(?:.*token|api_?key|key|uin|pass_ticket|wx_header|auth(?:orization)?|cookie|ticket|signature|x-amz-signature|code|password|secret)$/i;
export function publicCollectionUrl(value) {
  const url = validatePublicUrl(value);
  if (url.hash || [...url.searchParams.keys()].some((k) => material.test(k)))
    throw Object.assign(Error("Authenticated route forbidden"), {
      code: "collection_route_forbidden",
    });
  return url;
}
const hostAllowed = (host, list) =>
  list.some((v) =>
    v.startsWith("*.")
      ? host.endsWith(v.slice(1)) && host !== v.slice(2)
      : host === v,
  );
function bossManualLanding(url) {
  if (url.pathname !== "/") return false;
  // Homepage filters and DOM anchors do not grant new routes or authenticated
  // actions. Unknown redirect/credential keys and SPA routes remain denied.
  if (url.hash && !["#jobs", "#search", "#home"].includes(url.hash))
    return false;
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1) return false;
    if (key === "ka" && /^[A-Za-z0-9_.-]{1,160}$/.test(value)) continue;
    if (key === "city" && /^\d{9}$/.test(value)) continue;
    return false;
  }
  return true;
}
function bossStaticAsset(url, resourceType, manual = false) {
  try {
    publicCollectionUrl(url.href);
  } catch {
    return false;
  }
  if (
    url.search ||
    !/^\/[A-Za-z0-9._~/-]+$/.test(url.pathname) ||
    url.pathname
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  )
    return false;
  const kind = /\.js$/.test(url.pathname)
    ? "script"
    : /\.css$/.test(url.pathname)
      ? "stylesheet"
      : /\.(?:woff2?|ttf|otf)$/.test(url.pathname)
        ? "font"
        : /\.(?:png|jpe?g|gif|svg|webp|ico)$/.test(url.pathname)
          ? "image"
          : null;
  if (!kind || kind !== resourceType) return false;
  if (url.hostname === "img.bosszhipin.com")
    return url.pathname === "/static/zhipin/geek/sdk/browser-check-v2.js";
  if (url.hostname !== "static.zhipin.com") return false;
  return (
    (manual &&
      (/^\/zhipin-sign\/v\d+\/static\/(?:js|css|fonts|images|img)\//.test(
        url.pathname,
      ) ||
        url.pathname === "/assets/sdk/apm/patas.2.3.0.min.js" ||
        /^\/assets\/sdk\/bzl-qrcode\/\d+\.png$/.test(url.pathname))) ||
    /^\/zhipin-geek-spa\/web\/v\d+\/static\/(?:js|css|fonts|img)\//.test(
      url.pathname,
    ) ||
    [
      "/library/js/lib/jquery-1.12.2.min.js",
      "/library/js/lib/vue-core-v1.0.0.min.js",
      "/library/js/utils/lottie_light-v5.9.4.min.js",
      "/assets/zhipin/geek/boss-ui/bossui.min.js",
      "/assets/zhipin/geek/boss-ui/ui-business.min.js",
      "/assets/zhipin/geek/boss-ui/bossui.css",
      "/v2/web/geek/css/prop-mall.css",
      "/assets/sdk/apm/patas.2.3.3.min.js",
      "/assets/sdk/warlock/warlockdata.min.2.2.15.js",
    ].includes(url.pathname)
  );
}
export function platformPolicy(platform) {
  if (platform === "boss")
    return {
      platform,
      entryUrl: "https://www.zhipin.com/web/geek/jobs",
      loginEntryUrl: "https://www.zhipin.com/web/user/",
      hosts: [
        "www.zhipin.com",
        "zhipin.com",
        "static.zhipin.com",
        "img.bosszhipin.com",
      ],
      strictPath: true,
      publicPath: (url, { resourceType = "mainFrame", manual = false } = {}) =>
        bossStaticAsset(url, resourceType, manual) ||
        (url.hostname === "www.zhipin.com" &&
          ((manual && resourceType === "mainFrame" && bossManualLanding(url)) ||
            /^\/web\/geek\/jobs\/?$|^\/job_detail\/[A-Za-z0-9_~.-]+\.html$|^\/(?:assets|static)\//.test(
              url.pathname,
            ) ||
            [
              new URL(BOSS_SEARCH_URL).pathname,
              new URL(BOSS_DETAIL_URL).pathname,
              "/favicon.ico",
            ].includes(url.pathname))),
      manualPath: (url) =>
        url.hostname === "www.zhipin.com" &&
        /^\/web\/user(?:\/|$)|^\/wapi\/zppassport\//.test(url.pathname),
    };
  if (platform === "wechat")
    return {
      platform,
      entryUrl: "https://mp.weixin.qq.com/",
      hosts: [
        "mp.weixin.qq.com",
        "weixin.qq.com",
        "open.weixin.qq.com",
        "res.wx.qq.com",
        "mmbiz.qpic.cn",
        "mmbiz.qlogo.cn",
        "wx.qlogo.cn",
      ],
      bodySelector: "#js_content",
      publicPath: (url) =>
        url.hostname !== "mp.weixin.qq.com" ||
        /^\/s(?:\/|$)|^\/mp\/(?:profile_ext|appmsgalbum)/.test(url.pathname),
    };
  if (platform === "weibo")
    return {
      platform,
      entryUrl: "https://weibo.com/login.php",
      hosts: [
        "weibo.com",
        "www.weibo.com",
        "m.weibo.cn",
        "weibo.cn",
        "passport.weibo.com",
        "passport.weibo.cn",
        "login.sina.com.cn",
        "*.sinaimg.cn",
        "*.weibocdn.com",
        "*.sinaimg.com",
      ],
      bodySelector: ".weibo-text",
      publicPath: (url) =>
        /^(?:\/(?:detail|status|u|profile)\/[A-Za-z0-9]+\/?|\/[0-9]+\/[A-Za-z0-9]+\/?|\/api\/(?:container\/getIndex|statuses\/(?:show|extend)|profile)|\/ajax\/(?:statuses\/(?:show|longtext|mymblog)|profile\/info))$/.test(
          decodeURIComponent(url.pathname),
        ),
    };
  throw Object.assign(Error("Unsupported collection platform"), {
    code: "collection_platform_invalid",
  });
}
export function allowsRoute(
  value,
  routePolicy,
  { manual = false, resourceType = "mainFrame" } = {},
) {
  try {
    const url =
      manual ||
      routePolicy.platform === "boss" ||
      allowsNativePublicSearchUrl(value, routePolicy)
        ? validatePublicUrl(value)
        : publicCollectionUrl(value);
    return (
      url.protocol === "https:" &&
      (!url.port || url.port === "443") &&
      hostAllowed(url.hostname, routePolicy.hosts) &&
      (!isNativePublicSearchPolicy(routePolicy) ||
        allowsNativePublicPage(value, routePolicy)) &&
      (routePolicy.strictPath
        ? routePolicy.publicPath(url, { resourceType, manual }) ||
          (manual && routePolicy.manualPath?.(url))
        : !["mainFrame", "xhr"].includes(resourceType) ||
          manual ||
          !routePolicy.publicPath ||
          routePolicy.publicPath(url))
    );
  } catch {
    return false;
  }
}
export function classifyBrowserBody({
  status = 200,
  html = "",
  selectorFound,
} = {}) {
  const expected =
    selectorFound ??
    /(?:id=["']js_content["']|class=["'][^"']*weibo-text[^"']*["'])[^>]*>\s*(?:<[^>]+>\s*)*[^<\s]/.test(
      html,
    );
  if ([401, 403].includes(status)) return { bodyStatus: "restricted" };
  if (
    /<title>[^<]*(?:验证码|安全验证|captcha)|id=["'][^"']*(?:captcha|verify)|访问过于频繁|人机验证/i.test(
      html,
    )
  )
    return { bodyStatus: "challenge_required" };
  if (
    !expected &&
    /<title>[^<]*登录|passport\.weibo|login_required/i.test(html)
  )
    return { bodyStatus: "login_required" };
  return { bodyStatus: status === 200 && expected ? "complete" : "incomplete" };
}
export function createPagePolicy({
  routePolicy,
  reserve,
  prepareRequest,
  onDenied,
  maxRequests = 60,
  manual = false,
  offlineAllows,
  signal,
  webContentsId,
} = {}) {
  let requests = 0,
    closed = false,
    bossSent = false,
    nativePublicSent = false;
  let ownedToken, ownedDenied, ownedNativeId;
  const candidates = new Map();
  const deny = (details, code = "collection_route_forbidden") => {
    if (ownedNativeId !== undefined && details.id === ownedNativeId)
      ownedDenied = code;
    try {
      Promise.resolve(onDenied?.(details, code)).catch(() => {});
    } catch {}
    return { cancel: true };
  };
  const admit = async (details, ownership) => {
    if (closed || signal?.aborted) return deny(details, "collection_cancelled");
    if (requests >= maxRequests)
      return deny(
        details,
        manual
          ? "collection_login_budget_exhausted"
          : "collection_browser_budget_exhausted",
      );
    requests++;
    try {
      await reserve?.(details, ownership);
      signal?.throwIfAborted();
      return { cancel: closed };
    } catch (error) {
      return deny(
        details,
        signal?.aborted
          ? "collection_cancelled"
          : [
                "collection_login_budget_exhausted",
                "source_budget_exhausted",
              ].includes(error?.code)
            ? error.code
            : "collection_request_failed",
      );
    }
  };
  return {
    armBossOperation(token) {
      if (
        manual ||
        routePolicy.platform !== "boss" ||
        !routePolicy.bossOperation ||
        ownedToken ||
        !validBossOperationToken(token)
      )
        throw Object.assign(Error("Owned operation unavailable"), {
          code: "collection_route_forbidden",
        });
      ownedToken = token;
    },
    bossOperationStatus: () => ({
      ...(ownedDenied ? { denied: ownedDenied } : {}),
    }),
    async authorize(details) {
      let operationCandidate,
        validParameters = true;
      const nativePublicPost = isNativePublicSearchRequest(
        details,
        routePolicy,
      );
      if (isNativePublicSearchPolicy(routePolicy)) {
        let url;
        try {
          url = validatePublicUrl(details.url);
        } catch {
          return deny(details);
        }
        if (
          url.hostname === "jobs.bytedance.com" &&
          url.pathname.startsWith("/api/") &&
          url.pathname !== "/api/v1/csrf/token"
        ) {
          if (!nativePublicPost || nativePublicSent) return deny(details);
          nativePublicSent = true;
        }
      }
      if (routePolicy.platform === "boss") {
        let url;
        try {
          url = validatePublicUrl(details.url);
        } catch {
          return deny(details);
        }
        if (
          url.hostname === "www.zhipin.com" &&
          url.pathname === "/" &&
          !["GET", "HEAD"].includes(details.method || "GET")
        )
          return deny(details);
        if (
          ["static.zhipin.com", "img.bosszhipin.com"].includes(url.hostname) &&
          !["GET", "HEAD"].includes(details.method || "GET")
        )
          return deny(details);
        if (url.pathname.startsWith("/wapi/")) {
          const op = routePolicy.bossOperation;
          const expected = op && new URL(op.url);
          const sameOperation =
            expected &&
            url.origin === expected.origin &&
            url.pathname === expected.pathname &&
            (details.method || "GET") === op.method &&
            ((op.kind === "boss.search" &&
              op.url === BOSS_SEARCH_URL &&
              op.method === "POST") ||
              (op.kind === "boss.detail" &&
                op.url === BOSS_DETAIL_URL &&
                op.method === "GET"));
          if (!sameOperation && !(manual && routePolicy.manualPath?.(url)))
            return deny(details);
          if (sameOperation && !manual) {
            if (!ownedToken || !op.parameters) return deny(details);
            operationCandidate = true;
            let values;
            if (op.method === "POST") {
              if (
                !Array.isArray(details.uploadData) ||
                details.uploadData.some((v) => !v.bytes || v.file)
              )
                validParameters = false;
              const body = Buffer.concat(
                (Array.isArray(details.uploadData) ? details.uploadData : [])
                  .filter((v) => v.bytes && !v.file)
                  .map((v) => Buffer.from(v.bytes)),
              );
              if (body.length > 16384) validParameters = false;
              values = new URLSearchParams(body.toString("utf8"));
              if ([...url.searchParams.keys()].some((k) => k !== "_"))
                validParameters = false;
            } else {
              values = new URLSearchParams(url.searchParams);
              values.delete("_");
            }
            if (
              [...values.keys()].length !== Object.keys(op.parameters).length ||
              Object.entries(op.parameters).some(
                ([k, v]) =>
                  values.getAll(k).length !== 1 || values.get(k) !== String(v),
              )
            )
              validParameters = false;
          }
        }
      }
      if (
        closed ||
        signal?.aborted ||
        (offlineAllows && !offlineAllows(details.url)) ||
        (webContentsId && details.webContentsId !== webContentsId) ||
        ["media", "webSocket", "object"].includes(details.resourceType) ||
        ![
          "GET",
          "HEAD",
          ...(manual ||
          nativePublicPost ||
          (routePolicy.platform === "boss" &&
            routePolicy.bossOperation?.kind === "boss.search" &&
            details.url.split("?")[0] === BOSS_SEARCH_URL)
            ? ["POST"]
            : []),
        ].includes(details.method || "GET") ||
        !allowsRoute(details.url, routePolicy, {
          manual,
          resourceType: details.resourceType,
        })
      )
        return deny(
          details,
          closed || signal?.aborted
            ? "collection_cancelled"
            : "collection_route_forbidden",
        );
      if (operationCandidate) {
        if (
          (typeof details.id !== "string" && typeof details.id !== "number") ||
          candidates.size >= 64
        )
          return deny(details);
        candidates.set(details.id, { details, validParameters });
        await prepareRequest?.(details);
        return { cancel: false };
      }
      return admit(details);
    },
    async authorizeHeaders(details) {
      const marker = bossOperationHeader(details.requestHeaders);
      const requestHeaders = stripBossOperationHeader(details.requestHeaders);
      const candidate = candidates.get(details.id);
      candidates.delete(details.id);
      if (!candidate && !marker.present)
        return { cancel: false, requestHeaders };
      if (
        routePolicy.platform !== "boss" ||
        manual ||
        !routePolicy.bossOperation
      )
        return { cancel: true, requestHeaders };
      if (
        !candidate ||
        !ownedToken ||
        marker.value !== ownedToken ||
        !candidate.validParameters ||
        bossSent ||
        ownedDenied ||
        closed ||
        signal?.aborted
      ) {
        if (marker.present) ownedDenied = "collection_route_forbidden";
        return { ...deny(details), requestHeaders };
      }
      // Claim synchronously before awaiting the ledger: concurrent duplicates
      // cannot claim the same owned operation or borrow its response identity.
      bossSent = true;
      ownedNativeId = details.id;
      const result = await admit(candidate.details, {
        ownedBossOperation: true,
      });
      if (result.cancel)
        ownedDenied ||= signal?.aborted
          ? "collection_cancelled"
          : "collection_route_forbidden";
      return { ...result, requestHeaders };
    },
    snapshot: () => ({ requests, manual }),
    close: () => {
      closed = true;
      ownedToken = undefined;
      candidates.clear();
    },
  };
}
const dispatchers = new WeakMap();
export function attachNetworkPolicy(session, key, policy) {
  let state = dispatchers.get(session);
  if (!state) {
    state = new Map();
    dispatchers.set(session, state);
    session.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details, callback) => {
        let called = false;
        const done = (v) => {
          if (!called) {
            called = true;
            callback(v);
          }
        };
        Promise.resolve()
          .then(async () => {
            for (const p of state.values())
              if ((await p.authorize(details)).cancel)
                return done({ cancel: true });
            done({ cancel: false });
          })
          .catch(() => done({ cancel: true }));
      },
    );
    session.webRequest.onBeforeSendHeaders?.(
      { urls: ["<all_urls>"] },
      (details, callback) => {
        Promise.resolve()
          .then(async () => {
            for (const p of state.values())
              if ((await p.authorizeHeaders?.(details))?.cancel)
                return callback({ cancel: true });
            callback({
              cancel: false,
              requestHeaders: stripBossOperationHeader(details.requestHeaders),
            });
          })
          .catch(() => callback({ cancel: true }));
      },
    );
  }
  if (state.has(key)) throw Error("Collection session policy already attached");
  state.set(key, policy);
  return () => {
    state.delete(key);
    if (!state.size) {
      session.webRequest.onBeforeRequest(null);
      session.webRequest.onBeforeSendHeaders?.(null);
      dispatchers.delete(session);
    }
  };
}
