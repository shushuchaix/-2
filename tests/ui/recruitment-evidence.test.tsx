import test from "node:test";
import assert from "node:assert/strict";
import { within } from "@testing-library/react";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
test("evidence shows unknown qualification, source cell and unresolved conflicts", async (t) => {
  const item = {
    jobId: "j-A",
    title: "合成消防岗",
    sourceEvidence: [
      {
        field: "major",
        quote: "消防工程专业",
        sourceUrl: "https://example.org/jobs",
        page: 2,
        cell: "B3",
      },
    ],
    recruitmentEvidence: {
      bodyVerified: false,
      openingStatus: "unknown",
      applicationStatus: "login_required",
      conflicts: [{ field: "deadline" }],
    },
    evaluation: { qualification: { status: "unknown" } },
  };
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p.startsWith("/jobs?")
        ? { items: [item], total: 1 }
        : p === "/jobs/j-A"
          ? item
          : syntheticApi(p, o),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "查看岗位" }));
  const sheet = await f.screen.findByRole("dialog", { name: "合成消防岗" });
  await within(sheet).findByText("正文待补全");
  await f.user.click(f.screen.getByRole("tab", { name: "来源与核验历史" }));
  await f.screen.findByText(/第 2 页.*B3/);
  assert.ok(f.screen.getAllByText("待核实").length);
  assert.equal(f.screen.queryByText("本版本招聘事实已核实"), null);
});

for (const scenario of [
  {
    name: "communication",
    applicationStatus: "available",
    entryKind: "communication",
    entryLabel: "打开沟通入口",
    expectedReason: "平台沟通入口不构成投递证据。",
  },
  {
    name: "unknown",
    applicationStatus: "unknown",
    entryKind: "apply",
    entryLabel: "查看入口（待核验）",
    expectedReason: "投递入口待核验",
  },
  {
    name: "invalid",
    applicationStatus: "invalid",
    entryKind: "apply",
    entryLabel: null,
    expectedReason: "入口失效",
  },
  {
    name: "verified",
    applicationStatus: "available",
    entryKind: "apply",
    entryLabel: "前往投递",
    expectedReason: "投递入口已核验",
  },
]) {
  test(
    "application entry follows " +
      scenario.name +
      " evidence and uses the corresponding safe URL",
    async (t) => {
      const entryUrl = "https://example.org/entry/" + scenario.name;
      const detail = {
        jobId: "j-entry",
        title: "合成入口岗位",
        company: "合成单位",
        applyUrl: "https://example.org/other-apply",
        platformEvidence: {
          entry: {
            kind: scenario.entryKind,
            status: "verified",
            url: entryUrl,
          },
        },
        recruitmentEvidence: {
          bodyVerified: true,
          openingStatus: "open",
          applicationStatus: scenario.applicationStatus,
        },
        evaluation: { score: 100, qualification: { status: "pass" } },
      };
      const f = await renderApp(t, {
        route: "#/jobs?packageId=A&targetRevisionId=t1%401",
        apiHandler: (path, options) =>
          path.startsWith("/jobs?")
            ? { items: [detail], total: 1 }
            : path === "/jobs/j-entry"
              ? detail
              : syntheticApi(path, options),
      });
      await f.user.click(
        await f.screen.findByRole("button", { name: "查看岗位" }),
      );
      const sheet = await f.screen.findByRole("dialog", {
        name: "合成入口岗位",
      });
      assert.ok(within(sheet).getByRole("region", { name: "岗位证据摘要" }));
      assert.ok(within(sheet).getByText(scenario.expectedReason));
      if (scenario.entryLabel)
        assert.equal(
          within(sheet)
            .getByRole("link", { name: scenario.entryLabel })
            .getAttribute("href"),
          entryUrl,
        );
      else
        assert.equal(
          within(sheet).queryAllByRole("link", {
            name: /前往投递|查看入口|打开沟通入口/,
          }).length,
          0,
        );
      if (scenario.name === "communication")
        assert.equal(
          within(sheet).queryAllByRole("link", { name: "前往投递" }).length,
          0,
        );
    },
  );
}

test("an unsafe corresponding entry is withheld and closed evidence remains different from unknown", async (t) => {
  const detail = {
    jobId: "j-unsafe",
    title: "已截止合成岗位",
    applyUrl: "https://example.org/safe-but-other",
    platformEvidence: {
      entry: { kind: "communication", url: "javascript:alert(1)" },
    },
    recruitmentEvidence: {
      bodyVerified: true,
      openingStatus: "closed",
      applicationStatus: "unknown",
    },
    evaluation: { qualification: { status: "fail" } },
  };
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, options) =>
      path.startsWith("/jobs?")
        ? { items: [detail], total: 1 }
        : path === "/jobs/j-unsafe"
          ? detail
          : syntheticApi(path, options),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "查看岗位" }));
  const summary = await f.screen.findByRole("region", { name: "岗位证据摘要" });
  assert.ok(within(summary).getByText("已截止"));
  assert.ok(within(summary).getByText("不符合明确要求"));
  assert.equal(
    f.screen.queryAllByRole("link", { name: /前往投递|查看入口|打开沟通入口/ })
      .length,
    0,
  );
});

test("official email candidates display qualified trust and copying never records an application", async t => {
  const address="published-hr@another.invalid",writes:string[]=[];
  const item={jobId:"j-mail",title:"合成邮箱岗位",application:{status:"new"},
    applicationChannels:[{channelId:"mail-fixture",kind:"manual_email",status:"candidate",address,
      sourceUrl:"https://example.org/careers",instructionExcerpt:"简历投递邮箱",observedAt:"2026-10-27T00:00:00Z",
      verificationMethod:"official_instruction_observed",deliveryVerified:false,submitted:false}],
    recruitmentEvidence:{bodyVerified:true,openingStatus:"unknown",applicationStatus:"unknown"},
  };
  const f=await renderApp(t,{route:"#/jobs?packageId=A&targetRevisionId=t1%401",apiHandler:(path,options)=>{
    if(options.method && options.method!=="GET") writes.push(path);
    return path.startsWith("/jobs?")?{items:[item],total:1}:path==="/jobs/j-mail"?item:syntheticApi(path,options);
  }});
  await f.user.click(await f.screen.findByRole("button",{name:"查看岗位"}));
  await f.screen.findByRole("dialog",{name:item.title});
  await f.user.click(f.screen.getByRole("tab",{name:"来源与核验历史"}));
  const candidates=await f.screen.findByRole("region",{name:"官网邮件投递候选"});
  assert.ok(within(candidates).getByText(address));assert.ok(within(candidates).getByText(/未证明邮箱实际收件或已经提交/));
  assert.equal(within(candidates).getByRole("link",{name:"查看邮箱官方来源"}).getAttribute("href"),"https://example.org/careers");
  await f.user.click(within(candidates).getByRole("button",{name:"复制邮箱"}));
  await within(candidates).findByText("邮箱已复制，尚未发送或记录为已投递。");
  assert.equal(await navigator.clipboard.readText(),address);assert.deepEqual(writes,[]);
  assert.equal(f.screen.queryByRole("link",{name:"前往投递"}),null);
});