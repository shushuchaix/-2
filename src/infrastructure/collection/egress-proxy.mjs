import http from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  resolvePublicUrl as defaultResolve,
  isPublicAddress,
  validatePublicUrl,
} from "../http/public-url.mjs";
export function createEgressProxy({
  resolvePublicUrl = defaultResolve,
  connect = (options) => net.connect(options),
  offlineAllows,
  connectPorts = [443],
} = {}) {
  if (
    !Array.isArray(connectPorts) ||
    !connectPorts.length ||
    connectPorts.some((p) => ![80, 443].includes(p))
  )
    throw Error("Egress ports invalid");
  const clients = new Map(),
    sockets = new Set();
  let server, port, starting;
  const allowedHost = (host, hosts) =>
    hosts.some((v) =>
      v.startsWith("*.")
        ? host.endsWith(v.slice(1)) && host !== v.slice(2)
        : host === v,
    );
  function authenticate(req) {
    const value = req.headers["proxy-authorization"];
    if (
      typeof value !== "string" ||
      value.length > 512 ||
      !value.startsWith("Basic ")
    )
      return null;
    const [id, password] = Buffer.from(value.slice(6), "base64")
        .toString()
        .split(":"),
      client = clients.get(id);
    if (!client || client.closed || !password) return null;
    const a = Buffer.from(password),
      b = Buffer.from(client.password);
    return a.length === b.length && timingSafeEqual(a, b) ? client : null;
  }
  function close(client) {
    client.signal?.removeEventListener("abort", client.revoke);
    client.closed = true;
    for (const socket of client.sockets) socket.destroy();
    clients.delete(client.username);
  }
  function consume(client, bytes) {
    client.bytes += bytes;
    if (client.bytes > client.maxBytes) {
      close(client);
      return false;
    }
    return true;
  }
  async function pinned(client, value) {
    const url = validatePublicUrl(value);
    if (
      (offlineAllows && !offlineAllows(url.href)) ||
      !allowedHost(url.hostname, client.hosts) ||
      !client.grantedHosts.has(url.hostname) ||
      (url.port && url.port !== String(url.protocol === "https:" ? 443 : 80))
    )
      throw Error("Egress route denied");
    const result = await resolvePublicUrl(url.href);
    if (
      client.closed ||
      result.url?.href !== url.href ||
      !result.addresses?.length ||
      result.addresses.some((a) => !isPublicAddress(a.address))
    )
      throw Error("Egress DNS denied");
    return { ...result, client };
  }
  function open(resolved) {
    return new Promise((resolve, reject) => {
      const selected = resolved.addresses[0],
        socket = connect({
          host: selected.address,
          port:
            resolved.url.port ||
            (resolved.url.protocol === "https:" ? 443 : 80),
          family: selected.family,
        });
      let connected = false;
      resolved.client.sockets.add(socket);
      sockets.add(socket);
      socket.setTimeout?.(45000, () => socket.destroy());
      socket.once("error", reject);
      socket.once("close", () => {
        if (!connected) reject(Error("Egress connection closed"));
        sockets.delete(socket);
        resolved.client.sockets.delete(socket);
      });
      socket.once("connect", () => {
        const actual = socket.remoteAddress?.replace(/^::ffff:/, "");
        if (
          !isPublicAddress(actual) ||
          !resolved.addresses.some((a) => a.address === actual)
        ) {
          socket.destroy();
          reject(Error("Egress connection mismatch"));
          return;
        }
        if (resolved.client.closed) {
          socket.destroy();
          return;
        }
        connected = true;
        resolve(socket);
      });
    });
  }
  return {
    async start() {
      if (starting) return starting;
      if (server)
        return {
          proxyUrl: "http://127.0.0.1:" + port,
          stop: () => this.stop(),
        };
      server = http.createServer(async (req, res) => {
        const client = authenticate(req);
        if (!client) {
          res.writeHead(407, {
            "Proxy-Authenticate": 'Basic realm="collection"',
          });
          res.end();
          return;
        }
        try {
          const resolved = await pinned(client, req.url);
          if (
            resolved.url.protocol !== "http:" ||
            !["GET", "HEAD", "POST"].includes(req.method)
          )
            throw Error("Egress HTTP route denied");
          const socket = await open(resolved);
          const headers = {
            ...req.headers,
            host: resolved.url.host,
            connection: "close",
          };
          delete headers["proxy-authorization"];
          delete headers["proxy-connection"];
          const requestHeaderBytes = Buffer.byteLength(
            req.method +
              " " +
              resolved.url.pathname +
              resolved.url.search +
              " HTTP/1.1\r\n" +
              Object.entries(headers)
                .map(([k, v]) => k + ": " + v)
                .join("\r\n") +
              "\r\n\r\n",
          );
          if (!consume(client, requestHeaderBytes))
            throw Error("Egress byte limit");
          const outgoing = http.request(
            {
              hostname: resolved.url.hostname,
              port: 80,
              method: req.method,
              path: resolved.url.pathname + resolved.url.search,
              headers,
              agent: null,
              createConnection: () => socket,
            },
            (response) => {
              if (
                !consume(
                  client,
                  Buffer.byteLength(
                    "HTTP/1.1 " +
                      response.statusCode +
                      " " +
                      response.statusMessage +
                      "\r\n" +
                      response.rawHeaders.join("\r\n") +
                      "\r\n\r\n",
                  ),
                )
              ) {
                response.destroy();
                res.destroy();
                return;
              }
              res.writeHead(response.statusCode, response.headers);
              response.on("data", (b) => {
                if (consume(client, b.length)) res.write(b);
                else res.destroy();
              });
              response.on("end", () => res.end());
              response.on("error", () => res.destroy());
            },
          );
          outgoing.on("error", () => res.destroy());
          req.on("data", (b) => {
            if (!consume(client, b.length)) outgoing.destroy();
          });
          req.pipe(outgoing);
        } catch {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        }
      });
      server.on("connect", async (req, downstream, head) => {
        const client = authenticate(req);
        if (!client) {
          downstream.end(
            'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="collection"\r\n\r\n',
          );
          return;
        }
        try {
          const match = /^([A-Za-z0-9.-]+):(80|443)$/.exec(req.url);
          if (!match || !connectPorts.includes(Number(match[2])))
            throw Error("Egress tunnel target denied");
          const resolved = await pinned(
              client,
              (match[2] === "443" ? "https://" : "http://") + match[1] + "/",
            ),
            upstream = await open(resolved);
          client.sockets.add(downstream);
          sockets.add(downstream);
          downstream.once("close", () => {
            client.sockets.delete(downstream);
            sockets.delete(downstream);
            upstream.destroy();
          });
          upstream.once("close", () => downstream.destroy());
          downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length && consume(client, head.length)) upstream.write(head);
          downstream.on("data", (b) => {
            if (consume(client, b.length)) upstream.write(b);
          });
          upstream.on("data", (b) => {
            if (consume(client, b.length)) downstream.write(b);
          });
        } catch {
          downstream.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }
      });
      server.on("upgrade", (_, socket) => socket.destroy());
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      starting = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          resolve({
            proxyUrl: "http://127.0.0.1:" + port,
            stop: () => this.stop(),
          });
        });
      });
      try {
        return await starting;
      } finally {
        starting = null;
      }
    },
    createClient({ hosts, maxBytes = 20971520, signal }) {
      if (
        !Array.isArray(hosts) ||
        !hosts.length ||
        hosts.length > 30 ||
        hosts.some(
          (h) => typeof h !== "string" || !/^\*?\.?[a-zA-Z0-9.-]+$/.test(h),
        ) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 20971520
      )
        throw Error("Egress client limits invalid");
      const username = randomBytes(16).toString("hex"),
        password = randomBytes(24).toString("hex"),
        client = {
          username,
          password,
          hosts: [...hosts],
          maxBytes,
          bytes: 0,
          grantedHosts: new Set(),
          sockets: new Set(),
          closed: false,
          signal,
        };
      clients.set(username, client);
      const revoke = () => close(client);
      client.revoke = revoke;
      signal?.addEventListener("abort", revoke, { once: true });
      if (signal?.aborted) revoke();
      return {
        username,
        password,
        grant: (url) => {
          const u = validatePublicUrl(url);
          if (!allowedHost(u.hostname, hosts))
            throw Error("Egress grant denied");
          client.grantedHosts.add(u.hostname);
        },
        snapshot: () => ({ bytes: client.bytes, closed: client.closed }),
        revoke,
      };
    },
    async stop() {
      for (const c of clients.values()) close(c);
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise((r) => server.close(r));
      server = null;
      port = null;
    },
  };
}
