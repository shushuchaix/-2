import test from "node:test";
import assert from "node:assert/strict";
import {
  createBossLoginDiagnostics,
  classifyBossBusinessResult,
} from "../../electron/collection/boss-login-diagnostics.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import { cleanMetadata } from "../../src/infrastructure/diagnostics/fields.mjs";
import {
  allowsRoute,
  createPagePolicy,
  platformPolicy,
} from "../../electron/collection/network-policy.mjs";

const qr = {
  id: 71,
  webContentsId: 3,
  url: "https://www.zhipin.com/wapi/zppassport/qrcode/scanLogin?qrId=private-qr",
  method: "GET",
  resourceType: "xhr",
};
const make = (extras = {}) => {
  const events = [];
  const monitor = createBossLoginDiagnostics({
    diagnostics: (event) => events.push(event),
    counts: () => ({ manualRequests: 2 }),
    webContentsId: 3,
    ...extras,
  });
  return { events, monitor };
};
const safe = (value) =>
  assert.doesNotMatch(
    JSON.stringify(value),
    /private-|https:|zppassport|qrId|Cookie|Authorization|payload|uploadData/,
  );

test("request lifecycle correlation uses generated identifiers and actual elapsed time", async () => {
  const { monitor, events } = make();
  monitor.started(qr);
  monitor.headers({ ...qr, statusCode: 200 });
  monitor.completed({ ...qr, statusCode: 200 });
  await monitor.close();
  const [start, finish] = events;
  assert.match(start.requestId, /^q-[a-f0-9-]{36}$/);
  assert.equal(finish.requestId, start.requestId);
  assert.equal(finish.resultCategory, "response");
  assert.equal(finish.httpStatus, 200);
  assert.equal(finish.requestPurpose, "login_poll");
  assert.ok(Number.isSafeInteger(finish.durationMs));
  assert.ok(finish.durationMs < 10000);
  safe(events);
});

test("missing HTTP status has evidence-based transport categories, never assumed anti-bot", async () => {
  for (const [error, category] of [
    ["net::ERR_TIMED_OUT", "timeout"],
    ["net::ERR_CONNECTION_TIMED_OUT", "timeout"],
    ["net::ERR_ABORTED", "cancelled"],
    ["net::ERR_CONNECTION_RESET", "network"],
    ["net::ERR_NAME_NOT_RESOLVED", "network"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "network"],
    ["net::ERR_BLOCKED_BY_CLIENT", "policy"],
    ["private-server-error", "unknown"],
  ]) {
    const { monitor, events } = make();
    monitor.started(qr);
    monitor.failed({ ...qr, error });
    await monitor.close();
    assert.equal(events.at(-1).resultCategory, category, error);
    assert.equal(events.at(-1).httpStatus, undefined);
    assert.equal(events[0].requestId, events.at(-1).requestId);
    safe(events);
  }
});

test("all admitted resources are observed and unfinished requests are bounded and drained", async () => {
  const { monitor, events } = make();
  for (let id = 0; id < 80; id++)
    monitor.started({
      ...qr,
      id,
      resourceType: "image",
      url: "https://static.zhipin.com/zhipin-sign/v1/static/images/private-image.png",
    });
  monitor.started({ ...qr, id: 90, webContentsId: 99 });
  await monitor.close();
  const starts = events.filter((event) => event.phase === "started");
  const unresolved = events.filter(
    (event) => event.resultCategory === "response_unobserved",
  );
  assert.equal(starts.length, 80);
  assert.equal(unresolved.length, 80);
  assert.equal(new Set(unresolved.map((event) => event.requestId)).size, 80);
  assert.equal(
    unresolved.filter(
      (event) => event.code === "collection_request_tracking_limited",
    ).length,
    16,
  );
  assert.ok(unresolved.every((event) => event.requestPurpose === "asset"));
  assert.ok(unresolved.every((event) => event.httpStatus === undefined));
  monitor.completed({ ...qr, statusCode: 200 });
  assert.equal(events.length, 160);
  safe(events);
});

test("redirect hops retain parent correlation without persisting destination addresses", async () => {
  const { monitor, events } = make();
  monitor.started(qr);
  monitor.redirected({ ...qr, statusCode: 302 });
  monitor.started({ ...qr, url: "https://www.zhipin.com/" });
  monitor.completed({ ...qr, statusCode: 200 });
  await monitor.close();
  assert.equal(events[1].phase, "redirect");
  assert.equal(events[1].requestId, events[0].requestId);
  assert.notEqual(events[2].requestId, events[0].requestId);
  assert.equal(events[2].parentRequestId, events[0].requestId);
  assert.equal(events[3].requestId, events[2].requestId);
  safe(events);
});

