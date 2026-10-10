import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { createContentReadService } from "../../src/application/content-read-service.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import {
  bossPageScript,
  bossAbortScript,
  decodeBossPageResult,
} from "../../electron/collection/boss-page.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
import {
  createPagePolicy,
  platformPolicy,
} from "../../electron/collection/network-policy.mjs";

const operation = buildBossOperation({
  kind: "boss.search",
  query: "消防",
  page: 1,
});
const payload = { code: 0, zpData: { jobList: [], hasMore: false } };
const ref = {
  scope: { packageId: "package-a", targetRevisionId: "target-a" },
  activityId: "root-a",
};
const token = { epoch: 1, expectedRevision: 1, sliceRunId: "slice-a" };

test("page operation uses the existing Ajax hook and aborts its own handle without retry", async () => {
  let hooks = 0,
    calls = 0,
    aborts = 0,
    ajaxInput;
  const window = {
    $: {
      ajaxSettings: {
        beforeSend() {
          hooks++;
        },
      },
      ajax(input) {
        calls++;
        ajaxInput = input;
        this.ajaxSettings.beforeSend();
        return {
          abort() {
            aborts++;
            input.error({ status: 0 }, "abort");
          },
        };
      },
    },
  };
  const context = vm.createContext({ window });
  const pending = vm.runInContext(bossPageScript(operation, "read-a"), context);
  assert.equal(calls, 1);
  assert.equal(hooks, 1);
  assert.equal(ajaxInput.type, "POST");
  assert.deepEqual(
    JSON.parse(JSON.stringify(ajaxInput.data)),
    operation.parameters,
  );
  assert.equal(Object.hasOwn(ajaxInput, "beforeSend"), false);
  vm.runInContext(bossAbortScript("read-a"), context);
  assert.equal(aborts, 1);
  assert.equal(
    decodeBossPageResult(await pending).code,
    "collection_cancelled",
  );
  assert.equal(calls, 1);
});

test("missing page Ajax authentication hook returns unavailable and sends nothing", async () => {
  let calls = 0;
  const result = await vm.runInNewContext(bossPageScript(operation, "read-a"), {
    window: {
      $: {
        ajax() {
          calls++;
        },
      },
    },
  });
  assert.equal(decodeBossPageResult(result).code, "boss_ajax_unavailable");
  assert.equal(calls, 0);
  assert.throws(() => decodeBossPageResult("x".repeat(6291457)), {
    code: "collection_browser_output_limit",
  });
});

test("wire policy binds form and detail references to one operation before issuing a permit", async () => {
  let claims = 0;
  const policy = createPagePolicy({
    routePolicy: { ...platformPolicy("boss"), bossOperation: operation },
    reserve: async () => {
      claims++;
    },
  });
  const input = {
    url: operation.url + "?_=123",
    method: "POST",
    resourceType: "xhr",
    uploadData: [
      {
        bytes: Buffer.from(
          new URLSearchParams(operation.parameters).toString(),
        ),
      },
    ],
  };
  assert.equal(
    (
      await policy.authorize({
        ...input,
        uploadData: [
          { bytes: Buffer.from("query=other&page=1&pageSize=15&scene=1") },
        ],
      })
    ).cancel,
    true,
  );
  assert.equal(claims, 0);
  assert.equal((await policy.authorize(input)).cancel, false);
  assert.equal((await policy.authorize(input)).cancel, true);
  assert.equal(claims, 1);
  const detail = buildBossOperation({
    kind: "boss.detail",
    securityId: "synthetic",
    lid: "list",
  });
  const card = createPagePolicy({
    routePolicy: { ...platformPolicy("boss"), bossOperation: detail },
    reserve: async () => {
      claims++;
    },
  });
  const url = detail.url + "?" + new URLSearchParams(detail.parameters);
  assert.equal(
    (
      await card.authorize({
        url: url + "&extra=1",
        method: "GET",
        resourceType: "xhr",
      })
    ).cancel,
    true,
  );
  assert.equal(
    (
      await card.authorize({
        url: url.replace("synthetic", "other"),
        method: "GET",
        resourceType: "xhr",
      })
    ).cancel,
    true,
  );
  assert.equal(
    (await card.authorize({ url, method: "GET", resourceType: "xhr" })).cancel,
    false,
  );
  assert.equal(claims, 2);
});

