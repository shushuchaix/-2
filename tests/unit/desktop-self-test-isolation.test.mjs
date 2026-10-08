import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
import { prepareSelfTestEnvironment } from "../../electron/self-test.mjs";
import { installSelfTestNetworkGuard } from "../../electron/self-test-network.mjs";
import { awaitDesktopContext } from "../../electron/startup.mjs";

test("normal desktop keeps maintenance HTTP surface reachable while self-test propagates startup failure", async () => {
  const error = Object.assign(
    new Error("synthetic workspace control failure"),
    { code: "workspace_control_invalid" },
  );
  assert.equal(await awaitDesktopContext(Promise.reject(error)), null);
  await assert.rejects(
    awaitDesktopContext(Promise.reject(error), { selfTest: true }),
    (e) => e === error,
  );
  const context = { close: async () => {} };
  assert.equal(await awaitDesktopContext(Promise.resolve(context)), context);
});

test("self-test establishes an independent synthetic directory before config and credentials", async (t) => {
  const tempRoot = await createTempDir(t),
    env = prepareSelfTestEnvironment({ tempRoot });
  t.after(() => env.cleanup());
  assert.equal(path.dirname(env.dataDir), tempRoot);
  assert.match(path.basename(env.dataDir), /^rjr-self-test-/);
  assert.equal(env.cfg.deepseek.apiKey, "");
  assert.equal(env.cfg.auth.mode, "none");
  assert.equal(
    env.dependencies.catalog.every((s) => s.providerId.startsWith("synthetic")),
    true,
  );
  await assert.rejects(
    () => env.dependencies.requestFactory()("https://external.invalid"),
    /offline_network_forbidden/,
  );
  assert.equal(env.dependencies.modelFactory().synthetic, true);
  const before = env.clock.now();
  env.clock.advance(72 * 3600 * 1000);
  assert.equal(env.clock.now() - before, 72 * 3600 * 1000);
});
test("self-test rejects explicit daily data and symlink destinations without touching a sentinel", async (t) => {
  const tempRoot = await createTempDir(t),
    daily = path.join(tempRoot, "daily-data");
  fs.mkdirSync(daily);
  fs.writeFileSync(
    path.join(daily, "credentials.v2.json"),
    "forbidden sentinel",
  );
  assert.throws(
    () => prepareSelfTestEnvironment({ explicitDataDir: daily, tempRoot }),
    /self_test_directory/,
  );
  const named = path.join(tempRoot, "rjr-self-test-existing");
  fs.mkdirSync(named);
  fs.writeFileSync(path.join(named, "workspace.v2.json"), "forbidden sentinel");
  assert.throws(
    () => prepareSelfTestEnvironment({ explicitDataDir: named, tempRoot }),
    /self_test_directory/,
  );
  assert.equal(
    fs.readFileSync(path.join(daily, "credentials.v2.json"), "utf8"),
    "forbidden sentinel",
  );
  const link = path.join(tempRoot, "rjr-self-test-link");
  fs.symlinkSync(daily, link, "junction");
  assert.throws(
    () => prepareSelfTestEnvironment({ explicitDataDir: link, tempRoot }),
    /self_test_directory/,
  );
});
test("Node and Chromium guards allow only the exact actual loopback origin and restore hooks", async () => {
  const originalFetch = globalThis.fetch,
    originalHttp = http.request;
  let callback;
  const session = {
    webRequest: {
      onBeforeRequest: (...args) => {
        callback = args.at(-1);
      },
    },
  };
  const guard = installSelfTestNetworkGuard({
    session,
    allowedOrigin: "http://127.0.0.1:3210",
  });
  try {
    await assert.rejects(
      () => fetch("https://external.invalid/private"),
      /offline_network_forbidden/,
    );
    for (const request of [
      () => http.get("http://127.0.0.1:3211/"),
      () => https.get("https://external.invalid/"),
      () => net.connect(443, "external.invalid"),
      () => new net.Socket().connect(443, "external.invalid"),
      () => tls.connect(443, "external.invalid"),
    ])
      assert.throws(request, /offline_network_forbidden/);
    for (const [url, cancel] of [
      ["https://external.invalid/", true],
      ["http://localhost:3210/", true],
      ["http://127.0.0.1:3211/", true],
      ["ws://127.0.0.1:3211/", true],
      ["http://127.0.0.1:3210/app/index.html", false],
      ["ws://127.0.0.1:3210/events", false],
      ["about:blank", false],
      ["data:image/png;base64,AA==", false],
    ]) {
      let result;
      callback({ url }, (v) => {
        result = v;
      });
      assert.equal(result.cancel, cancel, url);
    }
    assert.equal(guard.report().externalRequests, 0);
    const server = http.createServer((_req, res) => {
      res.end("synthetic loopback");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    allowLocalOrigin(origin);
    guard.setAllowedOrigin(origin);
    try {
      assert.equal(await (await fetch(origin)).text(), "synthetic loopback");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    guard.dispose();
  }
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(http.request, originalHttp);
});
