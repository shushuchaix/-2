import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";

const scope = { packageId: "owned-correlation", targetRevisionId: "target@1" };
const operation = buildBossOperation({ kind: "boss.search", query: "消防" });
const ref = { scope, activityId: "root-00000000-0000-4000-8000-000000000001" };
const input = {
  ref,
  sessionRef: "owned",
  operation,
  token: {},
  operationLease: {},
};

function fixture(t, { payload, transportError, wire = true } = {}) {
  const events = [],
    risks = [],
    states = [];
  const base = collectionBrowserFixture({
    executeJavaScript: async (code, window) => {
      const ses = window.webContents.session;
      let headers = {};
      const xhr = {
        setRequestHeader: (name, value) => {
          headers[name] = value;
        },
        abort() {},
      };
      const ajaxSettings = { beforeSend() {} };
      const ajax = (options) => {
        (options.beforeSend || ajaxSettings.beforeSend)(xhr, options);
        Promise.resolve().then(async () => {
          if (wire) {
            const details = {
              id: 19,
              webContentsId: window.webContents.id,
              resourceType: "xhr",
              method: "POST",
              url: operation.url,
              uploadData: [
                {
                  bytes: Buffer.from(
                    new URLSearchParams(operation.parameters).toString(),
                  ),
                },
              ],
            };
            const decision = await new Promise((resolve) =>
              ses.before(details, resolve),
            );
            assert.equal(decision.cancel, false);
            const headerDecision = await new Promise((resolve) =>
              ses.beforeHeaders(
                { ...details, requestHeaders: headers },
                resolve,
              ),
            );
            assert.equal(headerDecision.cancel, false);
            if (transportError)
              ses.errored({ ...details, error: transportError });
            else ses.completed({ ...details, statusCode: 200 });
          }
          if (transportError) options.error({ status: 0 }, "error");
          else
            options.success(
              payload || {
                code: 0,
                zpData: { jobList: [], hasMore: false },
              },
              "success",
              { status: 200 },
            );
        });
        return xhr;
      };
      return vm.runInNewContext(code, {
        window: { $: { ajaxSettings, ajax } },
      });
    },
  });
  const fromPartition = base.session.fromPartition;
  base.session.fromPartition = (...args) => {
    const ses = fromPartition(...args);
    ses.webRequest.onBeforeSendHeaders = (filter, callback) => {
      ses.beforeHeaders = filter ? callback : null;
    };
    ses.webRequest.onCompleted = (filter, callback) => {
      ses.completed = filter ? callback : null;
    };
    ses.webRequest.onErrorOccurred = (filter, callback) => {
      ses.errored = filter ? callback : null;
    };
    ses.webRequest.onBeforeRedirect = (filter, callback) => {
      ses.redirected = filter ? callback : null;
    };
    return ses;
  };
  const browser = createCollectionBrowser({
    ...base,
    diagnostics: (event) => {
      events.push(event);
      return { diagnosticId: "d-00000000-0000-4000-8000-000000000001" };
    },
    publicResolverFactory: () =>
      Object.assign(async () => assert.fail("no DNS network"), {
        close: async () => {},
      }),
    ledger: { reserve: async (value) => value, settle: async () => {} },
    sessionStore: {
      get: async () => ({
        ...scope,
        platform: "boss",
        sessionRef: "owned",
        partition: "owned-correlation",
      }),
      readMaterial: async () => ({ cookies: [] }),
      saveMaterial: async () => {},
      getStatus: async () => ({ state: "unverified", riskBlocked: false }),
      setState: async (value) => states.push(value.state),
      setRisk: async (value) => risks.push(value.code),
    },
  });
  t.after(() => browser.stop());
  return { browser, events, risks, states, base };
}

test("owned wire completion, business classification and returned reference share one actual request", async (t) => {
  const h = fixture(t);
  const result = await h.browser.readBoss(input);
  const business = h.events.find(
    (event) => event.parser?.version === "boss-business-response",
  );
  const wire = h.events.find(
    (event) => event.phase === "response" && event.endpointKind === "list",
  );
  assert.match(result.requestId, /^q-[a-f0-9-]{36}$/);
  assert.equal(result.requestId, wire.requestId);
  assert.equal(result.requestId, business.requestId);
  assert.equal(business.phase, "parse");
  assert.equal(business.resultCategory, "success");
  assert.equal(business.requestPurpose, "list");
  assert.deepEqual(h.states, ["verified"]);
  assert.equal(h.base.values.values().next().value.completed, null);
  assert.doesNotMatch(
    JSON.stringify(h.events),
    /https:|query|消防|parameters|payload|uploadData/,
  );
});

test("transport failure classification survives through the business layer without assuming a challenge", async (t) => {
  const h = fixture(t, { transportError: "net::ERR_CONNECTION_RESET" });
  const result = await h.browser.readBoss(input);
  const transport = h.events.find((event) => event.phase === "transport");
  const business = h.events.find(
    (event) => event.parser?.version === "boss-business-response",
  );
  assert.equal(result.requestId, transport.requestId);
  assert.equal(business.requestId, transport.requestId);
  assert.equal(business.resultCategory, "network");
  assert.equal(business.httpStatus, undefined);
  assert.deepEqual(h.risks, []);
  assert.deepEqual(h.states, []);
});

test("HTTP 200 business risk is preserved without retries or marking the owned session verified", async (t) => {
  const h = fixture(t, {
    payload: {
      code: 37,
      message: "当前环境存在异常",
      zpData: "private-response",
    },
  });
  const result = await h.browser.readBoss(input);
  const business = h.events.find(
    (event) => event.parser?.version === "boss-business-response",
  );
  assert.equal(business.resultCategory, "business_risk");
  assert.equal(business.requestId, result.requestId);
  assert.deepEqual(h.risks, ["boss_environment_risk"]);
  assert.deepEqual(h.states, []);
  assert.equal(
    h.events.filter(
      (event) => event.phase === "started" && event.endpointKind === "list",
    ).length,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(h.events),
    /private-response|当前环境|https:|payload/,
  );
});

test("no physical operation observation produces no invented business request correlation", async (t) => {
  const h = fixture(t, { wire: false });
  const result = await h.browser.readBoss(input);
  const business = h.events.find(
    (event) => event.parser?.version === "boss-business-response",
  );
  assert.equal(result.requestId, undefined);
  assert.equal(business.requestId, undefined);
  assert.equal(business.resultCategory, "success");
});
