import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { registerCollectionIpc } from "../../electron/collection/ipc.mjs";
const diagnosticId = "d-12345678-1234-1234-1234-123456789abc";
async function sourceFixture(t, code, { detail = false, mixed = false } = {}) {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  await c.lease.release();
  await f.service.pause(c.ref);
  let detailCalls = 0;
  const provider = fakeProvider({ id: "boss" }),
    error = Object.assign(Error("private account and response"), {
      code,
      phase: "response",
    });
  provider.collect = async () => {
    if (!detail) throw error;
    return {
      records: [1, 2].map((n) => ({
        sourceRecordId: "public-" + n,
        title: "消防工程师",
        company: "合成企业",
        url: "https://example.org/job-" + n,
      })),
      issues: [],
    };
  };
  provider.fetchDetail = async (record) => {
    detailCalls++;
    if (mixed && detailCalls === 1)
      return {
        ...record,
        description:
          "岗位职责：维护消防设施并开展日常安全检查。任职要求：消防工程相关专业本科毕业，具备现场检查和记录能力。",
        bodyStatus: "complete",
        detailStatus: "complete",
      };
    throw error;
  };
  const service = createSourceService({
    repository: f.repository,
    operationGate: f.operationGate,
    registry: createSourceRegistry([provider]),
    catalog: [
      { siteId: "boss", providerId: "boss", origin: "https://example.org" },
    ],
    clock: f.clock,
    diagnostics: { record: async () => ({ diagnosticId }) },
    requestFactory: () => async () => assert.fail("network forbidden"),
    activityContext: (ref, cb) => f.service.withActivityContext(ref, cb),
  });
  const probe = () =>
    f.service.withDiagnosticContext(
      { ref: c.ref, requestId: "failed-probe" },
      () =>
        service.probeScopedSource({
          scope: f.scope,
          sourceId: "boss",
          siteId: "boss",
          ref: c.ref,
        }),
    );
  return { f, c, probe, error, detailCalls: () => detailCalls };
}

test("a successful first body cannot hide a later typed Boss read failure as ready", async (t) => {
  const h = await sourceFixture(t, "boss_ajax_unavailable", {
    detail: true,
    mixed: true,
  });
  await assert.rejects(h.probe(), { code: "boss_ajax_unavailable" });
  const w = await h.f.repository.read(),
    saved =
      w.packages[h.f.scope.packageId].collectionSettings.sourceVerification[
        "boss/boss"
      ];
  assert.equal(saved.status, "unavailable");
  assert.equal(saved.sampleCount, 2);
  assert.equal(saved.issues[0].code, "boss_ajax_unavailable");
  assert.equal(saved.issues[0].diagnosticId, diagnosticId);
  assert.equal(
    saved.capabilities.body,
    "verified",
    "retain the first real successful sample as a capability fact",
  );
  assert.equal(saved.lastSuccessAt, null);
  assert.equal(h.detailCalls(), 2);
});

test("risk recovery failure gets a diagnostic ID without probing again or clearing the latch", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  await c.lease.release();
  await f.service.pause(c.ref);
  const handlers = new Map(),
    events = [],
    mainFrame = { url: "http://127.0.0.1:31000/" },
    sender = { mainFrame };
  registerCollectionIpc({
    ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
    getWindow: () => ({ webContents: sender }),
    getOrigin: () => mainFrame.url,
    browser: {
      recoverBossSession: async () => {
        throw Object.assign(Error("private upstream"), {
          code: "boss_environment_risk",
        });
      },
    },
    sessionStore: {
      get: async () => ({ platform: "boss" }),
      getStatus: async () => ({ state: "unverified", riskBlocked: true }),
    },
    context: {
      collectionService: f.service,
      diagnostics: {
        record: async (event) => {
          events.push(event);
          return { diagnosticId };
        },
      },
      sourceService: {
        probeScopedSource: async () => assert.fail("no subsequent probe"),
      },
    },
  });
  const result = await handlers.get("collection:boss-probe")(
    { sender, senderFrame: mainFrame },
    {
      scope: f.scope,
      activityId: c.ref.activityId,
      sessionRef: "session-A",
      requestId: "recover-feedback",
      clearRisk: true,
    },
  );
  assert.equal(result.riskBlocked, true);
  assert.equal(result.issues[0].diagnosticId, diagnosticId);
  assert.equal(events.length, 1);
  assert.equal(events[0].sourceId, "boss");
  assert.equal(events[0].outcome, "failed");
  assert.equal(f.networkCalls, 0);
});

