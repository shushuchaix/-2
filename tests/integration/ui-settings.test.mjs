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
test('settings connects local data paths only through the desktop bridge',async()=>{
 const f=uiFixture(p=>p==='/sources'?{sources:[],sites:[]}:{});let reads=0;
 const page=mountSettingsPage({...f,desktopBridge:{getDataLocations:async()=>{reads++;return {data:'C:/synthetic/data',history:'C:/synthetic/data/runs-v2',backups:'C:/synthetic/data/backups',cache:'C:/synthetic/data/cache',logs:'C:/synthetic/data/logs'};}}});
 await page.ready;await f.settle();assert.equal(reads,1);assert.match(f.root.querySelector('.data-locations').textContent,/runs-v2/);assert.equal(f.calls.some(c=>/location|director/.test(c.path)),false);page.destroy();
});
