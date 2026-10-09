import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCollectionSessions } from "../../electron/collection/sessions.mjs";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
const a = { packageId: "p-a", targetRevisionId: "t-a" },
  b = { packageId: "p-b", targetRevisionId: "t-b" };
test("remote_windows_have_no_bridge_and_package_cleanup_keeps_other_session", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collection-window-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = collectionBrowserFixture(),
    sessionStore = createCollectionSessions({
      dataDir: dir,
      safeStorage: { isEncryptionAvailable: () => false },
    }),
    browser = createCollectionBrowser({
      ...fixture,
      sessionStore,
      ledger: { reserve: async () => {} },
    });
  t.after(() => browser.stop());
  const first = await browser.openLogin({
      ref: { scope: a },
      platform: "weibo",
      accountRef: "one",
    }),
    second = await browser.openLogin({
      ref: { scope: b },
      platform: "weibo",
      accountRef: "one",
    });
  assert.notEqual(
    fixture.windows[0].options.webPreferences.partition,
    fixture.windows[1].options.webPreferences.partition,
  );
  for (const win of fixture.windows) {
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.webPreferences.preload, undefined);
    assert.equal(win.options.webPreferences.sandbox, true);
  }
  fixture.windows[0].webContents.session.cookieValues = [
    { name: "first", value: "private", domain: ".weibo.cn" },
  ];
  fixture.windows[1].webContents.session.cookieValues = [
    { name: "second", value: "private", domain: ".weibo.cn" },
  ];
  await browser.closePackage(a.packageId);
  assert.equal(fixture.windows[0].isDestroyed(), true);
  assert.equal(fixture.windows[1].isDestroyed(), false);
  assert.equal(fixture.windows[1].webContents.session.cookieValues.length, 1);
  assert.equal(
    (await sessionStore.get({ scope: b, sessionRef: second.sessionRef })).state,
    "unverified",
  );
  const verified = await browser.verifySession({
    ref: { scope: b, activityId: "root" },
    sessionRef: second.sessionRef,
    testUrl: "https://m.weibo.cn/detail/123",
    token: {},
    operationLease: {},
  });
  assert.equal(verified.state, "unverified");
  assert.equal(verified.bodyStatus, "challenge_required");
  assert.equal(browser.snapshot().activeReads, 0);
});
test("dedicated_sessions_are_owned_random_and_never_persist_plaintext", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collection-session-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createCollectionSessions({
    dataDir: dir,
    safeStorage: { isEncryptionAvailable: () => false },
  });
  const first = await store.create({
      scope: a,
      platform: "weibo",
      accountRef: "public-a",
      remember: true,
    }),
    second = await store.create({
      scope: b,
      platform: "weibo",
      accountRef: "public-a",
    });
  assert.notEqual(first.partition, second.partition);
  assert.ok(!first.partition.startsWith("persist:"));
  await assert.rejects(store.get({ scope: b, sessionRef: first.sessionRef }));
  await store.saveMaterial({
    scope: a,
    sessionRef: first.sessionRef,
    cookies: [{ name: "token", value: "PRIVATE", domain: ".weibo.cn" }],
  });
  assert.deepEqual(await fs.readdir(dir), []);
  await store.cleanupPackage(a.packageId);
  await assert.rejects(store.get({ scope: a, sessionRef: first.sessionRef }));
});
test("encrypted_session_removal_is_retryable_and_excluded_from_business_backups", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collection-encrypted-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "dpapi",
    encryptString: (v) => Buffer.from(v).map((n) => n ^ 91),
    decryptString: (b) =>
      Buffer.from(b)
        .map((n) => n ^ 91)
        .toString(),
  };
  const store = createCollectionSessions({ dataDir: dir, safeStorage });
  const first = await store.create({
    scope: a,
    platform: "weibo",
    accountRef: "public-a",
    remember: true,
  });
  await store.saveMaterial({
    scope: a,
    sessionRef: first.sessionRef,
    cookies: [{ name: "token", value: "PRIVATE", domain: ".weibo.cn" }],
  });
  const raw = await fs.readFile(
    path.join(dir, "collection-sessions", "sessions.json"),
    "utf8",
  );
  assert.ok(!raw.includes("PRIVATE"));
  const reopen = createCollectionSessions({ dataDir: dir, safeStorage });
  const restored = await reopen.get({ scope: a, sessionRef: first.sessionRef });
  assert.notEqual(restored.partition, first.partition);
  assert.equal(
    (await reopen.readMaterial({ scope: a, sessionRef: first.sessionRef }))
      .cookies[0].value,
    "PRIVATE",
  );
  await reopen.cleanupPackage(a.packageId);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(dir, "collection-sessions", "sessions.json"),
        "utf8",
      ),
    ).entries,
    {},
  );
});

