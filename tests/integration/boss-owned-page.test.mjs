import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";

const ref = {
  scope: { packageId: "owned", targetRevisionId: "target@1" },
  activityId: "root",
};
const operation = buildBossOperation({ kind: "boss.search", query: "消防" });
const success = {
  status: 200,
  payload: { code: 0, zpData: { jobList: [], hasMore: false } },
};
async function fixture(
  t,
  { response = success, execute, denyBudget = false, manualWireBytes = 0 } = {},
) {
  const base = collectionBrowserFixture({
    executeJavaScript: execute || (async () => JSON.stringify(response)),
  });
  const counts = {
    navigations: 0,
    reserves: 0,
    saves: 0,
    clears: 0,
    proxyClients: [],
  };
  const load = base.BrowserWindow.prototype.loadURL;
  base.BrowserWindow.prototype.loadURL = async function (url) {
    counts.navigations++;
    return load.call(this, url);
  };
  const createClient = base.egressProxy.createClient;
  base.egressProxy.createClient = (input) => {
    counts.proxyClients.push(input);
    if (input.maxBytes < 1) throw Error("invalid_proxy_byte_limit");
    const client = createClient(input);
    if (counts.proxyClients.length === 1)
      client.snapshot = () => ({ bytes: manualWireBytes });
    return client;
  };
  let entry = {
    sessionRef: "session",
    platform: "boss",
    accountRef: "boss",
    partition: "owned-runtime",
    ...ref.scope,
    state: "unverified",
  };
  const store = {
    create: async () => entry,
    get: async ({ scope, sessionRef }) => {
      if (
        !entry ||
        sessionRef !== entry.sessionRef ||
        scope.packageId !== entry.packageId ||
        scope.targetRevisionId !== entry.targetRevisionId
      )
        throw Object.assign(Error("ownership"), {
          code: "collection_session_scope",
        });
      return entry;
    },
    getStatus: async () => ({
      state: entry.state,
      riskBlocked: !!entry.riskBlocked,
    }),
    readMaterial: async () => ({ cookies: [] }),
    saveMaterial: async () => {
      counts.saves++;
    },
    setState: async ({ state }) => {
      entry.state = state;
    },
    setRisk: async ({ code }) => {
      entry.riskBlocked = true;
      entry.code = code;
    },
    clear: async () => {
      counts.clears++;
      entry = null;
      return { status: "clean" };
    },
    cleanupPackage: async () => {
      entry = null;
      return { status: "clean" };
    },
  };
  const browser = createCollectionBrowser({
    ...base,
    sessionStore: store,
    ledger: {
      reserve: async (input) => {
        counts.reserves++;
        if (denyBudget)
          throw Object.assign(Error("no budget"), { code: "budget_exhausted" });
        return input;
      },
      settle: async () => {},
    },
  });
  t.after(() => browser.stop());
  const opened = await browser.openLogin({
    ref,
    platform: "boss",
    accountRef: "boss",
  });
  const win = base.windows[0];
  // Human navigation is represented by the already loaded owned jobs page.
  win.url = "https://www.zhipin.com/web/geek/jobs";
  const read = (input) =>
    browser.readBoss({
      ref,
      token: {},
      sessionRef: opened.sessionRef,
      operation,
      ...input,
    });
  return { base, counts, store, browser, win, read };
}

for (const response of [
  success,
  { status: 0, code: "boss_transport_failed" },
  { status: 200, payload: { code: 37 } },
])
  test(`owned jobs page survives Boss result ${response.code || response.payload.code} without a replacement or reload`, async (t) => {
    const h = await fixture(t, { response });
    const result = await h.read();
    assert.equal(result.status, response.status);
    assert.equal(h.win.isDestroyed(), false);
    assert.equal(h.base.windows.length, 1);
    assert.equal(h.counts.navigations, 1);
    assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 1 });
    assert.equal(h.win.webContents.listenerCount("login"), 1);
    assert.equal(h.win.webContents.listenerCount("will-navigate"), 1);
    assert.equal(h.win.listenerCount("closed"), 1);
    assert.equal(
      (await h.store.getStatus()).riskBlocked,
      response.payload?.code === 37,
    );
  });

test("budget rejection sends nothing and leaves the original manual page and login intact", async (t) => {
  const h = await fixture(t, { denyBudget: true });
  await assert.rejects(h.read(), { code: "budget_exhausted" });
  assert.equal(h.win.isDestroyed(), false);
  assert.equal(h.counts.navigations, 1);
  assert.equal(h.counts.proxyClients.length, 1);
});

