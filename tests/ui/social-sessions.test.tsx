import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
const base = {
  isAvailable: async () => true,
  getKeyStatus: async () => ({}),
  saveKey: async () => ({}),
  deleteKey: async () => ({}),
  getDataLocations: async () => ({}),
  openDataLocation: async () => ({}),
  copyDataLocation: async () => ({}),
};
test("dedicated login never treats a closed window as verified and cannot remember without encryption", async (t) => {
  let calls = 0;
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    desktopBridge: {
      ...base,
      getCollectionCapabilities: async () => ({
        available: true,
        canRemember: false,
      }),
      openCollectionLogin: async () => {
        calls++;
        return {
          sessionRef: "session-A",
          state: "unverified",
          remembered: false,
        };
      },
    },
    apiHandler: (p, o) =>
      p === "/sources"
        ? {
            sources: [
              {
                sourceId: "wechat",
                name: "公众号",
                config: { enabled: false },
              },
            ],
            sites: [],
          }
        : syntheticApi(p, o),
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "公众号独立登录" }),
  );
  assert.equal(
    (
      f.screen.getByRole("checkbox", {
        name: "记住此版本登录",
      }) as HTMLInputElement
    ).disabled,
    true,
  );
  await f.user.type(
    f.screen.getByLabelText("公开文章或帖子链接"),
    "https://mp.weixin.qq.com/s/test",
  );
  await f.user.click(
    f.screen.getByRole("button", { name: "打开独立采集窗口" }),
  );
  await f.screen.findByText("未验证：关闭窗口不会完成正文核验");
  assert.equal(calls, 1);
});