test("failed_single_session_clear_persists_intent_and_blocks_restore_before_retry", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collection-intent-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (v) => Buffer.from(v),
    decryptString: (b) => b.toString(),
  };
  const base = createCollectionSessions({ dataDir: dir, safeStorage }),
    entry = await base.create({
      scope: a,
      platform: "weibo",
      accountRef: "one",
      remember: true,
    });
  await base.saveMaterial({
    scope: a,
    sessionRef: entry.sessionRef,
    cookies: [{ name: "synthetic", value: "private" }],
  });
  const adapter = {
    ...fs,
    rename: async (from, to) => {
      if (to.endsWith("sessions.json"))
        throw Object.assign(Error("locked"), { code: "EPERM" });
      return fs.rename(from, to);
    },
  };
  const locked = createCollectionSessions({
    dataDir: dir,
    safeStorage,
    fsAdapter: adapter,
  });
  assert.equal(
    (await locked.clear({ scope: a, sessionRef: entry.sessionRef })).status,
    "cleanup_pending",
  );
  const reopened = createCollectionSessions({ dataDir: dir, safeStorage });
  await assert.rejects(
    reopened.get({ scope: a, sessionRef: entry.sessionRef }),
    { code: "collection_session_scope" },
  );
  await reopened.resumePending();
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(dir, "collection-sessions", "sessions.json"),
        "utf8",
      ),
    ).entries,
    {},
  );
});

test("package closure drains an in-flight window preparation before it can open", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collection-race-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = collectionBrowserFixture(),
    store = createCollectionSessions({
      dataDir: dir,
      safeStorage: { isEncryptionAvailable: () => false },
    });
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (entered = r)),
    original = fixture.session.fromPartition;
  fixture.session.fromPartition = (partition) => {
    const ses = original(partition);
    ses.setProxy = async () => {
      entered();
      await gate;
    };
    return ses;
  };
  const browser = createCollectionBrowser({
    ...fixture,
    sessionStore: store,
    ledger: { reserve: async () => {} },
  });
  t.after(() => browser.stop());
  const pending = browser.openLogin({
    ref: { scope: a },
    platform: "weibo",
    accountRef: "public",
  });
  await started;
  const rejection = assert.rejects(pending, { code: "collection_cancelled" });
  const close = browser.closePackage(a.packageId);
  release();
  await rejection;
  await close;
  assert.equal(fixture.windows.length, 0);
});

test("cancelled loaded snapshot and cleanup failure both release the global read slot", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collection-cancel-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = collectionBrowserFixture(),
    store = createCollectionSessions({
      dataDir: dir,
      safeStorage: { isEncryptionAvailable: () => false },
    }),
    controller = new AbortController();
  let snapshotStarted;
  const started = new Promise((r) => (snapshotStarted = r)),
    Base = fixture.BrowserWindow;
  fixture.BrowserWindow = class extends Base {
    constructor(options) {
      super(options);
      this.webContents.executeJavaScript = () => {
        snapshotStarted();
        return new Promise(() => {});
      };
    }
  };
  const browser = createCollectionBrowser({
    ...fixture,
    sessionStore: store,
    ledger: {
      reserve: async () => ({ reservationId: "bytes" }),
      settle: async () => {},
    },
  });
  t.after(() => browser.stop());
  const pending = browser.read({
      ref: { scope: a },
      token: {},
      url: "https://m.weibo.cn/detail/123",
      routePolicy: { platform: "weibo", hosts: ["m.weibo.cn"] },
      signal: controller.signal,
    }),
    rejection = assert.rejects(pending);
  await started;
  controller.abort();
  await rejection;
  assert.equal(browser.snapshot().activeReads, 0);
  assert.equal(browser.snapshot().windows, 0);
});