test("cancelling a pending recovery wins over its late risk error", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  await c.lease.release();
  await f.service.pause(c.ref);
  const handlers = new Map(),
    mainFrame = { url: "http://127.0.0.1:31000/" },
    sender = { mainFrame };
  let release, entered, ownerSignal;
  const gate = new Promise((r) => (release = r)),
    ready = new Promise((r) => (entered = r));
  registerCollectionIpc({
    ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
    getWindow: () => ({ webContents: sender }),
    getOrigin: () => mainFrame.url,
    browser: {
      recoverBossSession: async (ctx) => {
        ownerSignal = ctx.signal;
        entered();
        await gate;
        throw Object.assign(Error("late risk"), {
          code: "boss_environment_risk",
        });
      },
    },
    sessionStore: {
      get: async () => ({ platform: "boss" }),
      getStatus: async () =>
        assert.fail("do not normalize a cancelled recovery"),
    },
    context: {
      collectionService: f.service,
      sourceService: {
        probeScopedSource: async () => assert.fail("no subsequent probe"),
      },
    },
  });
  const pending = handlers.get("collection:boss-probe")(
    { sender, senderFrame: mainFrame },
    {
      scope: f.scope,
      activityId: c.ref.activityId,
      sessionRef: "session-A",
      requestId: "cancel-recovery",
      clearRisk: true,
    },
  );
  // Own the rejection immediately while the cancellation drains the recover call.
  const outcome = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await ready;
  const cancelled = new Promise((r) =>
    ownerSignal.addEventListener("abort", r, { once: true }),
  );
  const stopping = f.service.cancel(c.ref);
  await cancelled;
  release();
  await stopping;
  const result = await outcome;
  assert.equal(result.error, ownerSignal.reason);
  assert.equal(result.value, undefined);
});
for (const [code, status] of [
  ["boss_environment_risk", "restricted"],
  ["boss_account_risk", "restricted"],
  ["boss_auth_expired", "restricted"],
  ["boss_ajax_unavailable", "unavailable"],
])
  test(
    "typed scoped Boss failure is saved before propagating " + code,
    async (t) => {
      const h = await sourceFixture(t, code);
      const caught = await h.probe().then(
        () => assert.fail("must propagate"),
        (e) => e,
      );
      assert.equal(caught, h.error);
      assert.equal(caught.diagnosticId, diagnosticId);
      const w = await h.f.repository.read(),
        saved =
          w.packages[h.f.scope.packageId].collectionSettings.sourceVerification[
            "boss/boss"
          ];
      assert.equal(saved.status, status);
      assert.equal(saved.sampleCount, 0);
      assert.equal(saved.issues[0].code, code);
      assert.equal(saved.issues[0].diagnosticId, diagnosticId);
      assert.equal(w.sourceHealth["boss/boss"], undefined);
      assert.equal(
        w.packages[h.f.otherScope.packageId].collectionSettings
          ?.sourceVerification?.["boss/boss"],
        undefined,
      );
      assert.doesNotMatch(
        JSON.stringify(saved),
        /private account|private response|cookies|sessionRef/,
      );
      assert.equal(
        w.runs[h.c.ref.activityId].collectionProgress.status,
        "paused",
      );
      assert.equal(h.f.networkCalls, 0);
    },
  );
test("detail risk saves a restricted health result and stops before the next detail", async (t) => {
  const h = await sourceFixture(t, "boss_environment_risk", { detail: true });
  await assert.rejects(h.probe(), { code: "boss_environment_risk" });
  assert.equal(h.detailCalls(), 1);
  const w = await h.f.repository.read(),
    saved =
      w.packages[h.f.scope.packageId].collectionSettings.sourceVerification[
        "boss/boss"
      ];
  assert.equal(saved.status, "restricted");
  assert.equal(saved.sampleCount, 2);
  assert.equal(saved.issues[0].code, "boss_environment_risk");
});
test("fatal workspace failure does not save an ordinary Boss health result", async (t) => {
  const h = await sourceFixture(t, "workspace_write_failed");
  await assert.rejects(h.probe(), { code: "workspace_write_failed" });
  const w = await h.f.repository.read();
  assert.equal(
    w.packages[h.f.scope.packageId].collectionSettings?.sourceVerification?.[
      "boss/boss"
    ],
    undefined,
  );
});

