import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
import { within, waitFor, act } from "@testing-library/react";

async function openSource(
  f: Awaited<ReturnType<typeof renderApp>>,
  name: string,
) {
  const summary = await f.screen.findByRole("region", {
    name: name + "来源摘要",
  });
  await f.user.click(
    within(summary).getByRole("button", { name: "查看来源配置" }),
  );
}
const base = {
  isAvailable: async () => true,
  getKeyStatus: async () => ({}),
  saveKey: async () => ({}),
  deleteKey: async () => ({}),
  getDataLocations: async () => ({}),
  openDataLocation: async () => ({}),
  copyDataLocation: async () => ({}),
};
test("Boss version session supports a paused root and keeps risk recovery an explicit action", async (t) => {
  const probes: any[] = [];
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    desktopBridge: {
      ...base,
      getCollectionCapabilities: async () => ({
        available: true,
        canRemember: true,
      }),
      getCollectionSessionStatus: async () => ({
        state: "verified",
        riskBlocked: true,
        code: "boss_environment_risk",
      }),
      probeBossSession: async (input: any) => {
        probes.push(input);
        return {
          state: "verified",
          riskBlocked: input.clearRisk !== true,
          sourceStatus: "ready",
        };
      },
    },
    apiHandler: (p, o) =>
      p === "/sources"
        ? {
            sources: [
              {
                sourceId: "boss",
                name: "Boss直聘",
                sessionRef: "session-A",
                config: { enabled: false },
              },
            ],
            sites: [],
          }
        : p === "/collections"
          ? {
              collections: [
                {
                  runId: "owned-root",
                  collectionProgress: { status: "paused" },
                },
              ],
            }
          : syntheticApi(p, o),
  });
  await openSource(f, "Boss直聘");
  await f.user.click(
    await f.screen.findByRole("button", { name: "Boss直聘独立登录" }),
  );
  await f.screen.findByText("风险阻塞：普通继续和重新打开窗口不会解除");
  assert.equal(f.screen.queryByLabelText("公开文章或帖子链接"), null);
  await f.user.click(
    f.screen.getByRole("button", { name: "明确解除风险并重新核验" }),
  );
  await f.screen.findByText("Boss来源正文已核验");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].activityId, "owned-root");
  assert.equal(probes[0].clearRisk, true);
  assert.deepEqual(probes[0].scope, {
    packageId: "A",
    targetRevisionId: "t1@1",
  });
  assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 1);
});
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
  await openSource(f, "公众号");
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

test("a late login window response cannot become the next version session", async (t) => {
  let finishA: (v: unknown) => void = () => {};
  const opens: any[] = [],
    verifications: any[] = [];
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    desktopBridge: {
      ...base,
      getCollectionCapabilities: async () => ({
        available: true,
        canRemember: true,
      }),
      openCollectionLogin: async (input: any) => {
        opens.push(input);
        if (input.scope.packageId === "A")
          return new Promise((resolve) => {
            finishA = resolve;
          });
        return {
          sessionRef: "session-B",
          state: "unverified",
          remembered: false,
        };
      },
      verifyCollectionSession: async (input: any) => {
        verifications.push(input);
        return { state: "verified" };
      },
    },
    apiHandler: (p, o) =>
      p === "/sources"
        ? {
            sources: [
              { sourceId: "wechat", name: "公众号", config: { enabled: true } },
            ],
            sites: [],
          }
        : p === "/collections"
          ? {
              collections: [
                {
                  runId: "root-" + (o.scope as any)?.packageId,
                  collectionProgress: { status: "collecting" },
                },
              ],
            }
          : syntheticApi(p, o),
  });
  await openSource(f, "公众号");
  await f.user.click(f.screen.getByRole("button", { name: "公众号独立登录" }));
  await f.user.type(
    f.screen.getByLabelText("公开文章或帖子链接"),
    "https://mp.weixin.qq.com/s/A",
  );
  await f.user.click(
    f.screen.getByRole("checkbox", { name: "记住此版本登录" }),
  );
  await f.user.click(
    f.screen.getByRole("button", { name: "打开独立采集窗口" }),
  );
  await act(async () => {
    window.location.hash = "#/sources?packageId=B&targetRevisionId=t2%401";
    window.dispatchEvent(new Event("hashchange"));
  });
  await waitFor(() =>
    assert.equal(
      f.screen.queryAllByRole("dialog", { name: "独立采集会话" }).length,
      0,
    ),
  );
  await act(async () =>
    finishA({ sessionRef: "session-A", state: "verified", remembered: true }),
  );
  await openSource(f, "公众号");
  await f.user.click(f.screen.getByRole("button", { name: "公众号独立登录" }));
  assert.equal(
    (f.screen.getByLabelText("公开文章或帖子链接") as HTMLInputElement).value,
    "",
  );
  assert.equal(
    (
      f.screen.getByRole("checkbox", {
        name: "记住此版本登录",
      }) as HTMLInputElement
    ).checked,
    false,
  );
  assert.equal(
    (
      f.screen.getByRole("button", {
        name: "验证登录后正文",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  await f.user.type(
    f.screen.getByLabelText("公开文章或帖子链接"),
    "https://mp.weixin.qq.com/s/B",
  );
  await f.user.click(
    f.screen.getByRole("button", { name: "打开独立采集窗口" }),
  );
  await f.screen.findByText("未验证：关闭窗口不会完成正文核验");
  await f.user.click(f.screen.getByRole("button", { name: "验证登录后正文" }));
  assert.equal(opens.length, 2);
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].sessionRef, "session-B");
  assert.equal(verifications[0].activityId, "root-B");
  assert.deepEqual(verifications[0].scope, {
    packageId: "B",
    targetRevisionId: "t2@1",
  });
});
