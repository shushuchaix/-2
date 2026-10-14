import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  bossPageScript,
  bossAbortScript,
  decodeBossPageResult,
} from "../../electron/collection/boss-page.mjs";
import {
  buildBossOperation,
  parseBossResponse,
} from "../../src/sources/boss/protocol.mjs";

const search = buildBossOperation({
  kind: "boss.search",
  query: "消防",
  page: 1,
});
const detail = buildBossOperation({
  kind: "boss.detail",
  securityId: "synthetic",
  lid: "list",
});
const list = { code: 0, zpData: { jobList: [], hasMore: false } };
function nativePage({
  response = { status: 200, data: JSON.stringify(list) },
  rejectResponse = false,
  pending = false,
  arrayAdapter = false,
  otherClient = false,
  unsupported = false,
  emptyHooks = false,
  rejectedRecovery = false,
  requestFailure = false,
  candidateOverflow = false,
  unsafeFactory = false,
} = {}) {
  const observations = {
    requests: [],
    requestHooks: 0,
    responseHooks: 0,
    rejectedHooks: 0,
    cancels: 0,
    adapterSelections: 0,
    isolatedClients: 0,
  };
  const transport = async (config) => {
    observations.requests.push(config);
    if (pending)
      return new Promise((resolve, reject) => {
        config.cancelToken.reject = reject;
      });
    if (rejectResponse) throw Object.assign(Error("upstream"), { response });
    return response;
  };
  const manager = () => ({
    handlers: [],
    use(fulfilled, rejected, options = {}) {
      this.handlers.push({ fulfilled, rejected, ...options });
      return this.handlers.length - 1;
    },
  });
  const makeClient = (defaults) => ({
    defaults,
    interceptors: { request: manager(), response: manager() },
    request(config) {
      let result = Promise.resolve({ ...this.defaults, ...config });
      for (const handler of [...this.interceptors.request.handlers].reverse())
        if (handler) result = result.then(handler.fulfilled, handler.rejected);
      result = result.then((config) => config.adapter(config));
      for (const handler of this.interceptors.response.handlers)
        if (handler) result = result.then(handler.fulfilled, handler.rejected);
      return result;
    },
    post(url, data, options) {
      return this.request({ ...options, url, data, method: "post" });
    },
    get(url, options) {
      return this.request({ ...options, url, method: "get" });
    },
  });
  const client = makeClient({
    adapter: unsupported ? null : arrayAdapter ? ["xhr", "fetch"] : transport,
    withCredentials: true,
  });
  if (!emptyHooks) {
    client.interceptors.request.use((config) => {
      observations.requestHooks++;
      if (requestFailure) throw Error("native request setup failed");
      return config;
    });
    client.interceptors.response.use(
      (response) => {
        observations.responseHooks++;
        return response;
      },
      (error) => {
        observations.rejectedHooks++;
        if (rejectedRecovery) return transport({ recovery: true });
        throw error;
      },
    );
  }
  client.axios = {
    create(defaults) {
      observations.isolatedClients++;
      return unsafeFactory ? client : makeClient(defaults);
    },
    CancelToken: {
      source() {
        const token = {};
        return {
          token,
          cancel() {
            observations.cancels++;
            token.reject?.(
              Object.assign(Error("cancelled"), { __CANCEL__: true }),
            );
          },
        };
      },
    },
    getAdapter(adapters) {
      observations.adapterSelections++;
      assert.deepEqual(JSON.parse(JSON.stringify(adapters)), ["xhr", "fetch"]);
      return transport;
    },
  };
  if (unsupported) delete client.axios.getAdapter;
  const window = { Vue: { app: { $ajax: client } } };
  const nodes = [{ __vue__: { $ajax: client } }];
  if (otherClient) nodes.push({ __vue__: { $ajax: { ...client } } });
  if (candidateOverflow) {
    while (nodes.length < 64) nodes.push({});
    nodes.push({ __vue__: { $ajax: { ...client } } });
  }
  const document = {
    querySelectorAll() {
      return nodes;
    },
  };
  const context = vm.createContext({ window, document, URLSearchParams });
  return { context, window, observations, client };
}

test("native page client sends one fixed search with its request hook and captures before response recovery", async () => {
  const h = nativePage({ arrayAdapter: true });
  const result = decodeBossPageResult(
    await vm.runInContext(bossPageScript(search, "read-a"), h.context),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, list);
  assert.equal(h.observations.requests.length, 1);
  assert.equal(h.observations.requestHooks, 1);
  assert.equal(h.observations.responseHooks, 0);
  assert.equal(h.observations.adapterSelections, 1);
  const sent = h.observations.requests[0];
  assert.equal(sent.url, search.url);
  assert.equal(sent.method, "post");
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(sent.data)),
    Object.fromEntries(
      Object.entries(search.parameters).map(([k, v]) => [k, String(v)]),
    ),
  );
  assert.equal(
    sent.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(Object.hasOwn(h.window, "__rjrBoss_read-a"), false);
});

test("native initialization waits for local hooks without sending a premature request", async () => {
  const h = nativePage({ emptyHooks: true });
  Object.assign(h.context, { setTimeout, clearTimeout });
  const pending = vm.runInContext(
    bossPageScript(search, "ready-read"),
    h.context,
  );
  assert.equal(h.observations.requests.length, 0);
  h.client.interceptors.request.use((config) => config);
  const result = decodeBossPageResult(await pending);
  assert.equal(result.status, 200);
  assert.equal(h.observations.requests.length, 1);
});

