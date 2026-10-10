import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCollectionSessions } from "../../electron/collection/sessions.mjs";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
const a = { packageId: "package-a", targetRevisionId: "target-a" },
  b = { packageId: "package-b", targetRevisionId: "target-b" };
const operation = buildBossOperation({ kind: "boss.search", query: "消防" });
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (v) => Buffer.from(v).map((n) => n ^ 91),
  decryptString: (v) =>
    Buffer.from(v)
      .map((n) => n ^ 91)
      .toString(),
};
async function fixture(t, encrypted = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "boss-risk-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const now = Date.now(),
    clock = { now: () => Date.now() };
  const options = {
    dataDir: dir,
    safeStorage: encrypted
      ? safeStorage
      : { isEncryptionAvailable: () => false },
    clock,
  };
  return { dir, now, options, store: createCollectionSessions(options) };
}
test("Boss risk survives restart, state changes cannot clear it, and status is credential free", async (t) => {
  const h = await fixture(t);
  const entry = await h.store.create({
    scope: a,
    platform: "boss",
    accountRef: "owned-a",
    remember: true,
  });
  await h.store.saveMaterial({
    scope: a,
    sessionRef: entry.sessionRef,
    cookies: [{ name: "wt2", value: "PRIVATE", domain: ".zhipin.com" }],
  });
  await h.store.setRisk({
    scope: a,
    sessionRef: entry.sessionRef,
    code: "boss_environment_risk",
    checkedAt: new Date(h.now).toISOString(),
  });
  await h.store.setState({
    scope: a,
    sessionRef: entry.sessionRef,
    state: "verified",
  });
  const restarted = createCollectionSessions(h.options);
  const status = await restarted.getStatus({
    scope: a,
    sessionRef: entry.sessionRef,
  });
  assert.equal(status.riskBlocked, true);
  assert.equal(status.code, "boss_environment_risk");
  for (const value of [
    "PRIVATE",
    "cookies",
    "encrypted",
    "partition",
    "wt2",
    "owned-a",
  ])
    assert.ok(!JSON.stringify(status).includes(value));
  await assert.rejects(
    restarted.clearRisk({
      scope: b,
      sessionRef: entry.sessionRef,
      verification: { status: "success" },
    }),
    { code: "collection_session_scope" },
  );
  for (const verification of [
    {
      status: "success",
      sessionRef: "other",
      checkedAt: new Date(h.now).toISOString(),
    },
    {
      status: "success",
      sessionRef: entry.sessionRef,
      checkedAt: new Date(h.now - 3600000).toISOString(),
    },
    {
      status: "unavailable",
      sessionRef: entry.sessionRef,
      checkedAt: new Date(h.now).toISOString(),
    },
  ])
    await assert.rejects(
      restarted.clearRisk({
        scope: a,
        sessionRef: entry.sessionRef,
        verification,
      }),
      { code: "boss_risk_recovery_required" },
    );
  assert.equal(
    (await restarted.getStatus({ scope: a, sessionRef: entry.sessionRef }))
      .riskBlocked,
    true,
  );
  await restarted.clearRisk({
    scope: a,
    sessionRef: entry.sessionRef,
    verification: {
      status: "success",
      sessionRef: entry.sessionRef,
      checkedAt: new Date(h.now).toISOString(),
    },
  });
  assert.equal(
    (await restarted.getStatus({ scope: a, sessionRef: entry.sessionRef }))
      .riskBlocked,
    false,
  );
});
test("unencrypted Boss login remains memory-only while risk metadata persists and cleanup revokes it", async (t) => {
  const h = await fixture(t, false);
  const entry = await h.store.create({
    scope: a,
    platform: "boss",
    accountRef: "owned-a",
    remember: true,
  });
  assert.equal(entry.remember, false);
  await h.store.saveMaterial({
    scope: a,
    sessionRef: entry.sessionRef,
    cookies: [{ name: "wt2", value: "PRIVATE", domain: ".zhipin.com" }],
  });
  await h.store.setRisk({
    scope: a,
    sessionRef: entry.sessionRef,
    code: "boss_account_risk",
    checkedAt: new Date(h.now).toISOString(),
  });
  const raw = await fs.readFile(
    path.join(h.dir, "collection-sessions", "risk-stops.json"),
    "utf8",
  );
  assert.ok(!raw.includes("PRIVATE"));
  assert.ok(!raw.includes("cookies"));
  const restarted = createCollectionSessions(h.options);
  assert.deepEqual(
    await restarted.readMaterial({ scope: a, sessionRef: entry.sessionRef }),
    { cookies: [] },
  );
  await restarted.cleanupPackage(a.packageId);
  await assert.rejects(
    createCollectionSessions(h.options).get({
      scope: a,
      sessionRef: entry.sessionRef,
    }),
    { code: "collection_session_scope" },
  );
});
test("risk blocks list and JD before reservations and does not affect another version", async (t) => {
  const h = await fixture(t);
  const first = await h.store.create({
      scope: a,
      platform: "boss",
      accountRef: "owned-a",
    }),
    second = await h.store.create({
      scope: b,
      platform: "boss",
      accountRef: "owned-b",
    });
  await h.store.setRisk({
    scope: a,
    sessionRef: first.sessionRef,
    code: "boss_environment_risk",
    checkedAt: new Date(h.now).toISOString(),
  });
  let claims = 0;
  const windows = collectionBrowserFixture({
    executeJavaScript: async () =>
      JSON.stringify({
        status: 200,
        payload: { code: 0, zpData: { jobList: [], hasMore: false } },
      }),
  });
  const browser = createCollectionBrowser({
    ...windows,
    sessionStore: h.store,
    ledger: {
      reserve: async (v) => {
        claims++;
        return v;
      },
      settle: async () => {},
    },
  });
  t.after(() => browser.stop());
  const input = {
    ref: { scope: a, activityId: "root" },
    token: {},
    sessionRef: first.sessionRef,
    operation,
  };
  await assert.rejects(browser.readBoss(input), { code: "boss_risk_blocked" });
  await assert.rejects(
    browser.readBoss({
      ...input,
      operation: buildBossOperation({
        kind: "boss.detail",
        securityId: "synthetic",
      }),
    }),
    { code: "boss_risk_blocked" },
  );
  assert.equal(claims, 0);
  assert.equal(
    (
      await browser.readBoss({
        ...input,
        ref: { scope: b, activityId: "other" },
        sessionRef: second.sessionRef,
      })
    ).status,
    200,
  );
});
test("risk response is latched before a queued read can start and explicit recovery requires a fresh probe", async (t) => {
  const h = await fixture(t);
  const entry = await h.store.create({
    scope: a,
    platform: "boss",
    accountRef: "owned-a",
  });
  let response = { code: 37, message: "请求环境异常" },
    evaluations = 0;
  const windows = collectionBrowserFixture({
    executeJavaScript: async () => {
      evaluations++;
      return JSON.stringify({ status: 200, payload: response });
    },
  });
  const browser = createCollectionBrowser({
    ...windows,
    sessionStore: h.store,
    ledger: { reserve: async (v) => v, settle: async () => {} },
  });
  t.after(() => browser.stop());
  const input = {
    ref: { scope: a, activityId: "root" },
    token: {},
    sessionRef: entry.sessionRef,
    operation,
  };
  const firstRead = browser.readBoss(input);
  const blocked = assert.rejects(browser.readBoss(input), {
    code: "boss_risk_blocked",
  });
  const result = await firstRead;
  assert.equal(result.payload.code, 37);
  await blocked;
  assert.equal(evaluations, 1);
  response = { code: 0, zpData: { jobList: [], hasMore: false } };
  assert.equal((await browser.recoverBossSession(input)).riskBlocked, false);
  assert.equal(evaluations, 2);
  assert.equal(
    (await h.store.getStatus({ scope: a, sessionRef: entry.sessionRef }))
      .riskBlocked,
    false,
  );
});
test("Boss reads acquire their session queue before asynchronous risk checks can reorder them", async (t) => {
  const h = await fixture(t),
    entry = await h.store.create({
      scope: a,
      platform: "boss",
      accountRef: "owned-a",
    });
  let release,
    entered,
    checks = 0;
  const gate = new Promise((r) => {
      release = r;
    }),
    ready = new Promise((r) => {
      entered = r;
    });
  const store = {
    ...h.store,
    async getStatus(input) {
      checks++;
      if (checks === 1) {
        entered();
        await gate;
      }
      return h.store.getStatus(input);
    },
  };
  const windows = collectionBrowserFixture({
    executeJavaScript: async () =>
      JSON.stringify({
        status: 200,
        payload: { code: 37, message: "请求环境异常" },
      }),
  });
  const browser = createCollectionBrowser({
    ...windows,
    sessionStore: store,
    ledger: { reserve: async (v) => v, settle: async () => {} },
  });
  t.after(() => browser.stop());
  const input = {
    ref: { scope: a, activityId: "root" },
    token: {},
    sessionRef: entry.sessionRef,
    operation,
  };
  const first = browser.readBoss(input);
  await ready;
  const second = browser.readBoss(input);
  // Own rejections immediately; high system load must not produce unhandled promises.
  const settled = Promise.allSettled([first, second]);
  try {
    await new Promise(setImmediate);
    assert.equal(
      checks,
      1,
      "queued read must not race the first asynchronous status read",
    );
  } finally {
    release();
    await settled;
  }
  const outcomes = await settled;
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[1].reason.code, "boss_risk_blocked");
});
test("restarted Boss material restores only owned platform cookies into a fresh ephemeral partition", async (t) => {
  const h = await fixture(t);
  const entry = await h.store.create({
    scope: a,
    platform: "boss",
    accountRef: "owned-a",
    remember: true,
  });
  await h.store.saveMaterial({
    scope: a,
    sessionRef: entry.sessionRef,
    cookies: [
      { name: "wt2", value: "PRIVATE", domain: ".zhipin.com" },
      { name: "foreign", value: "UNRELATED", domain: ".example.org" },
    ],
  });
  const restarted = createCollectionSessions(h.options),
    windows = collectionBrowserFixture();
  const browser = createCollectionBrowser({
    ...windows,
    sessionStore: restarted,
    ledger: { reserve: async (v) => v, settle: async () => {} },
  });
  t.after(() => browser.stop());
  const { platformPolicy } = await import(
    "../../electron/collection/network-policy.mjs"
  );
  await browser.read({
    ref: { scope: a, activityId: "root" },
    token: {},
    sessionRef: entry.sessionRef,
    url: platformPolicy("boss").entryUrl,
    routePolicy: platformPolicy("boss"),
  });
  assert.equal(
    windows.windows[0].webContents.session.cookieValues.some(
      (c) => c.name === "wt2",
    ),
    true,
  );
  assert.equal(
    windows.windows[0].webContents.session.cookieValues.some(
      (c) => c.name === "foreign",
    ),
    false,
  );
  assert.notEqual(
    windows.windows[0].options.webPreferences.partition,
    entry.partition,
  );
  assert.equal(
    windows.windows[0].options.webPreferences.partition.startsWith("persist:"),
    false,
  );
});
