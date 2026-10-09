import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
