import test from "node:test";
import assert from "node:assert/strict";
import { sourceTable } from "../../public/js/components/source-table.js";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { feedback } from "../../public/js/components/feedback.js";

test("weibo source feedback presents non-JSON as an unverified response after a probe", async () => {
  const f = uiFixture(() => ({
    status: "unavailable",
    checkedAt: "2026-10-11T00:00:00Z",
    issues: [{ code: "content_non_json" }],
  }));
  const status = feedback(f.document);
  const node = sourceTable({
    document: f.document,
    sources: [{ sourceId: "weibo", name: "微博", health: [] }],
    sites: [
      {
        siteId: "weibo",
        providerId: "weibo",
        name: "微博",
        status: "candidate",
      },
    ],
    api: f.api,
    status,
  });
  node.querySelector("[data-probe]").click();
  await f.settle();
  assert.match(node.querySelector(".badge").textContent, /非JSON/);
  assert.match(status.node.textContent, /非JSON/);
  assert.doesNotMatch(
    node.querySelector(".badge").textContent,
    /登录|可自动采集/,
  );
  assert.match(node.querySelector("summary").textContent, /0 可用/);
  assert.match(node.textContent, /最近成功：未提供/);
});

test("weibo source feedback uses the saved non-JSON reason without suggesting login", () => {
  const f = uiFixture(() => {});
  const node = sourceTable({
    document: f.document,
    sources: [{ sourceId: "weibo", name: "微博", health: [] }],
    sites: [
      {
        siteId: "weibo",
        providerId: "weibo",
        name: "微博",
        status: "candidate",
        health: {
          status: "unavailable",
          issues: [{ code: "content_non_json" }],
        },
      },
    ],
    api: f.api,
    status: feedback(f.document),
  });
  assert.match(node.querySelector(".badge").textContent, /非JSON/);
  assert.match(node.querySelector(".prose").textContent, /非JSON/);
  assert.doesNotMatch(
    node.querySelector(".badge").textContent,
    /登录|可自动采集/,
  );
});
