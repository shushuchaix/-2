import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCollectionSessions } from "../../electron/collection/sessions.mjs";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
const scope = { packageId: "owned-version", targetRevisionId: "target@1" };
const other = { ...scope, targetRevisionId: "target@2" };
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (v) => Buffer.from(v).map((n) => n ^ 91),
  decryptString: (v) =>
    Buffer.from(v)
      .map((n) => n ^ 91)
      .toString(),
};
async function fixture(t, { executeJavaScript, allowAutomatic = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "boss-continuity-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { dataDir: dir, safeStorage },
    store = createCollectionSessions(options);
  const base = collectionBrowserFixture({ executeJavaScript });
  let navigations = 0,
    failLoad = false;
  class Window extends base.BrowserWindow {
    constructor(options) {
      super(options);
      this.presented = 0;
      this.minimized = false;
    }
    show() {
      this.presented++;
    }
    focus() {}
    isMinimized() {
      return this.minimized;
    }
    restore() {
      this.minimized = false;
    }
    async loadURL(url) {
      navigations++;
      if (failLoad)
        throw Object.assign(Error("private navigation"), { errno: -111 });
      await super.loadURL(url);
    }
  }
  const browser = createCollectionBrowser({
    ...base,
    BrowserWindow: Window,
    sessionStore: store,
    ledger: {
      reserve: async (input) =>
        allowAutomatic
          ? input
          : assert.fail("manual login must not reserve automatic campaign"),
    },
  });
  t.after(() => browser.stop());
  return {
    dir,
    options,
    store,
    base,
    browser,
    navigations: () => navigations,
    fail: () => {
      failLoad = true;
    },
  };
}
const create = (store, input = {}) =>
  store.create({ scope, platform: "boss", accountRef: "boss", ...input });
const open = (browser, input = {}) =>
  browser.openLogin({
    ref: { scope },
    platform: "boss",
    accountRef: "boss",
    ...input,
  });
const material = [
  { name: "synthetic-login", value: "PRIVATE", domain: ".zhipin.com" },
];

test("Boss reopening retains the owned reference, partition and remembered material, including after restart", async (t) => {
  const h = await fixture(t),
    first = await create(h.store, { remember: true });
  await h.store.saveMaterial({
    scope,
    sessionRef: first.sessionRef,
    cookies: material,
  });
  const same = await create(h.store);
  assert.equal(same.sessionRef, first.sessionRef);
  assert.equal(same.partition, first.partition);
  assert.equal(
    same.remember,
    true,
    "omitting a preference preserves the user's choice",
  );
  const restarted = createCollectionSessions(h.options),
    restored = await create(restarted);
  assert.equal(restored.sessionRef, first.sessionRef);
  assert.notEqual(restored.partition, first.partition);
  assert.deepEqual(
    await restarted.readMaterial({ scope, sessionRef: restored.sessionRef }),
    { cookies: material },
  );
  assert.equal(
    (await restarted.getStatus({ scope, sessionRef: restored.sessionRef }))
      .remembered,
    true,
  );
});

test("explicitly disabling remember removes the encrypted copy while retaining the current runtime login", async (t) => {
  const h = await fixture(t),
    first = await create(h.store, { remember: true });
  await h.store.saveMaterial({
    scope,
    sessionRef: first.sessionRef,
    cookies: material,
  });
  const same = await create(h.store, {
    sessionRef: first.sessionRef,
    remember: false,
  });
  assert.equal(same.sessionRef, first.sessionRef);
  assert.equal(same.remember, false);
  assert.deepEqual(
    await h.store.readMaterial({ scope, sessionRef: same.sessionRef }),
    { cookies: material },
  );
  const raw = JSON.parse(
    await fs.readFile(
      path.join(h.dir, "collection-sessions/sessions.json"),
      "utf8",
    ),
  );
  assert.equal(raw.entries[first.sessionRef], undefined);
});

test("an existing session reference must match both version and platform account, and cannot be adopted by another version", async (t) => {
  const h = await fixture(t),
    first = await create(h.store);
  await assert.rejects(
    create(h.store, { scope: other, sessionRef: first.sessionRef }),
    { code: "collection_session_scope" },
  );
  await assert.rejects(
    create(h.store, {
      accountRef: "other-account",
      sessionRef: first.sessionRef,
    }),
    { code: "collection_session_scope" },
  );
  const separate = await create(h.store, { scope: other });
  assert.notEqual(separate.sessionRef, first.sessionRef);
  assert.notEqual(separate.partition, first.partition);
});

test("a new Boss reference and clearing login materials cannot bypass the version's persisted risk", async (t) => {
  const h = await fixture(t),
    first = await create(h.store);
  const at = new Date().toISOString();
  await h.store.setRisk({
    scope,
    sessionRef: first.sessionRef,
    code: "boss_environment_risk",
    checkedAt: at,
  });
  const second = await create(h.store, { accountRef: "different-reference" });
  assert.notEqual(second.sessionRef, first.sessionRef);
  assert.equal(
    (await h.store.getStatus({ scope, sessionRef: second.sessionRef }))
      .riskBlocked,
    true,
  );
  await h.store.clear({ scope, sessionRef: first.sessionRef });
  assert.equal(
    (await h.store.getStatus({ scope, sessionRef: second.sessionRef }))
      .riskBlocked,
    true,
  );
  const restarted = createCollectionSessions(h.options),
    reopened = await create(restarted);
  assert.equal(
    (await restarted.getStatus({ scope, sessionRef: reopened.sessionRef }))
      .riskBlocked,
    true,
  );
  assert.equal(
    (
      await h.store.getStatus({
        scope: other,
        sessionRef: (await create(h.store, { scope: other })).sessionRef,
      })
    ).riskBlocked,
    false,
  );
});

test("fresh explicit recovery clears all references of only the verified Boss version", async (t) => {
  const h = await fixture(t),
    first = await create(h.store),
    second = await create(h.store, { accountRef: "second" }),
    separate = await create(h.store, { scope: other });
  const at = new Date(Date.now() - 1000).toISOString();
  for (const [owner, entry] of [
    [scope, first],
    [scope, second],
    [other, separate],
  ])
    await h.store.setRisk({
      scope: owner,
      sessionRef: entry.sessionRef,
      code: "boss_account_risk",
      checkedAt: at,
    });
  await h.store.clearRisk({
    scope,
    sessionRef: second.sessionRef,
    verification: {
      expectedRiskStamp: (
        await h.store.get({ scope, sessionRef: second.sessionRef })
      ).riskStamp,
      sessionRef: second.sessionRef,
      status: "success",
      checkedAt: new Date().toISOString(),
    },
  });
  assert.equal(
    (await h.store.getStatus({ scope, sessionRef: first.sessionRef }))
      .riskBlocked,
    false,
  );
  assert.equal(
    (await h.store.getStatus({ scope: other, sessionRef: separate.sessionRef }))
      .riskBlocked,
    true,
  );
});

test("reopening an owned manual Boss window presents it without reloading or allocating a second window", async (t) => {
  const h = await fixture(t),
    first = await open(h.browser, { remember: true });
  h.base.windows[0].minimized = true;
  const second = await open(h.browser, {
    sessionRef: first.sessionRef,
    remember: true,
  });
  assert.equal(second.sessionRef, first.sessionRef);
  assert.equal(h.base.windows.length, 1);
  assert.equal(h.navigations(), 1);
  assert.equal(h.base.windows[0].minimized, false);
  assert.equal(h.base.windows[0].presented, 1);
});

test("failed navigation during reopening must preserve previously remembered material and risk", async (t) => {
  const h = await fixture(t),
    first = await create(h.store, { remember: true });
  await h.store.saveMaterial({
    scope,
    sessionRef: first.sessionRef,
    cookies: material,
  });
  await h.store.setRisk({
    scope,
    sessionRef: first.sessionRef,
    code: "boss_environment_risk",
    checkedAt: new Date().toISOString(),
  });
  h.fail();
  await assert.rejects(
    open(h.browser, { sessionRef: first.sessionRef, remember: true }),
    { code: "collection_login_load_failed" },
  );
  assert.deepEqual(
    (
      await h.store.readMaterial({ scope, sessionRef: first.sessionRef })
    ).cookies.map(({ name, value, domain }) => ({ name, value, domain })),
    material,
  );
  assert.equal(
    (await h.store.getStatus({ scope, sessionRef: first.sessionRef }))
      .riskBlocked,
    true,
  );
});

test("concurrent manual opens for one Boss version share a single navigation", async (t) => {
  const h = await fixture(t),
    results = await Promise.all([open(h.browser), open(h.browser)]);
  assert.equal(results[0].sessionRef, results[1].sessionRef);
  assert.equal(h.base.windows.length, 1);
  assert.equal(h.navigations(), 1);
});

test("a cleared Boss reference cannot resurrect login material when the login dialog is reopened", async (t) => {
  const h = await fixture(t),
    first = await open(h.browser, { remember: true });
  h.base.windows[0].webContents.session.cookieValues = material;
  await h.browser.clearSession({ scope, sessionRef: first.sessionRef });
  const second = await open(h.browser, { sessionRef: first.sessionRef });
  assert.notEqual(second.sessionRef, first.sessionRef);
  assert.deepEqual(
    await h.store.readMaterial({ scope, sessionRef: second.sessionRef }),
    { cookies: [] },
  );
});

test("newer risk on a different reference rejects a delayed recovery under the storage lock", async (t) => {
  const h = await fixture(t),
    first = await create(h.store),
    second = await create(h.store, { accountRef: "second" });
  const at = new Date(Date.now() - 1000).toISOString(),
    verifiedAt = new Date().toISOString();
  await h.store.setRisk({
    scope,
    sessionRef: first.sessionRef,
    code: "boss_account_risk",
    checkedAt: at,
  });
  await h.store.setRisk({
    scope,
    sessionRef: second.sessionRef,
    code: "boss_account_risk",
    checkedAt: at,
  });
  let riskReads = 0;
  const riskFile = path.join(h.dir, "collection-sessions/risk-stops.json");
  const delayed = createCollectionSessions({
    ...h.options,
    fsAdapter: {
      ...fs,
      async readFile(file, ...args) {
        if (file === riskFile && ++riskReads === 3) {
          const data = JSON.parse(await fs.readFile(riskFile, "utf8"));
          data.entries[first.sessionRef].risk.checkedAt = new Date(
            Date.parse(verifiedAt) + 1000,
          ).toISOString();
          await fs.writeFile(riskFile, JSON.stringify(data));
        }
        return fs.readFile(file, ...args);
      },
    },
  });
  await assert.rejects(
    delayed.clearRisk({
      scope,
      sessionRef: second.sessionRef,
      verification: {
        expectedRiskStamp: (
          await h.store.get({ scope, sessionRef: second.sessionRef })
        ).riskStamp,
        sessionRef: second.sessionRef,
        status: "success",
        checkedAt: verifiedAt,
      },
    }),
    { code: "boss_risk_recovery_required" },
  );
  assert.equal(
    (await h.store.getStatus({ scope, sessionRef: first.sessionRef }))
      .riskBlocked,
    true,
  );
});

for (const remember of [false, true])
  test(`failed remember=${remember} persistence remains retryable without false success`, async (t) => {
    const h = await fixture(t);
    let blocked = false;
    const store = createCollectionSessions({
      ...h.options,
      fsAdapter: {
        ...fs,
        rename: async (from, to) => {
          if (blocked && to.endsWith("sessions.json"))
            throw Object.assign(Error("synthetic disk failure"), {
              code: "EIO",
            });
          return fs.rename(from, to);
        },
      },
    });
    const first = await create(store, { remember: !remember });
    await store.saveMaterial({
      scope,
      sessionRef: first.sessionRef,
      cookies: material,
    });
    blocked = true;
    await assert.rejects(
      create(store, { sessionRef: first.sessionRef, remember }),
      { code: "EIO" },
    );
    assert.equal(
      (await store.getStatus({ scope, sessionRef: first.sessionRef }))
        .remembered,
      !remember,
    );
    blocked = false;
    const retried = await create(store, {
      sessionRef: first.sessionRef,
      remember,
    });
    const disk = JSON.parse(
      await fs.readFile(
        path.join(h.dir, "collection-sessions/sessions.json"),
        "utf8",
      ),
    );
    assert.equal(retried.remember, remember);
    assert.equal(Boolean(disk.entries[first.sessionRef]?.encrypted), remember);
  });

test("failed reused navigation cannot overwrite remembered material with partially replaced cookies", async (t) => {
  const h = await fixture(t),
    first = await create(h.store, { remember: true });
  await h.store.saveMaterial({
    scope,
    sessionRef: first.sessionRef,
    cookies: material,
  });
  const load = h.base.BrowserWindow.prototype.loadURL;
  h.base.BrowserWindow.prototype.loadURL = async function (url) {
    await load.call(this, url);
    this.webContents.session.cookieValues = [];
    throw Error("synthetic partial navigation");
  };
  await assert.rejects(open(h.browser, { sessionRef: first.sessionRef }), {
    code: "collection_login_load_failed",
  });
  const restarted = createCollectionSessions(h.options);
  assert.deepEqual(
    await restarted.readMaterial({ scope, sessionRef: first.sessionRef }),
    { cookies: material },
  );
});

for (const action of ["stop", "closePackage"])
  test(`${action} drains a Boss login still preparing its session before returning`, async (t) => {
    const h = await fixture(t);
    let entered,
      release,
      closed = false;
    const ready = new Promise((r) => {
        entered = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    const createEntry = h.store.create;
    h.store.create = async (input) => {
      entered();
      await gate;
      return createEntry(input);
    };
    const opening = open(h.browser).then(
      () => "opened",
      (e) => e.code,
    );
    await ready;
    const closing = (
      action === "stop"
        ? h.browser.stop()
        : h.browser.closePackage(scope.packageId)
    ).then(() => {
      closed = true;
    });
    try {
      await new Promise(setImmediate);
      assert.equal(
        closed,
        false,
        "cleanup must await the in-flight session operation",
      );
    } finally {
      release();
      await closing;
      await opening;
    }
    assert.equal(await opening, "collection_cancelled");
    assert.equal(h.base.windows.length, 0);
  });

test("opening a manual window during an automatic Boss read is rejected without a leaked window", async (t) => {
  let entered, release;
  const ready = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const h = await fixture(t, {
    allowAutomatic: true,
    executeJavaScript: async () => {
      entered();
      await gate;
      return JSON.stringify({
        status: 200,
        payload: { code: 0, zpData: { jobList: [], hasMore: false } },
      });
    },
  });
  const first = await create(h.store);
  const reading = h.browser.readBoss({
    ref: { scope, activityId: "synthetic-root" },
    token: {},
    sessionRef: first.sessionRef,
    operation: buildBossOperation({ kind: "boss.search", query: "消防" }),
  });
  await ready;
  try {
    await assert.rejects(open(h.browser, { sessionRef: first.sessionRef }), {
      code: "collection_session_busy",
    });
    assert.equal(h.base.windows.length, 1);
  } finally {
    release();
    await reading;
    await h.browser.stop();
  }
  assert.ok(h.base.windows.every((win) => win.isDestroyed()));
});

test("a later same-millisecond risk cannot be cleared by an older verification snapshot", async (t) => {
  const h = await fixture(t),
    first = await create(h.store),
    second = await create(h.store, { accountRef: "second" });
  const at = new Date().toISOString();
  await h.store.setRisk({
    scope,
    sessionRef: first.sessionRef,
    code: "boss_environment_risk",
    checkedAt: at,
  });
  const before = await h.store.get({ scope, sessionRef: second.sessionRef });
  await h.store.setRisk({
    scope,
    sessionRef: first.sessionRef,
    code: "boss_environment_risk",
    checkedAt: at,
  });
  await assert.rejects(
    h.store.clearRisk({
      scope,
      sessionRef: second.sessionRef,
      verification: {
        status: "success",
        sessionRef: second.sessionRef,
        checkedAt: at,
        expectedRiskStamp: before.riskStamp,
      },
    }),
    { code: "boss_risk_recovery_required" },
  );
});

test("clearing a session drains its loading window and prevents late rebinding of the revoked reference", async (t) => {
  const h = await fixture(t),
    first = await create(h.store, { remember: true });
  await h.store.saveMaterial({
    scope,
    sessionRef: first.sessionRef,
    cookies: material,
  });
  let entered,
    release,
    cleared = false;
  const ready = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const fromPartition = h.base.session.fromPartition;
  h.base.session.fromPartition = (partition) => {
    const ses = fromPartition(partition);
    ses.setProxy = async () => {
      entered();
      await gate;
    };
    return ses;
  };
  const opening = open(h.browser, { sessionRef: first.sessionRef }).then(
    () => "opened",
    (e) => e.code,
  );
  await ready;
  const clearing = h.browser
    .clearSession({ scope, sessionRef: first.sessionRef })
    .then(() => {
      cleared = true;
    });
  try {
    await Promise.race([clearing, new Promise((r) => setTimeout(r, 80))]);
    assert.equal(
      cleared,
      false,
      "clear must drain the suspended preparation before returning",
    );
  } finally {
    release();
    await clearing;
    await opening;
  }
  assert.equal(await opening, "collection_cancelled");
  assert.ok(h.base.windows.every((win) => win.isDestroyed()));
});

test("a failure while attaching manual window policy closes the allocated window and leaves no active owner", async (t) => {
  const h = await fixture(t);
  // Fail before loadURL: the partially allocated window must still be owned
  // by cleanup rather than becoming an invisible resource leak.
  h.base.session.fromPartition = ((fromPartition) => (partition) => {
    const ses = fromPartition(partition);
    ses.webRequest.onHeadersReceived = (filter, callback) => {
      if (filter) throw Error("synthetic setup failure");
      ses.headers = callback;
    };
    return ses;
  })(h.base.session.fromPartition);
  await assert.rejects(open(h.browser), {
    code: "collection_login_load_failed",
  });
  assert.equal(h.navigations(), 0);
  assert.ok(h.base.windows.every((win) => win.isDestroyed()));
  assert.equal(h.browser.snapshot().windows, 0);
});