test("cancellation while hooks initialize sends nothing and removes the read handle", async () => {
  const h = nativePage({ emptyHooks: true });
  Object.assign(h.context, { setTimeout, clearTimeout });
  const pending = vm.runInContext(
    bossPageScript(search, "ready-cancel"),
    h.context,
  );
  vm.runInContext(bossAbortScript("ready-cancel"), h.context);
  assert.equal(
    decodeBossPageResult(await pending).code,
    "collection_cancelled",
  );
  assert.equal(h.observations.requests.length, 0);
  assert.equal(Object.hasOwn(h.window, "__rjrBoss_ready-cancel"), false);
});

test("native detail preserves the fixed GET parameters and complete payload", async () => {
  const payload = {
    code: 0,
    zpData: { jobCard: { postDescription: "公开岗位正文" } },
  };
  const h = nativePage({ response: { status: 200, data: payload } });
  const result = decodeBossPageResult(
    await vm.runInContext(bossPageScript(detail, "read-a"), h.context),
  );
  assert.deepEqual(result.payload, payload);
  assert.equal(h.observations.requests.length, 1);
  assert.equal(h.observations.requests[0].url, detail.url);
  assert.equal(h.observations.requests[0].method, "get");
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.observations.requests[0].params)),
    detail.parameters,
  );
  assert.equal(h.observations.responseHooks, 0);
});

for (const [code, message, expected] of [
  [37, "环境存在异常", "boss_environment_risk"],
  [36, "账户风险", "boss_account_risk"],
  [122, "凭据失效", "boss_auth_expired"],
]) {
  test(`native response code ${code} is captured without invoking refresh, challenge or a second transport`, async () => {
    const h = nativePage({
      response: { status: 200, data: JSON.stringify({ code, message }) },
    });
    const result = decodeBossPageResult(
      await vm.runInContext(bossPageScript(search, "read-a"), h.context),
    );
    assert.equal(result.payload.code, code);
    assert.equal(h.observations.requests.length, 1);
    assert.equal(h.observations.responseHooks, 0);
    assert.equal(
      parseBossResponse({
        kind: search.kind,
        ...result,
        checkedAt: "2026-10-14T00:00:00Z",
      }).code,
      expected,
    );
  });
}

test("native HTTP rejection preserves status and body before the page response interceptor", async () => {
  const h = nativePage({
    response: { status: 403, data: '{"code":0}' },
    rejectResponse: true,
  });
  const result = decodeBossPageResult(
    await vm.runInContext(bossPageScript(search, "read-a"), h.context),
  );
  assert.equal(result.status, 403);
  assert.equal(h.observations.requests.length, 1);
  assert.equal(h.observations.responseHooks, 0);
});

test("native cancel aborts only this read and resolves a cancelled response", async () => {
  const h = nativePage({ pending: true });
  const pending = vm.runInContext(bossPageScript(search, "read-a"), h.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.observations.requests.length, 1);
  vm.runInContext(bossAbortScript("read-a"), h.context);
  assert.equal(
    decodeBossPageResult(await pending).code,
    "collection_cancelled",
  );
  assert.equal(h.observations.cancels, 1);
  assert.equal(h.observations.responseHooks, 0);
  assert.equal(Object.hasOwn(h.window, "__rjrBoss_read-a"), false);
});

for (const options of [{ otherClient: true }, { unsupported: true }]) {
  test(`ambiguous or unsupported native client sends nothing: ${JSON.stringify(options)}`, async () => {
    const h = nativePage(options);
    const result = decodeBossPageResult(
      await vm.runInContext(bossPageScript(search, "read-a"), h.context),
    );
    assert.equal(result.code, "boss_ajax_unavailable");
    assert.equal(h.observations.requests.length, 0);
  });
}

test("native malformed JSON is rejected without calling page recovery", async () => {
  const h = nativePage({
    response: { status: 200, data: "<html>not a job response</html>" },
  });
  const result = decodeBossPageResult(
    await vm.runInContext(bossPageScript(search, "read-a"), h.context),
  );
  assert.equal(result.payload, undefined);
  assert.equal(h.observations.requests.length, 1);
  assert.equal(h.observations.responseHooks, 0);
  assert.equal(
    parseBossResponse({ kind: search.kind, ...result }).code,
    "boss_response_invalid",
  );
});

test("capture isolates the original rejected response recovery as well as fulfilled recovery", async () => {
  const h = nativePage({
    rejectedRecovery: true,
    response: { status: 200, data: '{"code":122}' },
  });
  const result = decodeBossPageResult(
    await vm.runInContext(bossPageScript(search, "read-a"), h.context),
  );
  assert.equal(result.payload.code, 122);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.observations.requests.length, 1);
  assert.equal(h.observations.rejectedHooks, 0);
  assert.equal(h.observations.responseHooks, 0);
  assert.equal(h.observations.requestHooks, 1);
  assert.equal(h.observations.isolatedClients, 1);
  assert.equal(h.observations.requests[0].withCredentials, true);
});

test("native request setup failure never enters the original response recovery chain", async () => {
  const h = nativePage({ rejectedRecovery: true, requestFailure: true });
  const result = decodeBossPageResult(
    await vm.runInContext(bossPageScript(search, "read-a"), h.context),
  );
  assert.equal(result.code, "boss_transport_failed");
  assert.equal(h.observations.requests.length, 0);
  assert.equal(h.observations.rejectedHooks, 0);
});

for (const options of [
  { emptyHooks: true },
  { candidateOverflow: true },
  { unsafeFactory: true },
]) {
  test(`ineligible native client sends zero: ${JSON.stringify(options)}`, async () => {
    const h = nativePage(options);
    const result = decodeBossPageResult(
      await vm.runInContext(bossPageScript(search, "read-a"), h.context),
    );
    assert.equal(result.code, "boss_ajax_unavailable");
    assert.equal(h.observations.requests.length, 0);
  });
}
