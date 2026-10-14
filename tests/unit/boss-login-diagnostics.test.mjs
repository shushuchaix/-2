import test from "node:test";
import assert from "node:assert/strict";
import { createBossLoginDiagnostics } from "../../electron/collection/boss-login-diagnostics.mjs";
import {
  createPagePolicy,
  platformPolicy,
} from "../../electron/collection/network-policy.mjs";

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