for (const persistent of [false, true])
  test(`borrowed window survives failed network lease installation, persistent=${persistent}`, async (t) => {
    const h = await fixture(t),
      ses = h.win.webContents.session;
    const original = ses.webRequest.onHeadersReceived;
    let failures = 0;
    ses.webRequest.onHeadersReceived = (filter, cb) => {
      if (filter !== null && (persistent || !failures++))
        throw Object.assign(Error("install"), { code: "network_hook_failed" });
      return original(filter, cb);
    };
    await assert.rejects(h.read(), { code: "network_hook_failed" });
    assert.equal(h.win.isDestroyed(), false);
    assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 1 });
    assert.equal(h.base.windows.length, 1);
    if (persistent)
      assert.equal(
        (
          await new Promise((resolve) =>
            ses.before(
              {
                url: "https://www.zhipin.com/favicon.ico",
                method: "GET",
                resourceType: "image",
                webContentsId: h.win.webContents.id,
              },
              resolve,
            ),
          )
        ).cancel,
        true,
      );
  });

test("exhausted manual wire allowance retains the original page with network disabled after a successful read", async (t) => {
  const h = await fixture(t, { manualWireBytes: 20971520 - 60 * 65536 });
  assert.equal((await h.read()).status, 200);
  assert.equal(h.win.isDestroyed(), false);
  assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 1 });
  assert.equal(
    h.counts.proxyClients.some((input) => input.maxBytes < 1),
    false,
  );
  const ses = h.win.webContents.session;
  assert.equal(
    (
      await new Promise((resolve) =>
        ses.before(
          {
            url: "https://www.zhipin.com/favicon.ico",
            method: "GET",
            resourceType: "image",
            webContentsId: h.win.webContents.id,
          },
          resolve,
        ),
      )
    ).cancel,
    true,
  );
  await h.browser.clearSession({ scope: ref.scope, sessionRef: "session" });
  assert.equal(h.win.isDestroyed(), true);
});

test("operation lease never resets the manual request allowance", async (t) => {
  const h = await fixture(t);
  const ses = h.win.webContents.session;
  const request = () =>
    new Promise((resolve) =>
      ses.before(
        {
          url: "https://www.zhipin.com/favicon.ico",
          method: "GET",
          resourceType: "image",
          webContentsId: h.win.webContents.id,
        },
        resolve,
      ),
    );
  // The initial navigation has consumed one of the fixed 60 manual requests.
  for (let i = 0; i < 2; i++) assert.equal((await request()).cancel, false);
  await h.read();
  assert.equal(h.win.isDestroyed(), false);
  // Fast-forward the scheduler clock only for this synthetic quota test.
  const realNow = Date.now;
  Date.now = () => realNow() + 100000;
  try {
    for (let i = 0; i < 57; i++) assert.equal((await request()).cancel, false);
    assert.equal((await request()).cancel, true);
  } finally {
    Date.now = realNow;
  }
});

test("cancellation aborts the owned operation and restores the manual page without a new window", async (t) => {
  let entered, release;
  const ready = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const h = await fixture(t, {
    execute: async (code) => {
      if (code.includes("pageAbort")) {
        release();
        return;
      }
      entered();
      await gate;
      return JSON.stringify(success);
    },
  });
  const controller = new AbortController();
  const reading = h.read({ signal: controller.signal });
  await ready;
  controller.abort(
    Object.assign(Error("cancel"), { code: "collection_cancelled" }),
  );
  await assert.rejects(reading, { code: "collection_cancelled" });
  assert.equal(h.win.isDestroyed(), false);
  assert.equal(h.base.windows.length, 1);
  assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 1 });
});

for (const action of ["clearSession", "closePackage", "stop"])
  test(`${action} during an owned page read closes and drains it without restoring a revoked page`, async (t) => {
    let entered, release;
    const ready = new Promise((r) => {
      entered = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    const h = await fixture(t, {
      execute: async (code) => {
        if (code.includes("pageAbort")) {
          release();
          return;
        }
        entered();
        await gate;
        return JSON.stringify(success);
      },
    });
    const reading = h.read().catch((e) => e.code);
    await ready;
    await (action === "clearSession"
      ? h.browser.clearSession({ scope: ref.scope, sessionRef: "session" })
      : action === "closePackage"
        ? h.browser.closePackage(ref.scope.packageId)
        : h.browser.stop());
    release();
    assert.equal(await reading, "collection_cancelled");
    assert.equal(h.win.isDestroyed(), true);
    assert.equal(h.base.windows.length, 1);
    assert.deepEqual(h.browser.snapshot(), { activeReads: 0, windows: 0 });
  });

test("a jobs page belonging to another version is never borrowed", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    h.read({
      ref: { ...ref, scope: { ...ref.scope, targetRevisionId: "other@1" } },
    }),
    { code: "collection_session_scope" },
  );
  assert.equal(h.win.isDestroyed(), false);
  assert.equal(h.base.windows.length, 1);
});
