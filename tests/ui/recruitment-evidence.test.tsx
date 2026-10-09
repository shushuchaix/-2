import test from "node:test";
import assert from "node:assert/strict";
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
  await f.screen.findByText("正文待补全");
  await f.screen.findByText(/第 2 页.*B3/);
  assert.ok(f.screen.getAllByText("待核实").length);
  assert.equal(f.screen.queryByText("本版本招聘事实已核实"), null);
});
