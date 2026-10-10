import test from "node:test";
import assert from "node:assert/strict";
import { within } from "@testing-library/react";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
test("application board distinguishes current-page columns from all-record totals", async (t) => {
  const f = await renderApp(t, {
    route: "#/applications?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path) =>
      path.startsWith("/applications?")
        ? {
            items: [
              {
                applicationId: "board-a",
                jobId: "board-job",
                title: "合成投递岗位",
                company: "合成单位",
                status: "applied",
                updatedAt: "2001-01-01T02:00:00Z",
                application: {
                  applicationId: "board-a",
                  status: "applied",
                  events: [
                    { type: "application_updated", at: "2026-10-10T02:00:00Z" },
                  ],
                },
              },
            ],
            total: 101,
          }
        : undefined,
  });
  const column = await f.screen.findByRole("region", {
    name: "已投递 · 当前页 1 条",
  });
  assert.ok(within(column).getByText("合成投递岗位"));
  assert.ok(within(column).getByText(/更新：2026-10-10/));
  assert.equal(within(column).queryByText(/2001-01-01/), null);
  assert.ok(f.screen.getByText("全部投递记录 101 条；当前页 1 条。"));
});
test("pending application save names the action and retains the submitted note after rejection", async (t) => {
  let reject!: (reason: unknown) => void;
  const pending = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const f = await renderApp(t, {
    route: "#/applications?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path.startsWith("/applications?")
        ? {
            items: [
              {
                applicationId: "draft-a",
                jobId: "draft-job",
                title: "合成草稿岗位",
                status: "applied",
                note: "待保存草稿",
              },
            ],
            total: 1,
          }
        : path === "/applications/draft-a" && opts.method === "PUT"
          ? pending
          : undefined,
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "编辑投递记录" }),
  );
  await f.user.click(f.screen.getByRole("button", { name: "保存投递记录" }));
  const busy = await f.screen.findByRole("button", {
    name: "正在保存投递记录…",
  });
  assert.equal((busy as HTMLButtonElement).disabled, true);
  assert.equal(
    (f.screen.getByLabelText("投递备注") as HTMLTextAreaElement).disabled,
    true,
  );
  await f.user.click(busy);
  assert.equal(
    f.apiCalls.filter((c) => c.path === "/applications/draft-a").length,
    1,
  );
  assert.equal(f.screen.queryByText("投递记录已保存"), null);
  reject(
    Object.assign(new Error("记录保存被拒绝"), {
      fieldErrors: { note: "请核对备注" },
    }),
  );
  await f.screen.findByRole("alert");
  assert.equal(
    (f.screen.getByLabelText("投递备注") as HTMLTextAreaElement).value,
    "待保存草稿",
  );
  assert.equal(
    (f.screen.getByLabelText("投递备注") as HTMLTextAreaElement).disabled,
    false,
  );
  assert.equal(f.screen.queryByText("投递记录已保存"), null);
});
test("application records the target-owned resume copy and its valid offer status", async (t) => {
  const f = await renderApp(t, {
    route: "#/applications?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path.startsWith("/applications?")
        ? {
            items: [
              {
                applicationId: "app-copy",
                jobId: "j-copy",
                title: "合成岗位",
                company: "合成机场集团",
                status: "applied",
              },
            ],
            total: 1,
          }
        : syntheticApi(path, opts),
  });
  await f.screen.findByText("合成机场集团");
  await f.user.click(
    await f.screen.findByRole("button", { name: "编辑投递记录" }),
  );
  await f.user.click(
    f.screen.getByRole("checkbox", { name: "记录使用本目标自有简历副本" }),
  );
  await f.user.click(f.screen.getByRole("combobox", { name: "投递状态" }));
  await f.user.click(await f.screen.findByRole("option", { name: "已录用" }));
  await f.user.click(f.screen.getByRole("button", { name: "保存投递记录" }));
  await f.screen.findAllByText("投递记录已保存");
  const body = f.apiCalls.find((c) => c.path === "/applications/app-copy")
    ?.body as Record<string, unknown>;
  assert.equal(body.status, "offer");
  assert.equal(body.resumeRevisionId, "copy-A@1");
  assert.equal(body.channel, undefined);
});
test("application editor saves its owning version and keeps a failed note draft", async (t) => {
  const f = await renderApp(t, {
    route: "#/applications?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path.startsWith("/applications?")
        ? {
            items: [
              {
                jobId: "job-a",
                title: "合成消防岗位",
                applicationId: "application-a",
                status: "applied",
                note: "已有备注",
              },
            ],
            total: 1,
          }
        : path === "/applications/application-a" && opts.method === "PUT"
          ? Promise.reject(
              Object.assign(Error("保存失败，请重试。"), {
                diagnosticId: "d-synthetic",
              }),
            )
          : syntheticApi(path, opts),
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "编辑投递记录" }),
  );
  await f.user.type(f.screen.getByLabelText("投递备注"), "补充");
  await f.user.click(f.screen.getByRole("button", { name: "保存投递记录" }));
  await f.screen.findByRole("alert");
  assert.match(
    (f.screen.getByLabelText("投递备注") as HTMLTextAreaElement).value,
    /补充/,
  );
  assert.deepEqual(
    f.apiCalls.find((c) => c.path === "/applications/application-a")?.scope,
    { packageId: "A", targetRevisionId: "t1@1" },
  );
});
test("application pagination reaches records beyond the first page in the exact target scope", async (t) => {
  const f = await renderApp(t, {
    route: "#/applications?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) => {
      if (path.startsWith("/applications?")) {
        const page = Number(
          new URL("http://localhost" + path).searchParams.get("page"),
        );
        return {
          items: [
            {
              applicationId: "a" + page,
              jobId: "j" + page,
              title: "第" + page + "页的投递",
              status: "applied",
              ownerPackageId: "A",
            },
          ],
          total: 101,
        };
      }
      return syntheticApi(path, opts);
    },
  });
  await f.screen.findByText("第1页的投递");
  await f.user.click(f.screen.getByRole("button", { name: "下一页" }));
  await f.screen.findByText("第2页的投递");
  assert.deepEqual(
    f.apiCalls.filter((c) => c.path.startsWith("/applications?")).at(-1)?.scope,
    { packageId: "A", targetRevisionId: "t1@1" },
  );
  assert.equal(f.screen.queryByText("第1页的投递"), null);
});
