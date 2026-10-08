import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
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
