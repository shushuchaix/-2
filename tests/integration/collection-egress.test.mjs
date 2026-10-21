import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import { createEgressProxy } from "../../src/infrastructure/collection/egress-proxy.mjs";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";
const auth = (client) =>
  "Basic " +
  Buffer.from(client.username + ":" + client.password).toString("base64");
async function tunnel(proxyUrl, client, target = "jobs.example.org:443") {
  return new Promise((resolve, reject) => {
    const req = http.request(proxyUrl, {
      method: "CONNECT",
      path: target,
      headers: { "Proxy-Authorization": auth(client) },
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}
test("proxy checks every DNS answer before connection and rejects a changed private peer", async (t) => {
  let mode = "privateDNS",
    connects = 0;
  const proxy = createEgressProxy({
    resolvePublicUrl: async (value) => ({
      url: new URL(value),
      addresses: [
        { address: mode === "privateDNS" ? "127.0.0.1" : "8.8.8.8", family: 4 },
      ],
    }),
    connect: () => {
      connects++;
      const socket = new Duplex({
        read() {},
        write(b, e, cb) {
          cb();
        },
      });
      socket.remoteAddress = "127.0.0.1";
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  t.after(() => proxy.stop());
  const [a, b] = await Promise.all([proxy.start(), proxy.start()]);
  assert.equal(a.proxyUrl, b.proxyUrl);
  allowLocalOrigin(a.proxyUrl);
  const client = proxy.createClient({ hosts: ["jobs.example.org"] });
  client.grant("https://jobs.example.org/");
  assert.equal(await tunnel(a.proxyUrl, client), 502);
  assert.equal(connects, 0);
  mode = "privatePeer";
  assert.equal(await tunnel(a.proxyUrl, client), 502);
  assert.equal(connects, 1);
});
test("proxy refuses ungranted hosts and abort wakes a connection that never connected", async (t) => {
  let connects = 0;
  const proxy = createEgressProxy({
    resolvePublicUrl: async (value) => ({
      url: new URL(value),
      addresses: [{ address: "8.8.8.8", family: 4 }],
    }),
    connect: () => {
      connects++;
      return new Duplex({
        read() {},
        write(b, e, cb) {
          cb();
        },
      });
    },
  });
  t.after(() => proxy.stop());
  const { proxyUrl } = await proxy.start();
  allowLocalOrigin(proxyUrl);
  const abort = new AbortController(),
    client = proxy.createClient({
      hosts: ["jobs.example.org"],
      signal: abort.signal,
    });
  assert.equal(await tunnel(proxyUrl, client), 502);
  assert.equal(connects, 0);
  client.grant("https://jobs.example.org/");
  const pending = tunnel(proxyUrl, client);
  while (!connects) await new Promise((r) => setImmediate(r));
  abort.abort();
  assert.equal(await pending, 502);
  assert.equal(client.snapshot().closed, true);
});

test("tunnel resets close both peers without uncaught errors and the proxy remains usable", async (t) => {
  const createServer = http.createServer;
  let downstream;
  t.mock.method(http, "createServer", function (...args) {
    const server = createServer.apply(this, args);
    server.on("connection", (socket) => {
      downstream = socket;
    });
    return server;
  });
  const upstreams = [];
  const proxy = createEgressProxy({
    resolvePublicUrl: async (value) => ({
      url: new URL(value),
      addresses: [{ address: "8.8.8.8", family: 4 }],
    }),
    connect: () => {
      const socket = new Duplex({
        read() {},
        write(_b, _e, cb) {
          cb();
        },
      });
      socket.remoteAddress = "8.8.8.8";
      upstreams.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  t.after(() => proxy.stop());
  const { proxyUrl } = await proxy.start();
  allowLocalOrigin(proxyUrl);
  const client = proxy.createClient({ hosts: ["jobs.example.org"] });
  client.grant("https://jobs.example.org/");
  const reset = () =>
    Object.assign(Error("synthetic reset"), { code: "ECONNRESET" });
  const heldTunnel = () =>
    new Promise((resolve, reject) => {
      const request = http.request(proxyUrl, {
        method: "CONNECT",
        path: "jobs.example.org:443",
        headers: { "Proxy-Authorization": auth(client) },
      });
      request.on("connect", (response, socket) => {
        socket.on("error", () => socket.destroy());
        assert.equal(response.statusCode, 200);
        resolve(socket);
      });
      request.on("error", reject);
      request.end();
    });
  const first = await heldTunnel();
  t.after(() => first.destroy());
  const firstClosed = new Promise((resolve) =>
    downstream.once("close", resolve),
  );
  assert.doesNotThrow(() => downstream.emit("error", reset()));
  await firstClosed;
  assert.equal(downstream.destroyed, true);
  assert.equal(upstreams[0].destroyed, true);
  const second = await heldTunnel();
  t.after(() => second.destroy());
  const secondClosed = new Promise((resolve) =>
    downstream.once("close", resolve),
  );
  assert.doesNotThrow(() => upstreams[1].emit("error", reset()));
  assert.doesNotThrow(() => upstreams[1].emit("error", reset()));
  await secondClosed;
  assert.equal(downstream.destroyed, true);
  assert.equal(upstreams[1].destroyed, true);
  assert.equal(await tunnel(proxyUrl, client), 200);
});

function captureServer(t) {
  const captured = { sockets: [], requests: [], tunnels: [] };
  const createServer = http.createServer;
  t.mock.method(http, "createServer", function (handler) {
    const server = createServer.call(this, (req, res) => {
      const pending = handler(req, res);
      captured.requests.push({ req, res, pending });
    });
    captured.server = server;
    server.on("connection", (socket) => captured.sockets.push(socket));
    return server;
  });
  return captured;
}
function captureTunnelHandler(captured) {
  const [handler] = captured.server.listeners("connect");
  captured.server.removeListener("connect", handler);
  captured.server.on("connect", (...args) => {
    captured.tunnels.push(handler(...args));
  });
}
const reset = () =>
  Object.assign(Error("synthetic reset"), { code: "ECONNRESET" });
const resolvedPublic = (value) => ({
  url: new URL(value),
  addresses: [{ address: "8.8.8.8", family: 4 }],
});
function fakePeer() {
  const socket = new Duplex({
    read() {},
    write(_b, _e, cb) {
      cb();
    },
  });
  socket.remoteAddress = "8.8.8.8";
  return socket;
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

for (const side of ["req", "res"]) {
  test(`HTTP ${side} resets during DNS close the request without opening an orphan peer`, async (t) => {
    const captured = captureServer(t);
    let releaseDns,
      connects = 0;
    const proxy = createEgressProxy({
      resolvePublicUrl: async (value) => {
        await new Promise((resolve) => {
          releaseDns = resolve;
        });
        return resolvedPublic(value);
      },
      connect: () => {
        connects++;
        const peer = fakePeer();
        queueMicrotask(() => peer.emit("connect"));
        return peer;
      },
    });
    const { proxyUrl } = await proxy.start();
    allowLocalOrigin(proxyUrl);
    const client = proxy.createClient({ hosts: ["jobs.example.org"] });
    client.grant("https://jobs.example.org/");
    const request = http.request(proxyUrl, {
      path: "http://jobs.example.org/",
      headers: { "Proxy-Authorization": auth(client) },
    });
    request.on("error", () => {});
    t.after(async () => {
      for (const entry of captured.requests) {
        entry.req.on("error", () => {});
        entry.res.on("error", () => {});
      }
      request.destroy();
      releaseDns?.();
      await Promise.all(captured.requests.map((entry) => entry.pending));
      await proxy.stop();
    });
    request.end();
    while (!releaseDns) await nextTurn();
    const entry = captured.requests[0];
    const closed = new Promise((resolve) => entry.res.once("close", resolve));
    assert.doesNotThrow(() => entry[side].emit("error", reset()));
    await closed;
    releaseDns();
    await entry.pending;
    assert.equal(connects, 0);
    assert.equal(entry.req.destroyed, true);
    assert.equal(entry.res.destroyed, true);
    assert.equal(client.snapshot().closed, false);
  });
}

test("CONNECT disconnect during DNS does not open a new upstream", async (t) => {
  const captured = captureServer(t);
  let releaseDns,
    connects = 0;
  const proxy = createEgressProxy({
    resolvePublicUrl: async (value) => {
      await new Promise((resolve) => {
        releaseDns = resolve;
      });
      return resolvedPublic(value);
    },
    connect: () => {
      connects++;
      const socket = fakePeer();
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  const { proxyUrl } = await proxy.start();
  allowLocalOrigin(proxyUrl);
  captureTunnelHandler(captured);
  const client = proxy.createClient({ hosts: ["jobs.example.org"] });
  client.grant("https://jobs.example.org/");
  const request = http.request(proxyUrl, {
    method: "CONNECT",
    path: "jobs.example.org:443",
    headers: { "Proxy-Authorization": auth(client) },
  });
  request.on("error", () => {});
  t.after(async () => {
    request.destroy();
    releaseDns?.();
    await Promise.all(captured.tunnels);
    await proxy.stop();
  });
  request.end();
  while (!releaseDns) await nextTurn();
  const downstream = captured.sockets[0];
  const closed = new Promise((resolve) => downstream.once("close", resolve));
  downstream.destroy();
  await closed;
  releaseDns();
  await captured.tunnels[0];
  assert.equal(connects, 0);
  assert.equal(client.snapshot().closed, false);
});

for (const mode of ["CONNECT", "HTTP"]) {
  test(`${mode} disconnect during dialing destroys its pending upstream`, async (t) => {
    const captured = captureServer(t),
      peers = [];
    const proxy = createEgressProxy({
      resolvePublicUrl: async (value) => resolvedPublic(value),
      connect: () => {
        const peer = fakePeer();
        peers.push(peer);
        return peer;
      },
    });
    const { proxyUrl } = await proxy.start();
    allowLocalOrigin(proxyUrl);
    captureTunnelHandler(captured);
    const client = proxy.createClient({ hosts: ["jobs.example.org"] });
    client.grant("https://jobs.example.org/");
    const request = http.request(proxyUrl, {
      method: mode === "CONNECT" ? "CONNECT" : "GET",
      path:
        mode === "CONNECT"
          ? "jobs.example.org:443"
          : "http://jobs.example.org/",
      headers: { "Proxy-Authorization": auth(client) },
    });
    request.on("error", () => {});
    t.after(async () => {
      request.destroy();
      for (const peer of peers) peer.destroy();
      await Promise.all([
        ...captured.tunnels,
        ...captured.requests.map((entry) => entry.pending),
      ]);
      await proxy.stop();
    });
    request.end();
    while (!peers.length) await nextTurn();
    const downstream = captured.sockets[0];
    const closed = new Promise((resolve) => downstream.once("close", resolve));
    downstream.destroy();
    await closed;
    assert.equal(peers[0].destroyed, true);
    await Promise.all([
      ...captured.tunnels,
      ...captured.requests.map((entry) => entry.pending),
    ]);
    assert.equal(peers.length, 1);
    assert.equal(client.snapshot().closed, false);
  });
}

for (const side of ["req", "res"]) {
  test(`HTTP ${side} resets close an active peer while complete responses and later requests remain usable`, async (t) => {
    const fixture = http.createServer((req, res) => {
      req.on("error", () => res.destroy());
      res.on("error", () => res.destroy());
      if (req.url === "/hold") res.write("synthetic pending body");
      else res.end("synthetic complete body");
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const fixturePort = fixture.address().port;
    allowLocalOrigin("http://127.0.0.1:" + fixturePort);
    const captured = captureServer(t),
      peers = [],
      requests = [];
    const requestTransport = http.request;
    t.mock.method(http, "request", function (...args) {
      if (args[0]?.hostname === "jobs.example.org") {
        args[0] = { ...args[0], hostname: "127.0.0.1", port: fixturePort };
      }
      return requestTransport.apply(this, args);
    });
    const proxy = createEgressProxy({
      resolvePublicUrl: async (value) => resolvedPublic(value),
      connect: () => {
        const peer = net.connect({ host: "127.0.0.1", port: fixturePort });
        Object.defineProperty(peer, "remoteAddress", { get: () => "8.8.8.8" });
        peers.push(peer);
        return peer;
      },
    });
    t.after(async () => {
      for (const request of requests) request.destroy();
      await proxy.stop();
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    });
    const { proxyUrl } = await proxy.start();
    allowLocalOrigin(proxyUrl);
    const client = proxy.createClient({ hosts: ["jobs.example.org"] });
    client.grant("https://jobs.example.org/");
    const get = (pathname) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          proxyUrl,
          {
            path: "http://jobs.example.org" + pathname,
            headers: { "Proxy-Authorization": auth(client) },
          },
          (response) => {
            response.on("error", () => {});
            resolve(response);
          },
        );
        requests.push(request);
        request.on("error", reject);
        request.end();
      });
    const read = async () => {
      const response = await get("/complete");
      let body = "";
      for await (const bytes of response) body += bytes;
      assert.equal(response.statusCode, 200);
      return body;
    };
    assert.equal(await read(), "synthetic complete body");
    await get("/hold");
    const entry = captured.requests.at(-1),
      peer = peers.at(-1);
    const closed = new Promise((resolve) => entry.res.once("close", resolve));
    assert.doesNotThrow(() => entry[side].emit("error", reset()));
    await closed;
    assert.equal(peer.destroyed, true);
    assert.equal(entry.res.destroyed, true);
    assert.equal(client.snapshot().closed, false);
    assert.equal(await read(), "synthetic complete body");
  });
}
