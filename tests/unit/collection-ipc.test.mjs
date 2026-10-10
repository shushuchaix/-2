import test from "node:test";
import assert from "node:assert/strict";
import { registerCollectionIpc } from "../../electron/collection/ipc.mjs";

test("Boss probe fixes its operation from the owned root and clears risk only explicitly", async () => {
  const handlers = new Map(),
    mainFrame = { url: "http://127.0.0.1:31000/" },
    sender = { mainFrame };
  const scope = {
    packageId: "00000000-0000-4000-8000-000000000001",
    targetRevisionId: "target-one@1",
  };
  const calls = [];
  const ctx = {
    ref: { scope, activityId: "root" },
    token: {},
    operationLease: {},
  };
  registerCollectionIpc({
    ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
    getWindow: () => ({ webContents: sender }),
    getOrigin: () => mainFrame.url,
    sessionStore: {
      get: async () => ({ platform: "boss" }),
      getStatus: async () => ({ state: "verified", riskBlocked: false }),
    },
    context: {
      collectionService: {
        get: async () => ({
          targetSnapshot: { roles: ["消防工程师"], cities: ["北京"] },
          collectionProgress: { units: {} },
        }),
        withDiagnosticContext: async (_input, fn) => fn(ctx),
        resolveBossRisk: async () => calls.push("clear-root-risk"),
      },
      sourceService: {
        probeScopedSource: async () => {
          calls.push("probe");
          return { status: "ready" };
        },
      },
    },
    browser: {
      recoverBossSession: async (input) => {
        calls.push(input.operation);
      },
    },
  });
  const fn = handlers.get("collection:boss-probe"),
    event = { sender, senderFrame: mainFrame },
    input = {
      scope,
      activityId: "root",
      sessionRef: "session",
      requestId: "probe",
    };
  assert.equal(typeof fn, "function");
  await fn(event, input);
  assert.deepEqual(calls, ["probe", "clear-root-risk"]);
  await fn(event, { ...input, clearRisk: true });
  assert.equal(calls[2].kind, "boss.search");
  assert.equal(calls[2].parameters.query, "消防工程师");
  assert.equal(calls[2].parameters.city, "101010100");
  assert.deepEqual(calls.slice(3), [
    "clear-root-risk",
    "probe",
    "clear-root-risk",
  ]);
  await assert.rejects(
    fn(event, { ...input, operation: { url: "https://other.example" } }),
  );
});
test("collection IPC accepts only workbench root main frame and passes no credentials", async () => {
  const handlers = new Map(),
    calls = [],
    mainFrame = { url: "http://127.0.0.1:31000/" },
    sender = { mainFrame },
    win = { webContents: sender };
  registerCollectionIpc({
    ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
    getWindow: () => win,
    getOrigin: () => mainFrame.url,
    context: { collectionService: { get: async () => {} } },
    browser: {
      openLogin: async (input) => {
        calls.push(input);
        return { sessionRef: "session-one", state: "unverified" };
      },
    },
  });
  const fn = handlers.get("collection:login"),
    input = {
      scope: {
        packageId: "00000000-0000-4000-8000-000000000001",
        targetRevisionId: "target-one@1",
      },
      platform: "weibo",
      accountRef: "public-one",
    };
  for (const event of [
    { sender: {}, senderFrame: mainFrame },
    { sender, senderFrame: { url: mainFrame.url } },
    { sender, senderFrame: { ...mainFrame, url: "https://weibo.com/" } },
  ])
    await assert.rejects(fn(event, input));
  assert.equal(calls.length, 0);
  assert.deepEqual(await fn({ sender, senderFrame: mainFrame }, input), {
    sessionRef: "session-one",
    state: "unverified",
  });
  assert.equal(calls[0].remember, false);
  assert.equal(calls[0].cookie, undefined);
});

test("session status IPC exposes only scoped metadata and rejects a foreign sender", async () => {
  const handlers = new Map(),
    mainFrame = { url: "http://127.0.0.1:31000/" },
    sender = { mainFrame };
  const scope = {
    packageId: "00000000-0000-4000-8000-000000000001",
    targetRevisionId: "target-one@1",
  };
  let calls = 0;
  registerCollectionIpc({
    ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
    getWindow: () => ({ webContents: sender }),
    getOrigin: () => mainFrame.url,
    sessionStore: {
      getStatus: async (input) => {
        calls++;
        assert.deepEqual(input, { scope, sessionRef: "session-one" });
        return {
          state: "unverified",
          riskBlocked: true,
          code: "boss_environment_risk",
        };
      },
    },
    context: {},
    browser: {},
  });
  assert.equal(typeof handlers.get("collection:status"), "function");
  await assert.rejects(
    handlers.get("collection:status")(
      { sender: {}, senderFrame: mainFrame },
      { scope, sessionRef: "session-one" },
    ),
  );
  assert.deepEqual(
    await handlers.get("collection:status")(
      { sender, senderFrame: mainFrame },
      { scope, sessionRef: "session-one" },
    ),
    { state: "unverified", riskBlocked: true, code: "boss_environment_risk" },
  );
  assert.equal(calls, 1);
});