test("fatal workspace failure during detail reads propagates without a health commit or next detail", async (t) => {
  const h = await sourceFixture(t, "workspace_write_failed", { detail: true });
  await assert.rejects(h.probe(), { code: "workspace_write_failed" });
  assert.equal(h.detailCalls(), 1);
  const w = await h.f.repository.read();
  assert.equal(
    w.packages[h.f.scope.packageId].collectionSettings?.sourceVerification?.[
      "boss/boss"
    ],
    undefined,
  );
});

test("desktop normalization cannot hide a fatal error even when it also carries a Boss risk code", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  await c.lease.release();
  await f.service.pause(c.ref);
  const handlers = new Map(),
    mainFrame = { url: "http://127.0.0.1:31000/" },
    sender = { mainFrame };
  const error = Object.assign(Error("fatal owner failure"), {
    code: "boss_environment_risk",
    runFatal: true,
  });
  registerCollectionIpc({
    ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
    getWindow: () => ({ webContents: sender }),
    getOrigin: () => mainFrame.url,
    browser: {},
    sessionStore: {
      get: async () => ({ platform: "boss" }),
      getStatus: async () => assert.fail("fatal errors must not be normalized"),
    },
    context: {
      collectionService: f.service,
      sourceService: {
        probeScopedSource: async () => {
          throw error;
        },
      },
    },
  });
  await assert.rejects(
    handlers.get("collection:boss-probe")(
      { sender, senderFrame: mainFrame },
      {
        scope: f.scope,
        activityId: c.ref.activityId,
        sessionRef: "session-A",
        requestId: "fatal-feedback",
      },
    ),
    (e) => e === error,
  );
});
for (const [code, riskBlocked, state] of [
  ["boss_environment_risk", true, "unverified"],
  ["boss_account_risk", true, "unverified"],
  ["boss_auth_expired", false, "expired"],
])
  test(
    "desktop feedback returns the owned state after the failed diagnostic has closed: " +
      code,
    async (t) => {
      const f = await collectionFixture(t),
        c = await f.openCommit();
      await c.lease.release();
      await f.service.pause(c.ref);
      const handlers = new Map(),
        mainFrame = { url: "http://127.0.0.1:31000/" },
        sender = { mainFrame };
      let statusReads = 0;
      registerCollectionIpc({
        ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
        getWindow: () => ({ webContents: sender }),
        getOrigin: () => mainFrame.url,
        browser: {
          recoverBossSession: async () => assert.fail("no risk recovery"),
        },
        sessionStore: {
          get: async () => ({ platform: "boss" }),
          getStatus: async (input) => {
            statusReads++;
            assert.deepEqual(input.scope, f.scope);
            assert.equal(input.sessionRef, "session-A");
            assert.equal(
              (await f.repository.read()).runs[c.ref.activityId]
                .collectionProgress.status,
              "paused",
            );
            return { state, riskBlocked, code };
          },
        },
        context: {
          collectionService: f.service,
          sourceService: {
            probeScopedSource: async () => {
              throw Object.assign(Error("private upstream response"), {
                code,
                diagnosticId,
              });
            },
          },
        },
      });
      const result = await handlers.get("collection:boss-probe")(
        { sender, senderFrame: mainFrame },
        {
          scope: f.scope,
          activityId: c.ref.activityId,
          sessionRef: "session-A",
          requestId: "risk-feedback",
          clearRisk: false,
        },
      );
      assert.equal(result.sourceStatus, "restricted");
      assert.equal(result.riskBlocked, riskBlocked);
      assert.equal(result.state, state);
      assert.equal(result.issues[0].code, code);
      assert.equal(result.issues[0].diagnosticId, diagnosticId);
      assert.equal(statusReads, 1);
      assert.doesNotMatch(
        JSON.stringify(result),
        /private upstream|session-A|cookies|encrypted/,
      );
      assert.equal(f.networkCalls, 0);
    },
  );
