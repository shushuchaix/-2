import test from "node:test";
import assert from "node:assert/strict";
import { createBossLoginDiagnostics } from "../../electron/collection/boss-login-diagnostics.mjs";
import {
  createPagePolicy,
  platformPolicy,
} from "../../electron/collection/network-policy.mjs";

test("blocked official destinations retain distinct fixed categories without recording addresses or query data", async () => {
  const events = [],
    notices = [];
  const monitor = createBossLoginDiagnostics({
    diagnostics: (e) => events.push(e),
    webContentsId: 1,
    counts: () => ({ manualRequests: 30, manualBytes: 492792 }),
    onNavigationDenied: (stage) => notices.push(stage),
  });
  const cases = [
    [
      "https://www.zhipin.com/?token=synthetic-private",
      "boss-login-landing-query",
    ],
    [
      "https://www.zhipin.com/#synthetic-private",
      "boss-login-landing-fragment",
    ],
    [
      "https://www.zhipin.com/web/geek/guide/?token=synthetic-private",
      "boss-login-profile-setup",
    ],
    [
      "https://www.zhipin.com/web/chat/recommend?token=synthetic-private",
      "boss-login-chat-landing",
    ],
    [
      "https://www.zhipin.com/web/boss/complete/index",
      "boss-login-employer-setup",
    ],
    [
      "https://www.zhipin.com/web/boss/complete/job",
      "boss-login-employer-job-setup",
    ],
    [
      "https://unrecognized.example/synthetic-private?token=synthetic-private",
      "boss-login-external-destination",
    ],
    ["not a synthetic url", "boss-login-invalid-destination"],
  ];
  for (const [url] of cases) {
    monitor.denied(
      { webContentsId: 1, url },
      "collection_route_forbidden",
      "redirect",
    );
    monitor.denied(
      { webContentsId: 1, url },
      "collection_route_forbidden",
      "redirect",
    );
  }
  monitor.denied(
    { webContentsId: 2, url: cases[0][0] },
    "collection_route_forbidden",
    "redirect",
  );
  await monitor.close();
  assert.deepEqual(
    events.map((e) => e.parser.version),
    cases.map(([, stage]) => stage),
  );
  assert.deepEqual(
    notices,
    cases.map(([, stage]) => stage),
  );
  assert.doesNotMatch(
    JSON.stringify({ events, notices }),
    /https:|synthetic-private|unrecognized|token|guide\/|complete\/|recommend|not a synthetic/,
  );
});

test("an earlier unknown resource denial cannot hide a subsequent blocked login redirect", async () => {
  const events = [];
  const monitor = createBossLoginDiagnostics({
    diagnostics: (e) => events.push(e),
    webContentsId: 1,
    counts: () => ({ manualRequests: 31, manualBytes: 500248 }),
  });
  monitor.denied(
    { webContentsId: 1, url: "https://static.zhipin.com/unapproved.png" },
    "collection_route_forbidden",
    "validation",
  );
  for (let i = 0; i < 3; i++)
    monitor.denied(
      {
        webContentsId: 1,
        url: "https://www.zhipin.com/web/common/403.html?code=31&token=synthetic-private",
      },
      "collection_route_forbidden",
      "redirect",
    );
  await monitor.close();
  assert.deepEqual(
    events.map((e) => e.phase),
    ["validation", "redirect"],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /synthetic-private|https:|token|unapproved|403.html/,
  );
});

test("public landing and restricted landing are distinct metadata stages without exposing their URL or parameters", async () => {
  const events = [];
  const monitor = createBossLoginDiagnostics({
    diagnostics: (e) => events.push(e),
    webContentsId: 1,
    counts: () => ({ manualRequests: 31, manualBytes: 500248 }),
  });
  const landing = {
    id: 11,
    webContentsId: 1,
    url: "https://www.zhipin.com/",
    method: "GET",
  };
  monitor.started(landing);
  monitor.completed({ ...landing, statusCode: 200 });
  monitor.denied(
    {
      webContentsId: 1,
      url: "https://www.zhipin.com/web/common/403.html?code=31&token=synthetic-private",
    },
    "collection_route_forbidden",
    "redirect",
  );
  await monitor.close();
  assert.ok(
    events.some(
      (e) =>
        e.phase === "response" && e.parser.version === "boss-login-landing",
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.phase === "redirect" &&
        e.parser.version === "boss-login-restricted-landing",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /synthetic-private|https:|token|403.html/,
  );
});

test("all disallowed login resources are observable while the route and credential boundaries stay closed", async () => {
  const events = [];
  const monitor = createBossLoginDiagnostics({
    diagnostics: (e) => events.push(e),
    webContentsId: 1,
    counts: () => ({ manualRequests: 2, manualBytes: 0 }),
  });
  const policy = createPagePolicy({
    routePolicy: platformPolicy("boss"),
    manual: true,
    webContentsId: 1,
    onDenied: (details, code) => monitor.denied(details, code),
  });
  for (const url of [
    "https://www.zhipin.com/wapi/zpgeek/friend/add.json?token=private-value",
    "https://private.example.org/script.js?token=private-value",
  ]) {
    assert.equal(
      (
        await policy.authorize({
          url,
          method: "POST",
          resourceType: "xhr",
          webContentsId: 1,
        })
      ).cancel,
      true,
    );
  }
  await monitor.close();
  assert.equal(events.length, 1);
  assert.equal(events[0].code, "collection_route_forbidden");
  assert.doesNotMatch(
    JSON.stringify(events),
    /https:|private-value|friend|private.example|token/,
  );
});
test("an exhausted login quota is reported once across different native QR stages", async () => {
  const events = [];
  let shown = 0;
  const monitor = createBossLoginDiagnostics({
    diagnostics: (e) => events.push(e),
    webContentsId: 1,
    counts: () => ({ manualRequests: 60, manualBytes: 0 }),
    onBudgetExhausted: () => shown++,
  });
  for (const path of ["scan", "scanLogin", "dispatcher"])
    monitor.denied(
      {
        webContentsId: 1,
        url:
          "https://www.zhipin.com/wapi/zppassport/qrcode/" +
          path +
          "?qrId=private-value",
      },
      "collection_login_budget_exhausted",
    );
  await monitor.close();
  assert.equal(shown, 1);
  assert.equal(events.length, 1);
  monitor.failed({ webContentsId: 1, id: 1, error: "private-error" });
  assert.equal(events.length, 1);
});
test("failed observers cannot change authorization or leave unhandled rejections", async () => {
  const policy = createPagePolicy({
    routePolicy: platformPolicy("boss"),
    manual: true,
    onDenied: async () => {
      throw Error("synthetic observer failure");
    },
  });
  assert.equal(
    (
      await policy.authorize({
        url: "https://www.zhipin.com/private",
        method: "GET",
        resourceType: "mainFrame",
      })
    ).cancel,
    true,
  );
  await new Promise(setImmediate);
});
