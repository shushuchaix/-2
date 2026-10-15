import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createTempDir } from "../helpers/fixtures.mjs";
import { SessionManager, LoginGuard, clientIp, isSecureRequest, parseCookies, isLoopback, hashPassword, verifyPassword } from "../../src/auth.mjs";

const secret = "synthetic-server-secret-not-a-real-credential";
const request = (headers = {}, remoteAddress = "10.0.0.2") => ({ headers, socket: { remoteAddress } });

test("a truncated scrypt digest cannot authenticate every password", () => {
  const parts = hashPassword("synthetic-password").split("$");
  parts[5] = "";
  assert.equal(verifyPassword("unrelated-password", parts.join("$")), false);
});

test("proxy identity ignores client-supplied prefix and enforces the configured hop boundary", () => {
  const req = request({ "x-forwarded-for": "198.51.100.99, 203.0.113.8" });
  assert.equal(clientIp(req, false), "10.0.0.2");
  assert.equal(clientIp(req, true), "203.0.113.8");
  assert.equal(clientIp(request({ "x-forwarded-for": "198.51.100.99, 203.0.113.8, 10.0.0.1" }), true, 2), "203.0.113.8");
  for (const value of ["", "garbage", "198.51.100.99, garbage"]) {
    assert.equal(clientIp(request({ "x-forwarded-for": value, "x-real-ip": "198.51.100.22" }), true), "10.0.0.2");
  }
  assert.equal(clientIp(req, true, 3), "10.0.0.2");
  assert.equal(isSecureRequest(request({ "x-forwarded-proto": "https, http" }), true), false);
  assert.equal(isSecureRequest(request({ "x-forwarded-proto": "http, https" }), true), false);
  assert.equal(isSecureRequest(request({ "x-forwarded-proto": "https" }), true), true);
  assert.equal(isSecureRequest(request({ "x-forwarded-proto": "https" }), false), false);
  assert.equal(isLoopback("unknown"), false);
});

test("malformed cookies cannot crash authentication or shadow a valid sibling", () => {
  assert.deepEqual(parseCookies(request({ cookie: "broken=%; rjr_session=good%2Etoken; another=%E0%A4%A" })), { rjr_session: "good.token" });
});

test("credential and root secret rotation invalidate tokens but unchanged credentials survive restart", (t) => {
  const a = new SessionManager({ secret, credential: "synthetic-old-password" });
  const token = a.issue().token;
  assert.ok(new SessionManager({ secret, credential: "synthetic-old-password" }).verify(token));
  assert.equal(new SessionManager({ secret, credential: "synthetic-new-password" }).verify(token), null);
  assert.equal(new SessionManager({ secret: secret + "-rotated", credential: "synthetic-old-password" }).verify(token), null);
  const hostile = a.issue({ sid: "attacker", exp: Date.now() + 99999999999, iat: -1 }).payload;
  assert.notEqual(hostile.sid, "attacker");
  assert.ok(hostile.exp < Date.now() + a.ttlMs + 1000);
});

test("persistent logout survives restart and a second manager cannot resurrect a revoked SID", async (t) => {
  const file = path.join(await createTempDir(t), ".auth-sessions.json");
  const options = { secret, credential: "synthetic-password", storageFile: file };
  const a = new SessionManager(options), b = new SessionManager(options);
  const first = a.issue().token;
  const second = b.issue().token;
  assert.ok(b.verify(first));
  a.revoke(first);
  b.issue();
  const restarted = new SessionManager(options);
  assert.equal(restarted.verify(first), null);
  assert.ok(restarted.verify(second));
  fs.unlinkSync(file);
  assert.equal(restarted.verify(second), null);
  const fresh = restarted.issue().token;
  assert.equal(restarted.verify(second), null);
  assert.ok(restarted.verify(fresh));
});

test("corrupt session registry fails closed and a new authenticated login recovers without restoring old sessions", async (t) => {
  const file = path.join(await createTempDir(t), ".auth-sessions.json");
  const manager = new SessionManager({ secret, credential: "synthetic-password", storageFile: file });
  const old = manager.issue().token;
  fs.writeFileSync(file, '{"version":1,"sessions":[]}');
  assert.equal(manager.verify(old), null);
  const fresh = manager.issue().token;
  assert.equal(manager.verify(old), null);
  assert.ok(manager.verify(fresh));
  const rotated = new SessionManager({ secret, credential: "new-synthetic-password", storageFile: file });
  assert.equal(rotated.verify(fresh), null);
  assert.ok(rotated.verify(rotated.issue().token));
});

