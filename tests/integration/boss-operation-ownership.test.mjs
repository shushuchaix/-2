import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import { BOSS_OPERATION_HEADER } from "../../electron/collection/boss-operation-ownership.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";

const scope = { packageId: "owned-operation", targetRevisionId: "target@1" };
const operation = buildBossOperation({ kind: "boss.search", query: "消防" });
const payload = { code: 0, zpData: { jobList: [], hasMore: false } };
const input = {
  ref: { scope },
  token: {},
  operationLease: {},
  sessionRef: "owned",
  operation,
};
function harness(
  t,
  {
    lateUnmarked = false,
    duplicate = false,
    wrongMarker = false,
    alterParameters = false,
    denyOwnedBudget = false,
  } = {},
) {
  const events = [],
    wire = [],
    initial = [],
    states = [],
    order = [];
  let nextId = 1;
  const send = async (ses, window, params, headers = {}) => {
    const details = {
      id: nextId++,
      webContentsId: window.webContents.id,
      url: operation.url,
      method: "POST",
      resourceType: "xhr",
      uploadData: [
        { bytes: Buffer.from(new URLSearchParams(params).toString()) },
      ],
    };
    const before = await new Promise((r) => ses.before(details, r));
    if (before.cancel) return before;
    const decision = await new Promise((r) =>
      ses.beforeHeaders({ ...details, requestHeaders: headers }, r),
    );
    if (decision.cancel) {
      ses.errored?.({ ...details, error: "net::ERR_BLOCKED_BY_CLIENT" });
      return decision;
    }
    wire.push({
      headers: decision.requestHeaders,
      body: details.uploadData[0].bytes.toString(),
    });
    ses.completed?.({ ...details, statusCode: 200 });
    return decision;
  };
  const base = collectionBrowserFixture({
    executeJavaScript: (code, window) => {
      if (!window.page) {
        const ajaxSettings = {
          beforeSend(xhr) {
            order.push("native-hook");
            assert.equal(xhr.headers[BOSS_OPERATION_HEADER], undefined);
            xhr.setRequestHeader("X-Native-Auth", "synthetic-private-auth");
          },
        };
        const ajax = (options) => {
          const xhr = {
            headers: {},
            setRequestHeader(k, v) {
              this.headers[k] = v;
            },
            abort() {
              options.error({ status: 0 }, "abort");
            },
          };
          const allowed = (options.beforeSend || ajaxSettings.beforeSend).call(
            {},
            xhr,
            options,
          );
          if (allowed === false) {
            options.error({ status: 0 }, "abort");
            return xhr;
          }
          Promise.resolve().then(async () => {
            const ses = window.webContents.session;
            if (lateUnmarked)
              initial.push(await send(ses, window, operation.parameters));
            if (wrongMarker)
              xhr.headers[BOSS_OPERATION_HEADER] =
                "00000000-0000-4000-8000-000000000001";
            const result = await send(
              ses,
              window,
              alterParameters
                ? { ...operation.parameters, page: 2 }
                : operation.parameters,
              xhr.headers,
            );
            if (duplicate)
              await send(ses, window, operation.parameters, xhr.headers);
            if (result.cancel) options.error({ status: 0 }, "error");
            else options.success(payload, "success", { status: 200 });
          });
          return xhr;
        };
        window.page = vm.createContext({
          window: { $: { ajaxSettings, ajax } },
        });
      }
      return vm.runInContext(code, window.page);
    },
  });
  const fromPartition = base.session.fromPartition;
  base.session.fromPartition = (...args) => {
    const ses = fromPartition(...args);
    ses.webRequest.onBeforeSendHeaders = (filter, cb) => {
      ses.beforeHeaders = filter ? cb : null;
    };
    ses.webRequest.onCompleted = (filter, cb) => {
      ses.completed = filter ? cb : null;
    };
    ses.webRequest.onErrorOccurred = (filter, cb) => {
      ses.errored = filter ? cb : null;
    };
    return ses;
  };
  class Window extends base.BrowserWindow {
    async loadURL(url) {
      await super.loadURL(url);
      initial.push(
        await send(this.webContents.session, this, operation.parameters),
      );
    }
  }
  const browser = createCollectionBrowser({
    ...base,
    BrowserWindow: Window,
    diagnostics: (event) => events.push(event),
    publicResolverFactory: () =>
      Object.assign(async () => assert.fail("no DNS"), {
        close: async () => {},
      }),
    ledger: {
      reserve: async (value) => {
        if (denyOwnedBudget && value.kind === "resource")
          throw Object.assign(Error("synthetic budget"), {
            code: "source_budget_exhausted",
          });
        return value;
      },
      settle: async () => {},
    },
    sessionStore: {
      get: async () => ({
        ...scope,
        platform: "boss",
        sessionRef: "owned",
        partition: "ownership",
      }),
      getStatus: async () => ({ riskBlocked: false, state: "unverified" }),
      readMaterial: async () => ({ cookies: [] }),
      saveMaterial: async () => {},
      setState: async (value) => states.push(value.state),
    },
  });
  t.after(() => browser.stop());
  return { browser, events, wire, initial, states, order };
}