function harness({ execute, deny = false } = {}) {
  const fixture = collectionBrowserFixture({
    executeJavaScript:
      execute || (async () => JSON.stringify({ status: 200, payload })),
  });
  const entries = new Map([
    [
      "session-a",
      {
        sessionRef: "session-a",
        packageId: "package-a",
        targetRevisionId: "target-a",
        platform: "boss",
        partition: "owned-a",
      },
    ],
    [
      "session-b",
      {
        sessionRef: "session-b",
        packageId: "package-b",
        targetRevisionId: "target-b",
        platform: "boss",
        partition: "owned-b",
      },
    ],
  ]);
  const reservations = [];
  const browser = createCollectionBrowser({
    ...fixture,
    ledger: {
      async reserve(input) {
        reservations.push(input);
        if (deny)
          throw Object.assign(Error("budget"), {
            code: "source_budget_exhausted",
          });
        return input;
      },
      async settle() {},
    },
    sessionStore: {
      async get({ scope, sessionRef }) {
        const e = entries.get(sessionRef);
        if (
          e.packageId !== scope.packageId ||
          e.targetRevisionId !== scope.targetRevisionId
        )
          throw Object.assign(Error("owner"), {
            code: "collection_session_scope",
          });
        return e;
      },
      async readMaterial() {
        return { cookies: [] };
      },
      async saveMaterial() {},
      async setState() {},
      async getStatus() {
        return { state: "unverified", riskBlocked: false };
      },
    },
    assertScope: async () => {},
  });
  return { ...fixture, browser, reservations };
}
const input = {
  ref,
  token,
  sessionRef: "session-a",
  operation,
  operationLease: { id: "lease-a" },
};

test("owned Boss reads use distinct partitions, hardened windows and original reservations", async () => {
  const h = harness();
  const results = await Promise.all([
    h.browser.readBoss(input),
    h.browser.readBoss({
      ...input,
      ref: {
        ...ref,
        scope: { packageId: "package-b", targetRevisionId: "target-b" },
      },
      sessionRef: "session-b",
    }),
  ]);
  assert.equal(results[0].status, 200);
  assert.deepEqual(results[0].payload, payload);
  assert.deepEqual(
    h.windows.map((w) => w.options.webPreferences.partition).sort(),
    ["owned-a", "owned-b"],
  );
  for (const w of h.windows) {
    assert.equal(w.options.webPreferences.nodeIntegration, false);
    assert.equal(w.options.webPreferences.sandbox, true);
    assert.equal(w.options.webPreferences.preload, undefined);
    assert.equal(w.isDestroyed(), true);
  }
  assert.equal(
    h.reservations.filter((r) => r.bytesUpperBound === 20971520).length,
    2,
  );
  assert.equal(
    h.reservations.filter((r) => r.requestUpperBound === 1).length,
    2,
  );
  assert.ok(
    h.reservations.every(
      (r) => r.token === token && r.operationLease === input.operationLease,
    ),
  );
});

test("zero budget never opens a window and destroyed context is evaluated only once", async () => {
  const denied = harness({ deny: true });
  await assert.rejects(denied.browser.readBoss(input), {
    code: "source_budget_exhausted",
  });
  assert.equal(denied.windows.length, 0);
  let evaluations = 0;
  const broken = harness({
    execute: async () => {
      evaluations++;
      throw Error("Execution context was destroyed");
    },
  });
  await assert.rejects(broken.browser.readBoss(input));
  assert.equal(evaluations, 1);
  assert.equal(broken.windows[0].isDestroyed(), true);
});

test("cancel aborts the page operation, drains the window and rejects a late result", async () => {
  let finish,
    started = false,
    aborts = 0;
  const h = harness({
    execute: async (code) => {
      if (code.startsWith("(function pageAbort")) {
        aborts++;
        return;
      }
      started = true;
      return new Promise((r) => {
        finish = r;
      });
    },
  });
  const controller = new AbortController();
  const pending = h.browser.readBoss({ ...input, signal: controller.signal });
  while (!started) await new Promise((r) => setImmediate(r));
  controller.abort(
    Object.assign(Error("cancel"), { code: "collection_cancelled" }),
  );
  await assert.rejects(pending, { code: "collection_cancelled" });
  finish(JSON.stringify({ status: 200, payload }));
  assert.equal(aborts, 1);
  assert.equal(h.windows[0].isDestroyed(), true);
});

test("content read service delegates Boss once and never uses other transports", async () => {
  let calls = 0;
  const service = createContentReadService({
    browser: {
      async readBoss(v) {
        calls++;
        assert.equal(v, input);
        throw Object.assign(Error("unavailable"), {
          code: "boss_ajax_unavailable",
        });
      },
    },
    request: async () => {
      throw Error("HTTP fallback forbidden");
    },
    anonymousWorker: {
      read: async () => {
        throw Error("worker fallback forbidden");
      },
    },
  });
  await assert.rejects(service.readBoss(input), {
    code: "boss_ajax_unavailable",
  });
  assert.equal(calls, 1);
});
