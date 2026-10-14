import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Duplex } from "node:stream";
import { createEgressProxy } from "../../src/infrastructure/collection/egress-proxy.mjs";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";

const scope = { packageId: "owned-qr", targetRevisionId: "target@1" };
const turn = () => new Promise(setImmediate);
for (const idleTimeoutMs of [45000, 120000])
  test(`bounded ${idleTimeoutMs}ms tunnel idle allowance preserves a confirmed-login wait and still closes on deadline`, async (t) => {
    let peer, idle, timeoutCallback;
    const timeouts = [];
    const proxy = createEgressProxy({
      resolvePublicUrl: async (value) => ({
        url: new URL(value),
        addresses: [{ address: "8.8.8.8", family: 4 }],
      }),
      connect: () => {
        peer = new Duplex({
          read() {},
          write(_b, _e, cb) {
            cb();
          },
        });
        peer.remoteAddress = "8.8.8.8";
        peer.setTimeout = (ms, cb) => {
          idle = ms;
          if (cb) timeoutCallback = cb;
          return peer;
        };
        queueMicrotask(() => peer.emit("connect"));
        return peer;
      },
    });
    t.after(() => proxy.stop());
    const { proxyUrl } = await proxy.start();
    allowLocalOrigin(proxyUrl);
    const client = proxy.createClient({
      hosts: ["www.zhipin.com"],
      idleTimeoutMs,
      onTimeout: (event) => timeouts.push(event),
    });
    client.grant("https://www.zhipin.com/");
    const downstream = await new Promise((resolve, reject) => {
      const req = http.request(proxyUrl, {
        method: "CONNECT",
        path: "www.zhipin.com:443",
        headers: {
          "Proxy-Authorization":
            "Basic " +
            Buffer.from(client.username + ":" + client.password).toString(
              "base64",
            ),
        },
      });
      req.once("connect", (res, socket) => {
        assert.equal(res.statusCode, 200);
        socket.on("error", () => {});
        resolve(socket);
      });
      req.on("error", reject);
      req.end();
    });
    t.after(() => downstream.destroy());
    assert.equal(idle, idleTimeoutMs);
    // A synthetic 46-second quiet wait must fit the manual login contract.
    if (idleTimeoutMs === 120000) assert.ok(idle > 100000);
    timeoutCallback();
    for (let i = 0; i < 10 && !downstream.destroyed; i++) await turn();
    assert.equal(peer.destroyed, true);
    assert.equal(timeouts.length, 1);
    assert.deepEqual(timeouts[0], { phase: "idle", timeoutMs: idleTimeoutMs });
    assert.doesNotMatch(
      JSON.stringify(timeouts),
      /zhipin|8\.8\.8|Authorization|password/,
    );
  });

