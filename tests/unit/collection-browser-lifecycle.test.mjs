import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
import { platformPolicy } from "../../electron/collection/network-policy.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";

const scope = {
  packageId: "synthetic-package",
  targetRevisionId: "synthetic-target",
};
const input = {
  ref: { scope, activityId: "synthetic-read" },
  token: {},
  url: "https://m.weibo.cn/detail/123",
  routePolicy: platformPolicy("weibo"),
};

function nativeFixture(options) {
  const fixture = collectionBrowserFixture(options),
    Base = fixture.BrowserWindow;
  let destroyedGetters = 0;
  fixture.BrowserWindow = class extends Base {
    constructor(options) {
      super(options);
      this.isMinimized = () => false;
      this.show = this.focus = () => {};
      this.contents = this.webContents;
      this.contents.isDestroyed = () => this.isDestroyed();
      Object.defineProperty(this, "webContents", {
        get() {
          if (this.isDestroyed()) {
            destroyedGetters++;
            throw Error("Object has been destroyed");
          }
          return this.contents;
        },
      });
    }
  };
  return { ...fixture, destroyedGetters: () => destroyedGetters };
}

test("backend revoke before a late response drains destroyed native window bookkeeping", async (t) => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const fixture = nativeFixture({
    executeJavaScript: () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const browser = createCollectionBrowser({
    ...fixture,
    sessionStore: {},
    ledger: { reserve: async (v) => v, settle: async () => {} },
  });
  t.after(() => browser.stop());
  const pending = browser.read(input);
  const rejected = assert.rejects(pending);
  await started;
  assert.deepEqual(browser.snapshot(), { activeReads: 1, windows: 1 });
  browser.revokeBackend();
  assert.equal(fixture.windows[0].isDestroyed(), true);
  release("<div class='weibo-text'>synthetic late response</div>");
  await rejected;
  assert.deepEqual(browser.snapshot(), { activeReads: 0, windows: 0 });
  assert.equal(fixture.destroyedGetters(), 0);
  assert.equal(fixture.windows.length, 1);
});

function ownedHarness(options = {}) {
  const fixture = nativeFixture(options),
    writes = [],
    entry = {
      ...scope,
      sessionRef: "synthetic-session",
      platform: "boss",
      partition: "synthetic-owned",
      remember: true,
    };
  const store = {
    create: async () => entry,
    get: async () => entry,
    getStatus: async () => ({ state: "unverified", riskBlocked: false }),
    readMaterial: async () => ({ cookies: [] }),
    cleanupPackage: async () => ({ status: "completed" }),
    setState: async (value) => {
      writes.push({ kind: "state", ...value });
    },
    saveMaterial: async (value) => {
      writes.push({ kind: "material", ...value });
    },
  };
  const browser = createCollectionBrowser({
    ...fixture,
    sessionStore: { ...store, ...options.store },
    ledger: { reserve: async (v) => v, settle: async () => {} },
  });
  return { ...fixture, browser, writes, entry };
}

const login = { ref: { scope }, platform: "boss", remember: true };

test("graceful stop saves remembered material while revoked cleanup skips state and material", async () => {
  for (const revoked of [false, true]) {
    const h = ownedHarness();
    await h.browser.openLogin(login);
    h.windows[0].contents.session.cookieValues = [
      { name: "synthetic", value: "synthetic", domain: ".zhipin.com" },
    ];
    if (revoked) h.browser.revokeBackend();
    await h.browser.stop();
    assert.deepEqual(
      h.writes.map((w) => w.kind),
      revoked ? [] : ["state", "material"],
    );
    if (!revoked) assert.equal(h.writes[1].cookies[0].name, "synthetic");
    assert.equal(h.destroyedGetters(), 0);
    assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 0 });
  }
});

test("backend revocation during cookies lookup prevents the following material write", async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = ownedHarness();
  await h.browser.openLogin(login);
  h.windows[0].contents.session.cookies.get = () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const stopped = h.browser.stop();
  await started;
  h.browser.revokeBackend();
  release([{ name: "synthetic", value: "synthetic" }]);
  await stopped;
  assert.deepEqual(
    h.writes.map((w) => w.kind),
    ["state"],
  );
  assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 0 });
});

