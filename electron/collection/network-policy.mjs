import { validatePublicUrl } from "../../src/infrastructure/http/public-url.mjs";
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
export function platformPolicy(platform) {
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
    const url = manual ? validatePublicUrl(value) : publicCollectionUrl(value);
    return (
      url.protocol === "https:" &&
      (!url.port || url.port === "443") &&
      hostAllowed(url.hostname, routePolicy.hosts) &&
      (!["mainFrame", "xhr"].includes(resourceType) ||
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
  maxRequests = 60,
  manual = false,
  offlineAllows,
  signal,
  webContentsId,
} = {}) {
  let requests = 0,
    closed = false;
  return {
    async authorize(details) {
      if (
        closed ||
        signal?.aborted ||
        (offlineAllows && !offlineAllows(details.url)) ||
        (webContentsId && details.webContentsId !== webContentsId) ||
        ["media", "webSocket", "object"].includes(details.resourceType) ||
        !["GET", "HEAD", ...(manual ? ["POST"] : [])].includes(
          details.method || "GET",
        ) ||
        !allowsRoute(details.url, routePolicy, {
          manual,
          resourceType: details.resourceType,
        })
      )
        return { cancel: true };
      if (requests >= maxRequests) return { cancel: true };
      requests++;
      try {
        await reserve?.(details);
        signal?.throwIfAborted();
        return { cancel: closed };
      } catch {
        return { cancel: true };
      }
    },
    snapshot: () => ({ requests, manual }),
    close: () => {
      closed = true;
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
  }
  if (state.has(key)) throw Error("Collection session policy already attached");
  state.set(key, policy);
  return () => {
    state.delete(key);
    if (!state.size) {
      session.webRequest.onBeforeRequest(null);
      dispatchers.delete(session);
    }
  };
}
