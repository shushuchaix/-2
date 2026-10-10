import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { mountSettingsPage } from "../../public/js/pages/settings.js";
import { temporaryCredentials } from "../../public/js/credentials.js";
test("candidate sources remain distinct and temporary keys are memory only", async () => {
  const f = uiFixture((p, o) =>
    p === "/settings"
      ? {
          model: {
            configured: false,
            baseUrl: "https://example.com",
            model: "synthetic",
          },
        }
      : p === "/sources"
        ? {
            sources: [
              {
                sourceId: "s1",
                name: "合成来源",
                capabilities: {},
                health: [],
              },
            ],
            sites: [
              {
                siteId: "site1",
                providerId: "s1",
                status: "candidate",
                name: "候选目录",
                origin: "https://example.com",
              },
            ],
          }
        : p === "/sources/s1/probe"
          ? { status: "empty", checkedAt: "2026-10-05", issues: [] }
          : { ok: true },
  );
  const page = mountSettingsPage(f);
  await page.ready;
  const key = f.root.querySelector("#userApiKey");
  key.value = "synthetic-secret";
  key.dispatchEvent(new f.document.defaultView.Event("input"));
  assert.ok(!JSON.stringify(f.store.getState()).includes("synthetic-secret"));
  assert.ok(f.root.textContent.includes("候选"));
  f.root.querySelector("[data-probe]").click();
  await f.settle();
  assert.ok(f.root.textContent.includes("未取得有效样本"));
  assert.ok(f.root.textContent.includes("最近成功"));
  assert.ok(f.root.textContent.includes("本次尝试"));
  page.destroy();
  assert.deepEqual(temporaryCredentials.get(), {});
});
test("settings API failure remains visible", async () => {
  const f = uiFixture(() => {
    throw Error("无法读取设置");
  });
  const page = mountSettingsPage(f);
  await page.ready;
  assert.ok(f.root.textContent.includes("无法读取设置"));
  page.destroy();
});
test("successful workspace restore clears stale versions, runs and jobs, while failed restore preserves them", async () => {
  let fail = true;
  const f = uiFixture((path) => {
    if (path === "/sources") return { sources: [], sites: [] };
    if (path === "/workspace/restore" && fail) throw Error("合成恢复失败");
    return {};
  });
  const oldVersion = { revisionId: "old-target@1", enabled: false };
  f.store.dispatch({ type: "versionUpdated", version: oldVersion });
  f.store.dispatch({
    type: "target",
    id: "old-target",
    revisionId: oldVersion.revisionId,
  });
  f.store.dispatch({ type: "run-start", runId: "old-run" });
  const oldRequestId = f.store.getState().jobsRequestId;
  f.store.dispatch({
    type: "jobs",
    targetId: "old-target",
    targetRevisionId: oldVersion.revisionId,
    requestId: oldRequestId,
    data: { items: [{ jobId: "old-job" }], total: 1 },
  });
  const before = f.store.getState();
  const page = mountSettingsPage(f);
  await page.ready;
  const file = f.root.querySelector('input[aria-label="选择工作区备份"]');
  Object.defineProperty(file, "files", {
    value: [{ name: "synthetic-backup.json", size: 2, text: async () => "{}" }],
  });
  const restore = [...f.root.querySelectorAll("button")].find(
    (b) => b.textContent === "校验并恢复",
  );
  restore.click();
  await f.settle();
  assert.equal(f.store.getState(), before);
  assert.match(f.root.textContent, /合成恢复失败/);
  fail = false;
  restore.click();
  await f.settle();
  const after = f.store.getState();
  assert.deepEqual(after.versions, {});
  assert.equal(after.run, null);
  assert.equal(after.targetRevisionId, null);
  assert.deepEqual(after.jobs, { items: [], total: 0 });
  assert.ok(after.jobsRequestId > oldRequestId);
  f.store.dispatch({
    type: "jobs",
    targetId: "old-target",
    targetRevisionId: oldVersion.revisionId,
    requestId: oldRequestId,
    data: { items: ["late"], total: 1 },
  });
  assert.deepEqual(f.store.getState().jobs.items, []);
  page.destroy();
});
test("settings connects local data paths only through the desktop bridge", async () => {
  const f = uiFixture((p) =>
    p === "/sources" ? { sources: [], sites: [] } : {},
  );
  let reads = 0;
  const page = mountSettingsPage({
    ...f,
    desktopBridge: {
      getDataLocations: async () => {
        reads++;
        return {
          data: "C:/synthetic/data",
          history: "C:/synthetic/data/runs-v2",
          backups: "C:/synthetic/data/backups",
          cache: "C:/synthetic/data/cache",
          logs: "C:/synthetic/data/logs",
        };
      },
    },
  });
  await page.ready;
  await f.settle();
  assert.equal(reads, 1);
  assert.match(f.root.querySelector(".data-locations").textContent, /runs-v2/);
  assert.equal(
    f.calls.some((c) => /location|director/.test(c.path)),
    false,
  );
  page.destroy();
});