test("the extended login idle wait does not extend a connection handshake", async (t) => {
  let connecting, connectLimit, timeout;
  const proxy = createEgressProxy({
    resolvePublicUrl: async (value) => ({
      url: new URL(value),
      addresses: [{ address: "8.8.8.8", family: 4 }],
    }),
    connect: () => {
      connecting = new Duplex({
        read() {},
        write(_b, _e, cb) {
          cb();
        },
      });
      connecting.remoteAddress = "8.8.8.8";
      connecting.setTimeout = (ms, cb) => {
        connectLimit = ms;
        timeout = cb;
        return connecting;
      };
      return connecting;
    },
  });
  t.after(() => proxy.stop());
  const { proxyUrl } = await proxy.start();
  allowLocalOrigin(proxyUrl);
  const client = proxy.createClient({
    hosts: ["www.zhipin.com"],
    idleTimeoutMs: 120000,
  });
  client.grant("https://www.zhipin.com/");
  const pending = new Promise((resolve, reject) => {
    const req = http.request(proxyUrl, {
      method: "CONNECT",
      path: "www.zhipin.com:443",
      headers: {
        "Proxy-Authorization":
          "Basic " +
          Buffer.from(client.username + ":" + client.password).toString(
            "base64",
          ),
      },
    });
    req.once("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  for (let i = 0; i < 50 && !timeout; i++) await turn();
  assert.equal(connectLimit, 45000);
  timeout();
  assert.equal(await pending, 502);
});

test("only the owned manual Boss window uses the bounded native QR idle wait", async (t) => {
  const base = collectionBrowserFixture(),
    options = [];
  const egressProxy = {
    ...base.egressProxy,
    createClient: (input) => {
      options.push(input);
      return base.egressProxy.createClient(input);
    },
  };
  const entry = {
    ...scope,
    platform: "boss",
    sessionRef: "owned",
    partition: "owned-qr-partition",
  };
  const store = {
    create: async () => entry,
    get: async () => entry,
    readMaterial: async () => ({ cookies: [] }),
    saveMaterial: async () => {},
    setState: async () => {},
    clear: async () => ({ status: "clean" }),
  };
  const browser = createCollectionBrowser({
    ...base,
    egressProxy,
    sessionStore: store,
    ledger: {
      reserve: async () => assert.fail("login cannot spend collection budget"),
    },
  });
  t.after(() => browser.stop());
  await browser.openLogin({
    ref: { scope },
    platform: "boss",
    accountRef: "boss",
  });
  assert.equal(options.length, 1);
  assert.equal(options[0].idleTimeoutMs, 120000);
  assert.equal(options[0].maxBytes, 20971520 - 60 * 65536);
});

test("invalid idle limits are rejected and cannot make an unlimited connection", () => {
  const proxy = createEgressProxy();
  for (const idleTimeoutMs of [0, -1, Infinity, 120001, "120000"])
    assert.throws(
      () => proxy.createClient({ hosts: ["www.zhipin.com"], idleTimeoutMs }),
      /invalid/i,
    );
});

async function loginFixture(t, extras = {}) {
  const base = collectionBrowserFixture(),
    events = [],
    states = [],
    clientOptions = [];
  const createClient = base.egressProxy.createClient;
  base.egressProxy.createClient = (input) => {
    clientOptions.push(input);
    return createClient(input);
  };
  const fromPartition = base.session.fromPartition;
  base.session.fromPartition = (...args) => {
    const ses = fromPartition(...args);
    ses.webRequest.onCompleted = (filter, cb) => {
      ses.completed = filter === null ? null : cb;
    };
    ses.webRequest.onErrorOccurred = (filter, cb) => {
      ses.errored = filter === null ? null : cb;
    };
    return ses;
  };
  const entry = {
    ...scope,
    platform: "boss",
    sessionRef: "owned",
    partition: "owned-qr-partition",
  };
  const store = {
    create: async () => entry,
    get: async () => entry,
    readMaterial: async () => ({ cookies: [] }),
    saveMaterial: async () => {},
    setState: async (value) => states.push(value.state),
    clear: async () => ({ status: "clean" }),
  };
  const browser = createCollectionBrowser({
    ...base,
    ...extras,
    sessionStore: store,
    diagnostics: async (e) => {
      events.push(e);
    },
    ledger: {
      reserve: async () =>
        assert.fail("manual login cannot consume collection budget"),
    },
  });
  t.after(() => browser.stop());
  await browser.openLogin({
    ref: { scope },
    platform: "boss",
    accountRef: "boss",
  });
  const window = base.windows[0],
    ses = window.webContents.session;
  window.setTitle = (value) => {
    window.title = value;
  };
  events.length = 0;
  return { base, browser, window, ses, events, states, clientOptions };
}
const request = async (ses, details) =>
  new Promise((resolve) => ses.before(details, resolve));
test("QR scan, phone confirmation and final submit are observed without QR identifiers, bodies or login claims", async (t) => {
  const { window, ses, events, states } = await loginFixture(t);
  for (const [id, path, stage] of [
    [1, "scan", "boss-qr-scan-wait"],
    [2, "scanLogin", "boss-qr-confirm-wait"],
    [3, "dispatcher", "boss-qr-login-submit"],
  ]) {
    const details = {
      id,
      webContentsId: window.webContents.id,
      resourceType: "xhr",
      method: "GET",
      url:
        "https://www.zhipin.com/wapi/zppassport/qrcode/" +
        path +
        "?qrId=private-qr-secret&fp=private-fingerprint",
    };
    assert.equal((await request(ses, details)).cancel, false);
    ses.completed({
      ...details,
      statusCode: 200,
      responseHeaders: { "Set-Cookie": ["private-cookie-secret"] },
    });
    await turn();
    assert.ok(
      events.some((e) => e.phase === "started" && e.parser?.version === stage),
    );
    assert.ok(
      events.some(
        (e) =>
          e.phase === "response" &&
          e.parser?.version === stage &&
          e.httpStatus === 200,
      ),
    );
  }
  assert.doesNotMatch(
    JSON.stringify(events),
    /private-|qrId|Set-Cookie|fingerprint|https:|verified|login-success/,
  );
  assert.ok(states.every((state) => state === "unverified"));
});
test("a QR transport failure records only a classified failure and ignores foreign windows", async (t) => {
  const { window, ses, events } = await loginFixture(t);
  const details = {
    id: 10,
    webContentsId: window.webContents.id,
    resourceType: "xhr",
    method: "GET",
    url: "https://www.zhipin.com/wapi/zppassport/qrcode/scanLogin?qrId=private-qr-secret",
  };
  assert.equal((await request(ses, details)).cancel, false);
  ses.errored({
    ...details,
    webContentsId: 999,
    error: "net::ERR_TIMED_OUT private-url",
  });
  await turn();
  assert.equal(events.filter((e) => e.phase === "transport").length, 0);
  ses.errored({ ...details, error: "net::ERR_TIMED_OUT" });
  await turn();
  assert.ok(
    events.some(
      (e) =>
        e.phase === "transport" &&
        e.code === "collection_browser_timeout" &&
        e.parser.version === "boss-qr-confirm-wait",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /private-|qrId|ERR_TIMED_OUT/);
});
test("login request allowance exhaustion is visible immediately, bounded and never resets the allowance", async (t) => {
  const { window, ses, events } = await loginFixture(t);
  const details = {
    webContentsId: window.webContents.id,
    resourceType: "xhr",
    method: "GET",
    url: "https://www.zhipin.com/wapi/zppassport/qrcode/scanLogin?qrId=private-qr-secret",
  };
  for (let id = 1; id < 60; id++)
    assert.equal((await request(ses, { ...details, id })).cancel, false);
  for (let id = 60; id < 63; id++)
    assert.equal((await request(ses, { ...details, id })).cancel, true);
  await turn();
  const denied = events.filter(
    (e) => e.code === "collection_login_budget_exhausted",
  );
  assert.equal(denied.length, 1);
  assert.equal(denied[0].counts.manualRequests, 60);
  assert.match(window.title, /请求上限/);
  assert.doesNotMatch(JSON.stringify(events), /private-|qrId/);
});
test("a denied login redirect gets a diagnostic but cannot open an unapproved route", async (t) => {
  const { window, events } = await loginFixture(t);
  let prevented = false;
  window.webContents.emit(
    "will-navigate",
    {
      preventDefault: () => {
        prevented = true;
      },
    },
    "https://www.zhipin.com/unapproved?token=private-secret",
  );
  await turn();
  assert.equal(prevented, true);
  assert.ok(
    events.some(
      (e) => e.phase === "redirect" && e.code === "collection_route_forbidden",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /unapproved|private-|token/);
});

test("the manual owned page can follow the official default landing without granting login or risk recovery", async (t) => {
  const { window, ses, states } = await loginFixture(t);
  let blocked = false;
  window.webContents.emit(
    "will-navigate",
    {
      preventDefault: () => {
        blocked = true;
      },
    },
    "https://www.zhipin.com/",
  );
  assert.equal(blocked, false);
  const result = await request(ses, {
    id: 301,
    webContentsId: window.webContents.id,
    method: "GET",
    resourceType: "mainFrame",
    url: "https://www.zhipin.com/",
  });
  assert.equal(result.cancel, false);
  assert.ok(states.every((state) => state === "unverified"));
});

test("DNS allowance exhaustion has the same immediate visible feedback as a page request", async (t) => {
  let dnsLedger;
  const { window, events } = await loginFixture(t, {
    publicResolverFactory: (options) => {
      dnsLedger = options.ledger;
      return async () => assert.fail("no DNS network in this fixture");
    },
  });
  for (let i = 1; i < 60; i++) await dnsLedger.reserve({});
  await assert.rejects(dnsLedger.reserve({}), {
    code: "collection_login_budget_exhausted",
  });
  await turn();
  assert.equal(
    events.filter((event) => event.code === "collection_login_budget_exhausted")
      .length,
    1,
  );
  assert.match(window.title, /请求上限/);
});

test("the proxy byte ceiling is classified and shown without revealing any request material", async (t) => {
  const { window, events, clientOptions } = await loginFixture(t);
  assert.equal(typeof clientOptions[0].onLimitExceeded, "function");
  await clientOptions[0].onLimitExceeded({
    kind: "bytes",
    limit: 17039360,
    used: 17039361,
  });
  await turn();
  assert.equal(
    events.filter((event) => event.code === "collection_login_byte_limit")
      .length,
    1,
  );
  assert.match(window.title, /数据上限/);
});

test("an idle tunnel release is diagnostic cleanup and does not claim a failed login request", async (t) => {
  const { events, clientOptions } = await loginFixture(t);
  await clientOptions[0].onTimeout({ phase: "idle", timeoutMs: 120000 });
  assert.ok(
    events.some(
      (e) =>
        e.phase === "cleanup" &&
        e.code === "collection_idle_tunnel_closed" &&
        e.outcome === "completed",
    ),
  );
  assert.equal(
    events.some((e) => e.outcome === "failed"),
    false,
  );
});

test("a connection handshake deadline remains a classified transport failure", async (t) => {
  const { events, clientOptions } = await loginFixture(t);
  await clientOptions[0].onTimeout({ phase: "connect", timeoutMs: 45000 });
  assert.ok(
    events.some(
      (e) =>
        e.phase === "transport" &&
        e.code === "collection_browser_timeout" &&
        e.outcome === "failed",
    ),
  );
});

test("a real bounded tunnel revokes on bytes even with an extended idle wait and a failing observer", async (t) => {
  let peer;
  const limits = [];
  const proxy = createEgressProxy({
    resolvePublicUrl: async (value) => ({
      url: new URL(value),
      addresses: [{ address: "8.8.8.8", family: 4 }],
    }),
    connect: () => {
      peer = new Duplex({
        read() {},
        write(_b, _e, cb) {
          cb();
        },
      });
      peer.remoteAddress = "8.8.8.8";
      peer.setTimeout = () => peer;
      queueMicrotask(() => peer.emit("connect"));
      return peer;
    },
  });
  t.after(() => proxy.stop());
  const { proxyUrl } = await proxy.start();
  allowLocalOrigin(proxyUrl);
  const client = proxy.createClient({
    hosts: ["www.zhipin.com"],
    maxBytes: 4,
    idleTimeoutMs: 120000,
    onLimitExceeded: async (event) => {
      limits.push(event);
      throw Error("synthetic diagnostic failure");
    },
  });
  client.grant("https://www.zhipin.com/");
  const downstream = await new Promise((resolve, reject) => {
    const req = http.request(proxyUrl, {
      method: "CONNECT",
      path: "www.zhipin.com:443",
      headers: {
        "Proxy-Authorization":
          "Basic " +
          Buffer.from(client.username + ":" + client.password).toString(
            "base64",
          ),
      },
    });
    req.once("connect", (_res, socket) => {
      socket.on("error", () => {});
      resolve(socket);
    });
    req.on("error", reject);
    req.end();
  });
  t.after(() => downstream.destroy());
  peer.push(Buffer.alloc(5));
  for (let i = 0; i < 10 && !client.snapshot().closed; i++) await turn();
  assert.equal(client.snapshot().closed, true);
  assert.equal(peer.destroyed, true);
  assert.deepEqual(limits, [{ kind: "bytes", limit: 4, used: 5 }]);
  await turn();
  assert.doesNotMatch(
    JSON.stringify(limits),
    /zhipin|8\.8|Authorization|password/,
  );
});