test("session capacity and persistence failure do not evict active sessions or claim success", async (t) => {
  const dir = await createTempDir(t), file = path.join(dir, ".auth-sessions.json");
  const manager = new SessionManager({ secret, storageFile: file, maxSessions: 2 });
  const first = manager.issue().token, second = manager.issue().token;
  assert.throws(() => manager.issue(), { code: "auth_session_capacity" });
  assert.ok(manager.verify(first));
  fs.mkdirSync(file + ".lock");
  assert.throws(() => manager.revoke(first), { code: "auth_session_busy" });
  assert.ok(manager.verify(first));
  fs.rmdirSync(file + ".lock");
  manager.revoke(first);
  assert.equal(manager.verify(first), null);
  assert.ok(manager.verify(second));
  assert.ok(manager.verify(manager.issue().token));
});

function runSessionProcess(source) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", data => { out += data; });
  child.stderr.on("data", data => { err += data; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve({ out, pid: child.pid }) : reject(Error("Synthetic session worker failed: " + err)));
  });
}

test("concurrent processes share the registry without reviving a logged-out SID", async (t) => {
  const file = path.join(await createTempDir(t), ".auth-sessions.json");
  const options = { secret, credential: "synthetic-password", storageFile: file };
  const manager = new SessionManager(options), old = manager.issue().token;
  const source = `
    import { SessionManager } from ${JSON.stringify(new URL("../../src/auth.mjs", import.meta.url).href)};
    const manager = new SessionManager(${JSON.stringify(options)});
    let token;
    for (let n = 0; n < 100; n++) {
      try { token = manager.issue().token; break; } catch (error) {
        if (error.code !== 'auth_session_busy') throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    if (!token) throw Error('Synthetic retry exhausted');
    process.stdout.write(token);
  `;
  const children = Array.from({ length: 8 }, () => runSessionProcess(source));
  manager.revoke(old);
  const results = await Promise.all(children);
  assert.equal(manager.verify(old), null);
  for (const { out } of results) assert.ok(manager.verify(out));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions.length, 8);
});

test("proven dead lock owners can be reclaimed, while live owners remain protected", async (t) => {
  const file = path.join(await createTempDir(t), ".auth-sessions.json");
  const manager = new SessionManager({ secret, storageFile: file });
  const exited = await runSessionProcess("");
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid: exited.pid, nonce: "a".repeat(32) }));
  assert.ok(manager.verify(manager.issue().token));
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid: process.pid, nonce: "b".repeat(32) }));
  assert.throws(() => manager.issue(), { code: "auth_session_busy" });
  assert.equal(JSON.parse(fs.readFileSync(file + ".lock", "utf8")).nonce, "b".repeat(32));
});

test("login guard has bounded records and preserves locked identities at capacity", () => {
  let now = 10000;
  const guard = new LoginGuard({ maxFails: 2, maxRecords: 2, lockMs: 2000, windowMs: 1000, now: () => now, globalMaxFails: 100 });
  guard.fail("locked"); guard.fail("locked"); guard.fail("other");
  for (let i = 0; i < 50; i++) { guard.check("new-" + i); guard.fail("new-" + i); }
  assert.equal(guard.records.size, 2);
  assert.equal(guard.check("locked").allowed, false);
  assert.equal(guard.check("brand-new").allowed, false);
  now += 2001;
  guard.sweep();
  assert.equal(guard.check("brand-new").allowed, true);
  assert.equal(guard.records.size, 0);
});

test("distributed failures are bounded by a global guard and success does not reset other failures", () => {
  let now = 10000;
  const guard = new LoginGuard({ maxFails: 50, globalMaxFails: 3, lockMs: 1000, globalWindowMs: 1000, now: () => now });
  guard.fail("a"); guard.fail("b"); guard.succeed("a"); guard.fail("c");
  assert.equal(guard.check("d").allowed, false);
  now += 1001;
  assert.equal(guard.check("d").allowed, true);
});
