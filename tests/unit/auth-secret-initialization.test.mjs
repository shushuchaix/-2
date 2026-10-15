import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SessionManager } from "../../src/auth.mjs";
import { createTempDir, registerTestResource } from "../helpers/fixtures.mjs";

const authUrl = new URL("../../src/auth.mjs", import.meta.url).href;
const guardUrl = new URL("../helpers/network-guard.mjs", import.meta.url).href;
function worker(t, source) {
  const child = spawn(process.execPath, ["--import", guardUrl, "--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RJR_DISABLE_LOCAL_CREDENTIALS: "1" },
  });
  let out = "", err = "", exited = false;
  child.stdout.on("data", data => { out += data; });
  child.stderr.on("data", data => { err += data; });
  registerTestResource(t, async () => { if (!exited) child.kill(); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      exited = true;
      code === 0 ? resolve(JSON.parse(out)) : reject(Error("Synthetic default-secret worker failed: " + err));
    });
  });
}
async function waitForFiles(files) {
  const deadline = Date.now() + 10000;
  while (files.some(file => !fs.existsSync(file))) {
    if (Date.now() >= deadline) throw Error("Synthetic secret initialization barrier timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("two first-start processes publish one complete default secret and preserve both sessions across restart", async (t) => {
  const dataDir = await createTempDir(t);
  const options = { dataDir, storageFile: path.join(dataDir, ".auth-sessions.json"), credential: "synthetic-shared-password" };
  const source = role => `
    import fs from 'node:fs';
    import path from 'node:path';
    import { SessionManager } from ${JSON.stringify(authUrl)};
    const options = ${JSON.stringify(options)}, role = ${JSON.stringify(role)};
    const file = name => path.join(options.dataDir, name);
    const wait = name => {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(file(name))) {
        if (Date.now() >= deadline) throw Error('Synthetic worker barrier timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    };
    const read = fs.readFileSync;
    let intercepted = false;
    fs.readFileSync = function(filename, ...args) {
      if (!intercepted && String(filename) === file('.session-secret')) {
        intercepted = true;
        let result, error;
        try { result = read.call(this, filename, ...args); } catch (caught) { error = caught; }
        fs.writeFileSync(file('initial-read-' + role), 'ready');
        wait('release-initial-reads');
        if (error) throw error;
        return result;
      }
      return read.call(this, filename, ...args);
    };
    const manager = new SessionManager(options);
    fs.writeFileSync(file('constructed-' + role), 'ready');
    wait('release-issue');
    if (role === 'b') wait('issued-a-ready');
    let own;
    for (let n = 0; n < 100; n++) {
      try { own = manager.issue().token; break; } catch (error) {
        if (error.code !== 'auth_session_busy') throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
    if (!own) throw Error('Synthetic session issue retry exhausted');
    const ownBefore = Boolean(manager.verify(own));
    fs.writeFileSync(file('issued-' + role + '.json'), JSON.stringify({ token: own }));
    fs.writeFileSync(file('issued-' + role + '-ready'), 'ready');
    wait('issued-' + (role === 'a' ? 'b' : 'a') + '-ready');
    const peer = JSON.parse(fs.readFileSync(file('issued-' + (role === 'a' ? 'b' : 'a') + '.json'), 'utf8')).token;
    process.stdout.write(JSON.stringify({ keyId: manager.keyId, ownBefore, ownAfter: Boolean(manager.verify(own)), peerValid: Boolean(manager.verify(peer)) }));
  `;
  const processes = [worker(t, source("a")), worker(t, source("b"))];
  await waitForFiles(["a", "b"].map(role => path.join(dataDir, "initial-read-" + role)));
  fs.writeFileSync(path.join(dataDir, "release-initial-reads"), "go");
  await waitForFiles(["a", "b"].map(role => path.join(dataDir, "constructed-" + role)));
  fs.writeFileSync(path.join(dataDir, "release-issue"), "go");
  const [a, b] = await Promise.all(processes);
  assert.equal(a.keyId, b.keyId);
  assert.equal(a.ownBefore && a.ownAfter && a.peerValid && b.ownBefore && b.ownAfter && b.peerValid, true);
  assert.equal(JSON.parse(fs.readFileSync(options.storageFile, "utf8")).sessions.length, 2);
  const restarted = await worker(t, `
    import fs from 'node:fs'; import path from 'node:path';
    import { SessionManager } from ${JSON.stringify(authUrl)};
    const options = ${JSON.stringify(options)}, manager = new SessionManager(options);
    const tokens = ['a', 'b'].map(role => JSON.parse(fs.readFileSync(path.join(options.dataDir, 'issued-' + role + '.json'), 'utf8')).token);
    process.stdout.write(JSON.stringify({ keyId: manager.keyId, valid: tokens.every(token => Boolean(manager.verify(token))) }));
  `);
  assert.equal(restarted.keyId, a.keyId);
  assert.equal(restarted.valid, true);
});

test("short and corrupt existing default secrets fail closed without replacing their bytes", async (t) => {
  const dataDir = await createTempDir(t), file = path.join(dataDir, ".session-secret");
  for (const value of ["", "short", "!".repeat(43)]) {
    fs.writeFileSync(file, value);
    assert.throws(() => new SessionManager({ dataDir, storageFile: path.join(dataDir, ".auth-sessions.json") }), { code: "auth_secret_invalid" });
    assert.equal(fs.readFileSync(file, "utf8"), value);
  }
});

test("default secret read permission and I/O errors never trigger replacement or memory fallback", async (t) => {
  const dataDir = await createTempDir(t), file = path.join(dataDir, ".session-secret");
  const original = "A".repeat(43), read = fs.readFileSync;
  fs.writeFileSync(file, original);
  for (const code of ["EACCES", "EIO"]) {
    fs.readFileSync = function(filename, ...args) {
      if (String(filename) === file) throw Object.assign(Error("Synthetic secret read failure"), { code });
      return read.call(this, filename, ...args);
    };
    try {
      assert.throws(() => new SessionManager({ dataDir, storageFile: path.join(dataDir, ".auth-sessions.json") }), { code: "auth_secret_unavailable" });
    } finally { fs.readFileSync = read; }
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("unsupported atomic secret publication fails closed and cleans its own pending material", async (t) => {
  const dataDir = await createTempDir(t), file = path.join(dataDir, ".session-secret");
  const link = fs.linkSync;
  fs.linkSync = function(source, target) {
    if (String(target) === file) throw Object.assign(Error("Synthetic unsupported publication"), { code: "ENOTSUP" });
    return link.call(this, source, target);
  };
  try {
    assert.throws(() => new SessionManager({ dataDir, storageFile: path.join(dataDir, ".auth-sessions.json") }), { code: "auth_secret_unavailable" });
  } finally { fs.linkSync = link; }
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dataDir), []);
});