test("business evidence correlates only an observed matching owned operation", async () => {
  const operation = buildBossOperation({ kind: "boss.search", query: "消防" });
  const { monitor, events } = make({ manual: false, operation });
  monitor.started(qr);
  assert.deepEqual(monitor.operationMetadata(), {});
  const sent = {
    ...qr,
    id: 72,
    method: "POST",
    url: operation.url + "?_=private-cache-key",
  };
  monitor.started(sent);
  assert.deepEqual(
    monitor.operationMetadata(),
    {},
    "the same endpoint without an owned admission is not correlated",
  );
  monitor.completed({ ...sent, statusCode: 200 });
  monitor.started({ ...sent, id: 73 }, { ownedOperation: true });
  monitor.failed({ ...sent, id: 73, error: "net::ERR_CONNECTION_RESET" });
  const observed = monitor.operationMetadata();
  assert.equal(observed.requestId, events.at(-1).requestId);
  assert.equal(observed.resultCategory, "network");
  assert.equal(
    classifyBossBusinessResult(
      { status: "unavailable" },
      { status: 0 },
      observed,
    ),
    "network",
  );
  assert.equal(
    classifyBossBusinessResult({ status: "risk_blocked" }, { status: 200 }),
    "business_risk",
  );
  assert.equal(
    classifyBossBusinessResult({ status: "login_required" }, { status: 200 }),
    "auth",
  );
  assert.equal(
    classifyBossBusinessResult({ status: "unavailable" }, { status: 0 }),
    "response_unobserved",
  );
  await monitor.close();
  safe(events);
});

test("request result categories survive whitelist sanitization and reject arbitrary text", () => {
  const safeEntry = cleanMetadata({
    durationMs: 17,
    timeoutMs: 120000,
    resultCategory: "timeout",
    requestId: "q-00000000-0000-4000-8000-000000000001",
    response: "private-response",
  });
  assert.equal(safeEntry.resultCategory, "timeout");
  assert.equal(safeEntry.timeoutMs, 120000);
  assert.equal(safeEntry.durationMs, 17);
  assert.equal(
    cleanMetadata({ resultCategory: "private-value" }).resultCategory,
    undefined,
  );
  safe(safeEntry);
});

test("a failing count or log observer cannot alter an admitted request or block disposal", async () => {
  const monitor = createBossLoginDiagnostics({
    diagnostics: () => {
      throw Error("private-observer");
    },
    counts: () => {
      throw Error("private-counter");
    },
    webContentsId: 3,
  });
  assert.doesNotThrow(() => monitor.started(qr));
  assert.doesNotThrow(() => monitor.completed({ ...qr, statusCode: 200 }));
  await monitor.close();
});

test("manual homepage navigation supports bounded public filters and anchors only", async () => {
  const routePolicy = platformPolicy("boss");
  for (const url of [
    "https://www.zhipin.com/?ka=header-home",
    "https://www.zhipin.com/?city=101010100#jobs",
    "https://www.zhipin.com/#jobs",
  ]) {
    assert.equal(allowsRoute(url, routePolicy, { manual: true }), true, url);
    assert.equal(allowsRoute(url, routePolicy), false, url);
    const policy = createPagePolicy({ routePolicy, manual: true });
    assert.equal(
      (
        await policy.authorize({
          url,
          method: "GET",
          resourceType: "mainFrame",
        })
      ).cancel,
      false,
    );
    assert.equal(
      (
        await policy.authorize({
          url,
          method: "POST",
          resourceType: "mainFrame",
        })
      ).cancel,
      true,
    );
  }
  for (const url of [
    "https://www.zhipin.com/?token=private-token",
    "https://www.zhipin.com/?redirect=https://private.example",
    "https://www.zhipin.com/?ka=https://private.example",
    "https://www.zhipin.com/#/web/chat/recommend",
    "https://www.zhipin.com/web/common/403.html",
    "https://www.zhipin.com/web/chat/recommend",
    "https://www.zhipin.com/wapi/zpgeek/friend/add.json",
    "https://zhipin.com/?ka=header-home",
    "https://www.zhipin.com.private.example/",
  ])
    assert.equal(allowsRoute(url, routePolicy, { manual: true }), false, url);
});