test("backend revocation during state write prevents the following cookies read and material write", async () => {
  let entered,
    release,
    cookieReads = 0;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = ownedHarness({
    store: {
      setState: () => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  await h.browser.openLogin(login);
  h.windows[0].contents.session.cookies.get = async () => {
    cookieReads++;
    return [];
  };
  const stopped = h.browser.stop();
  await started;
  h.browser.revokeBackend();
  release();
  await stopped;
  assert.equal(cookieReads, 0);
  assert.deepEqual(h.writes, []);
});

test("cleanup hook failure still removes listeners and native bookkeeping and stop reports failure", async () => {
  const h = ownedHarness({
    executeJavaScript: async () => "<div class='weibo-text'>synthetic</div>",
  });
  await h.browser.openLogin(login);
  const ses = h.windows[0].contents.session,
    original = ses.webRequest.onHeadersReceived;
  const cleanupError = Object.assign(Error("synthetic cleanup failure"), {
    code: "synthetic_cleanup",
  });
  ses.webRequest.onHeadersReceived = (filter, callback) => {
    if (filter === null) throw cleanupError;
    return original(filter, callback);
  };
  assert.deepEqual(await h.browser.closePackage(scope.packageId), {
    status: "cleanup_pending",
  });
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.equal(h.windows[0].listenerCount("closed"), 0);
  assert.equal(ses.listenerCount("will-download"), 0);
  assert.equal(h.browser.snapshot().windows, 0);
  await assert.rejects(h.browser.stop(), (error) => error === cleanupError);
});

test("throwing native stop cannot prevent other windows being synchronously revoked", async () => {
  let sequence = 0;
  const h = ownedHarness({
    store: {
      create: async () => ({
        ...scope,
        platform: "weibo",
        sessionRef: "synthetic-" + ++sequence,
        partition: "synthetic-" + sequence,
      }),
    },
  });
  await h.browser.openLogin({ ...login, platform: "weibo" });
  await h.browser.openLogin({ ...login, platform: "weibo" });
  const stopError = Error("synthetic native stop failure");
  h.windows[0].contents.stop = () => {
    throw stopError;
  };
  assert.doesNotThrow(() => h.browser.revokeBackend());
  assert.ok(h.windows.every((window) => window.isDestroyed()));
  await assert.rejects(h.browser.stop(), (error) => error === stopError);
  assert.equal(h.browser.snapshot().windows, 0);
});

test("owned read returns its borrowed window to manual control and final stop saves it", async () => {
  const h = ownedHarness({
    executeJavaScript: async () =>
      JSON.stringify({
        status: 200,
        payload: { code: 0, zpData: { jobList: [], hasMore: false } },
      }),
  });
  await h.browser.openLogin(login);
  const window = h.windows[0];
  await h.browser.readBoss({
    ref: { scope, activityId: "synthetic-borrow" },
    token: {},
    sessionRef: h.entry.sessionRef,
    operation: buildBossOperation({ kind: "boss.search", query: "synthetic" }),
  });
  assert.equal(h.windows.length, 1);
  assert.equal(window.isDestroyed(), false);
  assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 1 });
  await h.browser.stop();
  assert.equal(window.isDestroyed(), true);
  assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 0 });
  assert.equal(h.destroyedGetters(), 0);
  assert.ok(h.writes.some((w) => w.kind === "material"));
});

test("prepare failure after native destruction retains its cause and clears session hooks", async () => {
  const h = nativeFixture(),
    Base = h.BrowserWindow,
    expected = Error("synthetic preparation failure");
  h.BrowserWindow = class extends Base {
    constructor(options) {
      super(options);
      this.contents.setWindowOpenHandler = () => {
        this.destroy();
        throw expected;
      };
    }
  };
  const browser = createCollectionBrowser({
    ...h,
    sessionStore: {},
    ledger: { reserve: async (v) => v, settle: async () => {} },
  });
  await assert.rejects(browser.read(input), (error) => error === expected);
  assert.deepEqual(browser.snapshot(), { activeReads: 0, windows: 0 });
  assert.equal(h.destroyedGetters(), 0);
  assert.equal(h.windows[0].contents.session.listenerCount("will-download"), 0);
  assert.equal(h.windows[0].contents.session.headers, null);
  await browser.stop();
});

test("failed manual handback holds the borrowed login window and revoked held cleanup writes nothing", async () => {
  const h = ownedHarness({
    executeJavaScript: async () =>
      JSON.stringify({
        status: 200,
        payload: { code: 0, zpData: { jobList: [], hasMore: false } },
      }),
  });
  await h.browser.openLogin(login);
  const window = h.windows[0],
    ses = window.contents.session;
  let preparations = 0;
  ses.setProxy = async () => {
    preparations++;
    if (preparations === 2) throw Error("synthetic manual handback failure");
  };
  await h.browser.readBoss({
    ref: { scope, activityId: "synthetic-held" },
    token: {},
    sessionRef: h.entry.sessionRef,
    operation: buildBossOperation({ kind: "boss.search", query: "synthetic" }),
  });
  assert.equal(window.isDestroyed(), false);
  assert.equal(h.browser.snapshot().windows, 1);
  await assert.rejects(h.browser.openLogin(login), {
    code: "collection_login_cleanup_failed",
  });
  const previousWrites = h.writes.length;
  h.browser.revokeBackend();
  await h.browser.stop();
  assert.equal(h.writes.length, previousWrites);
  assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 0 });
  assert.equal(h.destroyedGetters(), 0);
});