for (const lateUnmarked of [false, true])
  test(`initialization cannot consume or impersonate the owned operation; delayed unmarked=${lateUnmarked}`, async (t) => {
    const h = harness(t, { lateUnmarked });
    const result = await h.browser.readBoss(input);
    assert.ok(h.initial.every((result) => result.cancel));
    assert.equal(result.status, 200);
    assert.equal(h.wire.length, 1);
    assert.equal(
      h.wire[0].body,
      new URLSearchParams(operation.parameters).toString(),
    );
    assert.deepEqual(h.wire[0].headers, {
      "X-Native-Auth": "synthetic-private-auth",
    });
    assert.deepEqual(h.order, ["native-hook"]);
    assert.match(result.requestId, /^q-[a-f0-9-]{36}$/);
    const business = h.events.find(
      (event) => event.parser?.version === "boss-business-response",
    );
    assert.equal(business.requestId, result.requestId);
    assert.equal(business.resultCategory, "success");
    assert.deepEqual(h.states, ["verified"]);
    assert.doesNotMatch(
      JSON.stringify(h.events),
      /X-RJR|Owned-Operation|synthetic-private-auth|消防/,
    );
  });

for (const options of [
  { duplicate: true },
  { wrongMarker: true },
  { alterParameters: true },
])
  test(`ambiguous or invalid owned operations fail as policy without borrowing another response ${JSON.stringify(options)}`, async (t) => {
    const h = harness(t, options);
    const result = await h.browser.readBoss(input);
    assert.equal(result.status, 0);
    assert.equal(result.code, "collection_route_forbidden");
    assert.equal(result.requestId, undefined);
    const business = h.events.find(
      (event) => event.parser?.version === "boss-business-response",
    );
    assert.equal(business.resultCategory, "policy");
    assert.equal(business.requestId, undefined);
    assert.deepEqual(h.states, []);
    assert.equal(h.wire.length, options.duplicate ? 1 : 0);
    assert.ok(
      h.wire.every(
        (request) => !Object.hasOwn(request.headers, BOSS_OPERATION_HEADER),
      ),
    );
  });

test("the owned capability cannot bypass a rejected budget or invent a request identity", async (t) => {
  const h = harness(t, { denyOwnedBudget: true });
  await assert.rejects(h.browser.readBoss(input), {
    code: "source_budget_exhausted",
  });
  assert.equal(h.wire.length, 0);
  assert.deepEqual(h.states, []);
  const failure = h.events.find(
    (event) => event.parser?.version === "boss-read-failure",
  );
  assert.equal(failure.resultCategory, "budget");
  assert.equal(failure.requestId, undefined);
});
