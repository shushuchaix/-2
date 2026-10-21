import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createServer } from "../../src/server.mjs";
import { loadConfig } from "../../src/config.mjs";
import { createTempDir, registerTestResource } from "../helpers/fixtures.mjs";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";

async function serverFixture(t, options = {}) {
  const dataDir = options.dataDir || await createTempDir(t);
  fs.writeFileSync(path.join(dataDir, "config.json"), "{}");
  const cfg = loadConfig({ quiet: true, dataDir, readLocalCredentials: false });
  cfg.auth.mode = options.authRequired === false ? "none" : "password";
  cfg.auth.maxLoginFails = 2;
  cfg.__envAuthPassword = options.authRequired === false ? "" : (options.password || "synthetic-http-password");
  cfg.__authSecret = options.authRequired === false ? undefined : (options.secret || "synthetic-http-session-secret-1234567890");
  cfg.server.trustProxy = options.trustProxy ?? false;
  cfg.server.trustedProxyHops = 1;
  cfg.server.host = "127.0.0.1";
  cfg.server.publicUrl = "";
  cfg.deepseek.apiKey = "";
  const ctx = createServer(cfg, { dataDir, dependencies: {
    legacySchema: true, registry: createSourceRegistry([]), catalog: [],
    requestFactory: () => async () => { throw Error("Unexpected network"); },
  } });
  ctx.server.listen(0, "127.0.0.1"); await once(ctx.server, "listening");
  const origin = "http://127.0.0.1:" + ctx.server.address().port;
  allowLocalOrigin(origin);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await (await ctx.ready).close?.(); } finally {
      ctx.server.closeAllConnections();
      if (ctx.server.listening) await new Promise(resolve => ctx.server.close(resolve));
      await ctx.diagnostics.list({ limit: 1 });
    }
  };
  registerTestResource(t, close); await ctx.ready;
  const request = async (route, { body, headers = {}, method = body === undefined ? "GET" : "POST" } = {}) => {
    const response = await fetch(origin + route, { method, headers, body });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { response, data };
  };
  const login = (password = cfg.__envAuthPassword, headers = {}) => request("/api/login", { body: JSON.stringify({ password }), headers: { "Content-Type": "application/json", ...headers } });
  return { dataDir, origin, request, login, close, diagnostics: ctx.diagnostics };
}

test("HTTP login rejects oversized fixed and streamed bodies with an actual 413, then remains usable", async (t) => {
  const fixture = await serverFixture(t);
  const result = await fixture.request("/api/login", { body: JSON.stringify({ password: "x".repeat(5000) }) });
  assert.equal(result.response.status, 413);
  assert.equal(result.data.code, "payload_too_large");
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(5000))); controller.close(); } });
  const response = await fetch(fixture.origin + "/api/login", { method: "POST", body: stream, duplex: "half" });
  assert.equal(response.status, 413); await response.text();
  assert.equal((await fixture.login()).response.status, 200);
});

test("HTTP malformed path, cookies and JSON produce controlled errors without logging secrets", async (t) => {
  const fixture = await serverFixture(t);
  assert.equal((await fixture.request("/%")).response.status, 400);
  assert.equal((await fixture.request("/api/session", { headers: { Cookie: "rjr_session=%" } })).data.authenticated, false);
  assert.equal((await fixture.request("/api/login", { body: "{" })).response.status, 400);
  assert.equal((await fixture.login()).response.status, 200);
  const log = JSON.stringify(await fixture.diagnostics.list({ limit: 100 }));
  assert.equal(log.includes("synthetic-http-password"), false);
  assert.equal(log.includes("rjr_session="), false);
});

test("HTTP appended forged forwarding prefixes cannot rotate the login guard identity", async (t) => {
  const fixture = await serverFixture(t, { trustProxy: true });
  for (let n = 0; n < 2; n++) {
    const result = await fixture.login("wrong-password", { "X-Forwarded-For": `198.51.100.${n + 1}, 203.0.113.8` });
    assert.equal(result.response.status, 401);
  }
  assert.equal((await fixture.login(undefined, { "X-Forwarded-For": "198.51.100.90, 203.0.113.8" })).response.status, 429);
});

