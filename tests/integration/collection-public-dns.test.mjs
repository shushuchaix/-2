import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionPublicResolver } from "../../electron/collection/public-dns.mjs";
import { createEgressProxy } from "../../src/infrastructure/collection/egress-proxy.mjs";
import { Duplex } from "node:stream";
import http from "node:http";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";

test("the egress client uses its owned resolver instead of the unsafe system Fake-IP answer", async (t) => {
  let connects = 0,
    resolved = 0;
  const proxy = createEgressProxy({
    resolvePublicUrl: async (value) => ({
      url: new URL(value),
      addresses: [{ address: "198.18.0.1", family: 4 }],
    }),
    connect: () => {
      connects++;
      const socket = new Duplex({
        read() {},
        write(_b, _e, cb) {
          cb();
        },
      });
      socket.remoteAddress = "8.8.8.8";
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  t.after(() => proxy.stop());
  const { proxyUrl } = await proxy.start();
  allowLocalOrigin(proxyUrl);
  const client = proxy.createClient({
    hosts: ["jobs.example.org"],
    resolvePublicUrl: async (value) => {
      resolved++;
      return {
        url: new URL(value),
        addresses: [{ address: "8.8.8.8", family: 4 }],
      };
    },
  });
  client.grant("https://jobs.example.org/");
  const status = await new Promise((resolve, reject) => {
    const req = http.request(proxyUrl, {
      method: "CONNECT",
      path: "jobs.example.org:443",
      headers: {
        "Proxy-Authorization":
          "Basic " +
          Buffer.from(client.username + ":" + client.password).toString(
            "base64",
          ),
      },
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 200);
  assert.equal(resolved, 1);
  assert.equal(connects, 1);
});
function fixture({
  addresses = [{ address: "198.18.0.1", family: 4 }],
  blocked = false,
} = {}) {
  const ref = {
      scope: { packageId: "synthetic", targetRevisionId: "synthetic@1" },
      activityId: "synthetic-root",
    },
    token = { sliceRunId: "synthetic-slice", epoch: 1 },
    operationLease = { operationId: "synthetic-lease", token: "synthetic" };
  const reservations = [],
    settlements = [],
    wire = [];
  const ledger = {
    reserve: async (input) => {
      if (blocked)
        throw Object.assign(Error("source_budget_exhausted"), {
          code: "source_budget_exhausted",
        });
      reservations.push(input);
      return input;
    },
    settle: async (input) => {
      settlements.push(input);
    },
  };
  const resolver = createCollectionPublicResolver({
    ledger,
    ref,
    token,
    operationLease,
    lookup: async () => addresses,
    transport: async (request) => {
      wire.push(request);
      const text = JSON.stringify({
        Status: 0,
        Answer:
          request.url.searchParams.get("type") === "A"
            ? [{ type: 1, data: "8.8.8.8", TTL: 30 }]
            : [],
      });
      return { status: 200, text };
    },
  });
  return {
    resolver,
    reservations,
    settlements,
    wire,
    ref,
    token,
    operationLease,
  };
}
test("Fake-IP fallback reserves and settles both DNS reads in the same activity", async () => {
  const f = fixture();
  const result = await f.resolver("https://jobs.example.org/");
  assert.deepEqual(result.addresses, [{ address: "8.8.8.8", family: 4 }]);
  assert.equal(f.reservations.length, 2);
  assert.equal(f.settlements.length, 2);
  for (const r of f.reservations) {
    assert.equal(r.kind, "dns");
    assert.equal(r.ref, f.ref);
    assert.equal(r.token, f.token);
    assert.equal(r.operationLease, f.operationLease);
    assert.equal(r.requestUpperBound, 1);
    assert.equal(r.bytesUpperBound, 65536);
  }
  assert.ok(
    f.settlements.every(
      (r) => r.verifiedUsage.requests === 1 && r.verifiedUsage.bytes > 0,
    ),
  );
  await f.resolver("https://jobs.example.org/");
  assert.equal(f.wire.length, 2);
});
test("private DNS answers are rejected and do not activate the Fake-IP fallback", async () => {
  const f = fixture({ addresses: [{ address: "127.0.0.1", family: 4 }] });
  await assert.rejects(f.resolver("https://jobs.example.org/"));
  assert.equal(f.wire.length, 0);
  assert.equal(f.reservations.length, 0);
});
test("exhausted activity allowance blocks DNS before any wire transmission", async () => {
  const f = fixture({ blocked: true });
  await assert.rejects(
    f.resolver("https://jobs.example.org/"),
    (e) => e.code === "source_budget_exhausted",
  );
  assert.equal(f.wire.length, 0);
});

test("concurrent assets of one owned window share one in-flight DNS pair without sharing other windows", async () => {
  const a = fixture(),
    b = fixture();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      a.resolver("https://jobs.example.org/asset-" + n + ".js"),
    ),
  );
  assert.ok(results.every((v) => v.addresses[0].address === "8.8.8.8"));
  assert.equal(a.reservations.length, 2);
  assert.equal(a.wire.length, 2);
  assert.equal(a.settlements.length, 2);
  await b.resolver("https://jobs.example.org/asset.js");
  assert.equal(b.wire.length, 2);
  await Promise.all([a.resolver.close(), b.resolver.close()]);
});

function slowDnsFixture() {
  const reservations = [],
    settlements = [];
  let active = 0,
    started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const resolver = createCollectionPublicResolver({
    mode: "doh",
    ledger: {
      reserve: async (input) => {
        reservations.push(input);
        return input;
      },
      settle: async (input) => settlements.push(input),
    },
    ref: {
      scope: { packageId: "synthetic", targetRevisionId: "synthetic@1" },
      activityId: "synthetic-root",
    },
    token: { sliceRunId: "synthetic-slice", epoch: 1 },
    operationLease: { operationId: "synthetic-lease", token: "synthetic" },
    transport: async (request) => {
      active++;
      try {
        if (request.url.searchParams.get("type") === "A")
          return { status: 500, text: "unavailable" };
        started();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          const abort = () => {
            clearTimeout(timer);
            reject(request.signal.reason);
          };
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
        return { status: 200, text: JSON.stringify({ Status: 0, Answer: [] }) };
      } finally {
        active--;
      }
    },
  });
  return { resolver, ready, reservations, settlements, active: () => active };
}

test("a failed DNS family cancels and drains its sibling before rejection", async () => {
  const f = slowDnsFixture();
  await assert.rejects(
    f.resolver("https://jobs.example.org/"),
    (e) => e.code === "public_dns_unavailable",
  );
  assert.equal(f.active(), 0);
  const settled = f.settlements.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(f.settlements.length, settled);
  assert.equal(f.reservations.length, 2);
});

test("closing a resolver drains owned queries and rejects later public-IP reads", async () => {
  const f = slowDnsFixture();
  const pending = f.resolver("https://jobs.example.org/");
  const rejected = assert.rejects(pending);
  await f.ready;
  await f.resolver.close();
  await rejected;
  assert.equal(f.active(), 0);
  await assert.rejects(f.resolver("https://8.8.8.8/"));
});

test("closing concurrent DNS subscribers drains the shared families and rejects every subscriber", async () => {
  const f = slowDnsFixture();
  const pending = Array.from({ length: 12 }, (_, n) =>
    f.resolver("https://jobs.example.org/" + n),
  );
  const rejected = Promise.all(pending.map((task) => assert.rejects(task)));
  await f.ready;
  await f.resolver.close();
  await rejected;
  assert.equal(f.active(), 0);
  assert.equal(f.reservations.length, 2);
});
