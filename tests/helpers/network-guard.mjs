import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
const failure = () => {
  throw new Error(
    "offline_network_forbidden: inject a transport or allow an isolated local endpoint",
  );
};
const allowed = new Set(
  (process.env.RJR_TEST_ALLOWED_ORIGINS || "").split(",").filter(Boolean),
);
export function allowLocalOrigin(value) {
  const url = new URL(value);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw Error("Only isolated local test origins allowed");
  allowed.add(url.origin);
}
const isAllowed = (args) => {
  if (!allowed.size) return false;
  try {
    const a = args[0];
    let url;
    if (typeof a === "string" || a instanceof URL) url = new URL(a);
    else if (a && typeof a === "object")
      url = new URL(
        (a.protocol || "http:") +
          "//" +
          (a.hostname || a.host || "localhost") +
          ":" +
          (a.port || 80),
      );
    return (
      url &&
      allowed.has(url.origin) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};
for (const object of [http, https])
  for (const key of ["get", "request"]) {
    const original = object[key];
    object[key] = function (...args) {
      if (!isAllowed(args)) failure();
      return original.apply(this, args);
    };
  }
// Native connect is blocked unless an explicitly permitted localhost port is used.
const socketAllowed = (args) => {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host, port;
  if (typeof a === "object") {
    host = a.host || "localhost";
    port = a.port;
  } else {
    port = a;
    host = typeof args[1] === "string" ? args[1] : "localhost";
  }
  return (
    ["localhost", "127.0.0.1", "::1"].includes(host) &&
    [...allowed].some((o) => new URL(o).port === String(port))
  );
};
for (const object of [net, tls])
  for (const key of ["connect", "createConnection"].filter(
    (k) => typeof object[k] === "function",
  )) {
    const original = object[key];
    object[key] = function (...args) {
      if (!socketAllowed(args)) failure();
      return original.apply(this, args);
    };
  }
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (!socketAllowed(args)) failure();
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  if (!isAllowed(args))
    return Promise.reject(new Error("offline_network_forbidden"));
  return originalFetch(...args);
};
syncBuiltinESMExports();