test("HTTP requests admitted before a lock cannot bypass it by delaying their bodies", async (t) => {
  const fixture = await serverFixture(t);
  const body = JSON.stringify({ password: "wrong-password" });
  const requests = [];
  const responses = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const request = http.request(fixture.origin + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.write(body.slice(0, 1));
    requests.push(request);
  }));
  // Leave all bodies incomplete while their request headers are admitted.
  await new Promise(resolve => setTimeout(resolve, 60));
  for (const request of requests) request.end(body.slice(1));
  assert.deepEqual((await Promise.all(responses)).sort(), [401, 401, 429, 429]);
});

test("HTTP logout revokes a copied cookie after restart; password and root rotations still allow new login", async (t) => {
  const first = await serverFixture(t);
  const login = await first.login(), cookie = login.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await first.request("/api/session", { headers: { Cookie: cookie } })).data.authenticated, true);
  assert.equal((await first.request("/api/logout", { method: "POST", headers: { Cookie: cookie } })).response.status, 200);
  assert.equal((await first.request("/api/session", { headers: { Cookie: cookie } })).data.authenticated, false);
  await first.close();
  const second = await serverFixture(t, { dataDir: first.dataDir });
  assert.equal((await second.request("/api/session", { headers: { Cookie: cookie } })).data.authenticated, false);
  const secondCookie = (await second.login()).response.headers.get("set-cookie").split(";")[0];
  await second.close();
  const rotated = await serverFixture(t, { dataDir: first.dataDir, password: "new-synthetic-http-password" });
  assert.equal((await rotated.request("/api/session", { headers: { Cookie: secondCookie } })).data.authenticated, false);
  const rotatedLogin = await rotated.login();
  assert.equal(rotatedLogin.response.status, 200);
  const rotatedCookie = rotatedLogin.response.headers.get("set-cookie").split(";")[0];
  await rotated.close();
  const rootRotated = await serverFixture(t, { dataDir: first.dataDir, password: "new-synthetic-http-password", secret: "new-synthetic-server-root-secret-12345" });
  assert.equal((await rootRotated.request("/api/session", { headers: { Cookie: rotatedCookie } })).data.authenticated, false);
  assert.equal((await rootRotated.login()).response.status, 200);
});

test("HTTP session persistence failure refuses login and logout without clearing a still-valid cookie", async (t) => {
  const fixture = await serverFixture(t);
  const lock = path.join(fixture.dataDir, ".auth-sessions.json.lock");
  fs.mkdirSync(lock);
  let result = await fixture.login();
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get("set-cookie"), null);
  fs.rmdirSync(lock);
  const cookie = (await fixture.login()).response.headers.get("set-cookie").split(";")[0];
  fs.mkdirSync(lock);
  result = await fixture.request("/api/logout", { method: "POST", headers: { Cookie: cookie } });
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get("set-cookie"), null);
  assert.equal((await fixture.request("/api/session", { headers: { Cookie: cookie } })).data.authenticated, true);
  fs.rmdirSync(lock);
  assert.equal((await fixture.request("/api/logout", { method: "POST", headers: { Cookie: cookie } })).response.status, 200);
  assert.equal((await fixture.request("/api/session", { headers: { Cookie: cookie } })).data.authenticated, false);
});

test("explicit no-auth mode does not initialize or repair persistent web authentication material", async (t) => {
  const dataDir = await createTempDir(t), secret = path.join(dataDir, ".session-secret");
  fs.writeFileSync(secret, "synthetic-invalid-unused-secret");
  const fixture = await serverFixture(t, { dataDir, authRequired: false });
  const session = await fixture.request("/api/session");
  assert.equal(session.data.authRequired, false);
  assert.equal(session.data.authenticated, true);
  assert.equal(fs.readFileSync(secret, "utf8"), "synthetic-invalid-unused-secret");
  assert.equal(fs.existsSync(path.join(dataDir, ".auth-sessions.json")), false);
});
