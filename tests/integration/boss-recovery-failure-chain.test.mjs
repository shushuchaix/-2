import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { registerCollectionIpc } from "../../electron/collection/ipc.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
const scope = {
  packageId: "00000000-0000-4000-8000-000000000001",
  targetRevisionId: "target@1",
};
const operation = buildBossOperation({ kind: "boss.search", query: "消防" });
const ref = { scope, activityId: "root-A" };
const diagnosticId = "d-12345678-1234-1234-1234-123456789abc";

for (const [code, phase] of [
  ["boss_ajax_unavailable", "render"],
  ["boss_transport_failed", "transport"],
])
  test(
    "explicit recovery preserves the typed page failure: " + code,
    async (t) => {
      const fixture = collectionBrowserFixture({
        executeJavaScript: async () => JSON.stringify({ status: 0, code }),
      });
      const browser = createCollectionBrowser({
        ...fixture,
        ledger: { reserve: async (v) => v, settle: async () => {} },
        sessionStore: {
          get: async () => ({
            ...scope,
            platform: "boss",
            sessionRef: "session-A",
            partition: "partition-A",
            riskStamp: "synthetic",
          }),
          getStatus: async () => ({ state: "unverified", riskBlocked: true }),
          readMaterial: async () => ({ cookies: [] }),
          saveMaterial: async () => {},
          setState: async () => {},
          clearRisk: async () =>
            assert.fail("a failed page cannot recover risk"),
          setRisk: async () =>
            assert.fail("a transport error is not a new platform risk"),
        },
      });
      t.after(() => browser.stop());
      await assert.rejects(
        browser.recoverBossSession({
          ref,
          token: {},
          sessionRef: "session-A",
          operation,
        }),
        (e) => {
          assert.equal(e.code, code);
          assert.equal(e.phase, phase);
          return true;
        },
      );
    },
  );

for (const code of [
  "boss_ajax_unavailable",
  "boss_transport_failed",
  "boss_response_invalid",
  "boss_rate_limited",
  "collection_browser_timeout",
  "collection_browser_output_limit",
])
  test(
    "IPC failed recovery returns a safe diagnostic and retains the latch: " +
      code,
    async () => {
      const handlers = new Map(),
        events = [],
        health = [];
      const mainFrame = { url: "http://127.0.0.1:31000/" },
        sender = { mainFrame };
      const error = Object.assign(Error("private upstream text and account"), {
        code,
        phase: "render",
      });

      registerCollectionIpc({
        ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
        getWindow: () => ({ webContents: sender }),
        getOrigin: () => mainFrame.url,
        browser: {
          recoverBossSession: async () => {
            throw error;
          },
        },
        sessionStore: {
          get: async () => ({ platform: "boss" }),
          getStatus: async () => ({ state: "unverified", riskBlocked: true }),
        },
        context: {
          diagnostics: {
            record: async (event) => {
              events.push(event);
              return { diagnosticId };
            },
          },
          collectionService: {
            get: async () => ({
              targetSnapshot: { roles: ["消防"] },
              collectionProgress: { units: {} },
            }),
            withDiagnosticContext: async (_input, fn) =>
              fn({ ref, signal: new AbortController().signal }),
            resolveBossRisk: async () =>
              assert.fail("failed recovery cannot clear the activity latch"),
          },
          sourceService: {
            recordScopedBossProbeFailure: async (value) => {
              health.push(value);
            },
            probeScopedSource: async () =>
              assert.fail("no further probe after failed recovery"),
          },
        },
      });
      const result = await handlers.get("collection:boss-probe")(
        { sender, senderFrame: mainFrame },
        {
          scope,
          activityId: ref.activityId,
          sessionRef: "session-A",
          requestId: "read-A",
          clearRisk: true,
        },
      );
      assert.equal(result.riskBlocked, true);
      assert.equal(result.sourceStatus, "unavailable");
      assert.equal(result.issues[0].code, code);
      assert.equal(result.issues[0].diagnosticId, diagnosticId);
      assert.equal(events.length, 1);
      assert.doesNotMatch(JSON.stringify(result), /private upstream|account/);
      assert.equal(health.length, 1);
      const { signal, collectionGuard, ...saved } = health[0];
      assert.equal(signal.aborted, false);
      assert.deepEqual(saved, {
        scope,
        sessionRef: "session-A",
        code,
        diagnosticId,
      });
    },
  );

for (const boundary of ["status", "log"])
  test(`cancellation during failed recovery ${boundary} wins before health persistence`, async () => {
    const handlers = new Map(),
      controller = new AbortController();
    const mainFrame = { url: "http://127.0.0.1:31000/" },
      sender = { mainFrame };
    let healthWrites = 0;
    const cancel = () =>
      controller.abort(
        Object.assign(Error("cancelled"), { name: "AbortError" }),
      );
    registerCollectionIpc({
      ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
      getWindow: () => ({ webContents: sender }),
      getOrigin: () => mainFrame.url,
      browser: {
        recoverBossSession: async () => {
          throw Object.assign(Error("upstream"), {
            code: "boss_transport_failed",
          });
        },
      },
      sessionStore: {
        get: async () => ({ platform: "boss" }),
        getStatus: async () => {
          if (boundary === "status") cancel();
          return { state: "unverified", riskBlocked: true };
        },
      },
      context: {
        diagnostics: {
          record: async () => {
            if (boundary === "log") cancel();
            return { diagnosticId };
          },
        },
        collectionService: {
          get: async () => ({
            targetSnapshot: { roles: ["消防"] },
            collectionProgress: { units: {} },
          }),
          withDiagnosticContext: async (_input, fn) =>
            fn({ ref, signal: controller.signal }),
        },
        sourceService: {
          recordScopedBossProbeFailure: async () => {
            healthWrites++;
          },
          probeScopedSource: async () => assert.fail("no further request"),
        },
      },
    });
    await assert.rejects(
      handlers.get("collection:boss-probe")(
        { sender, senderFrame: mainFrame },
        {
          scope,
          activityId: ref.activityId,
          sessionRef: "session-A",
          requestId: "cancel-read",
          clearRisk: true,
        },
      ),
      { name: "AbortError" },
    );
    assert.equal(healthWrites, 0);
  });
