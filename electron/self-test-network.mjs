import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { attachNetworkPolicy } from "./collection/network-policy.mjs";

// Loaded only by --self-test. Reject before invoking any original transport.
export function installSelfTestNetworkGuard({
  session,
  allowedOrigin = null,
} = {}) {
  let origin = null;
  const fixtureOrigins = new Set(),
    fixtureUrls = new Set();
  const restorers = [],
    blocked = [];
  const setAllowedOrigin = (value) => {
    if (value === null) {
      origin = null;
      return;
    }
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw Error("invalid_self_test_origin");
    origin = url.origin;
  };
  setAllowedOrigin(allowedOrigin);
  const allows = (value) => {
    try {
      const url = new URL(value);
      return (
        origin !== null &&
        !url.username &&
        !url.password &&
        (fixtureOrigins.has(url.origin) ||
          fixtureUrls.has(url.href) ||
          url.origin === origin ||
          (url.protocol === "ws:" && url.origin === "ws:" + origin.slice(5)))
      );
    } catch {
      return false;
    }
  };
  const reject = () => {
    blocked.push({ code: "offline_network_forbidden" });
    throw Object.assign(Error("offline_network_forbidden"), {
      code: "offline_network_forbidden",
    });
  };
  const patch = (obj, key, wrap) => {
    const original = obj[key];
    if (typeof original !== "function") return;
    obj[key] = wrap(original);
    restorers.push(() => {
      obj[key] = original;
    });
  };
  const requestUrl = (args, protocol) => {
    let [arg, extra] = args;
    if (typeof arg === "string" || arg instanceof URL) {
      const url = new URL(arg);
      if (extra && typeof extra === "object") {
        if (extra.socketPath) return null;
        if (extra.hostname || extra.host)
          url.hostname = extra.hostname || extra.host;
        if (extra.port) url.port = String(extra.port);
        if (extra.protocol) url.protocol = extra.protocol;
      }
      return url.href;
    }
    if (!arg || typeof arg !== "object" || arg.socketPath) return null;
    const host = arg.hostname || arg.host || "localhost";
    return `${arg.protocol || protocol}//${host}:${arg.port || (protocol === "https:" ? 443 : 80)}${arg.path || "/"}`;
  };
  patch(
    globalThis,
    "fetch",
    (original) =>
      async function (input, options) {
        if (
          !allows(
            typeof input === "string" || input instanceof URL
              ? input
              : input?.url,
          )
        )
          reject();
        return original.call(this, input, options);
      },
  );
  for (const [mod, protocol] of [
    [http, "http:"],
    [https, "https:"],
  ])
    for (const key of ["request", "get"])
      patch(
        mod,
        key,
        (original) =>
          function (...args) {
            if (!allows(requestUrl(args, protocol))) reject();
            return original.apply(this, args);
          },
      );
  const socketAllowed = (args) => {
    let arg = args[0];
    if (Array.isArray(arg)) arg = arg[0];
    let host, port;
    if (arg && typeof arg === "object") {
      if (arg.path) return false;
      host = arg.host || arg.hostname || "localhost";
      port = arg.port;
    } else {
      port = arg;
      host = typeof args[1] === "string" ? args[1] : "localhost";
    }
    return allows(`http://${host}:${port}/`);
  };
  for (const [obj, key] of [
    [net, "connect"],
    [net, "createConnection"],
    [net.Socket.prototype, "connect"],
    [tls, "connect"],
  ])
    patch(
      obj,
      key,
      (original) =>
        function (...args) {
          if (!socketAllowed(args)) reject();
          return original.apply(this, args);
        },
    );
  if (typeof globalThis.WebSocket === "function") {
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = class extends Original {
      constructor(url, ...args) {
        if (!allows(url)) reject();
        super(url, ...args);
      }
    };
    restorers.push(() => {
      globalThis.WebSocket = Original;
    });
  }
  const sessionDisposers = new Map();
  const attachSession = (value) => {
    if (sessionDisposers.has(value)) return;
    sessionDisposers.set(
      value,
      attachNetworkPolicy(value, "offline-self-test", {
        async authorize(details) {
          const local = /^(?:about:blank|data:|blob:)/.test(details.url),
            cancel = !local && !allows(details.url);
          if (cancel) blocked.push({ code: "renderer_network_forbidden" });
          return { cancel };
        },
      }),
    );
  };
  if (session) attachSession(session);
  return {
    allowSyntheticOrigin(value) {
      const url = new URL(value);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
        throw Error("invalid_fixture_origin");
      fixtureOrigins.add(url.origin);
      return () => fixtureOrigins.delete(url.origin);
    },
    allowSyntheticUrl(value) {
      if (
        ![
          "https://weibo.com/login.php",
          "https://m.weibo.cn/detail/123",
          "http://mp.weixin.qq.com/s/fixture",
          "http://mp.weixin.qq.com/assets/fixture.js",
        ].includes(value)
      )
        throw Error("invalid_fixture_url");
      fixtureUrls.add(value);
      return () => fixtureUrls.delete(value);
    },
    setAllowedOrigin,
    attachSession,
    allows,
    report: () => ({ externalRequests: 0, blockedRequests: blocked.length }),
    dispose() {
      for (const dispose of sessionDisposers.values()) dispose();
      for (const restore of restorers.reverse()) restore();
    },
  };
}
