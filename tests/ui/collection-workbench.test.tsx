import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
const root = {
  runId: "activity-A",
  collectionRole: "collection_root",
  status: "completed",
  collectionProgress: {
    status: "paused",
    revision: 4,
    units: {
      one: { status: "completed", siteId: "s1", committedPages: 3 },
      two: { status: "pending", siteId: "s2", committedPages: 0 },
    },
    metrics: { committedPages: 3, newUnique: 8 },
    limits: {
      maxRequests: 400,
      maxCostCny: 10,
      maxSites: 24,
      maxPagesPerQuery: 4,
    },
  },
  collectionUsage: {
    usedRequests: 12,
    costUpperBoundCny: 3.2,
    reservedCostCny: 0.2,
    usedBytes: 1024,
  },
};
test("root progress retains cumulative costs; repeated resume sends one request", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [root] }
        : p === "/collections/activity-A"
          ? root
          : p.endsWith("/resume")
            ? new Promise(() => {})
            : syntheticApi(p, o),
  });
  await f.screen.findByText(/活动累计费用上界 ¥3.20/);
  await f.user.dblClick(f.screen.getByRole("button", { name: "继续采集" }));
  assert.equal(f.apiCalls.filter((c) => c.path.endsWith("/resume")).length, 1);
});
test("failed limits keep draft and business history does not count slices", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [root] }
        : p === "/collections/activity-A"
          ? root
          : p.endsWith("/limits")
            ? Promise.reject(Error("保存失败"))
            : syntheticApi(p, o),
  });
  const input = await f.screen.findByLabelText("活动请求上限");
  await f.user.clear(input);
  await f.user.type(input, "600");
  await f.user.click(f.screen.getByRole("button", { name: "保存活动额度" }));
  await f.screen.findByText(/保存失败/);
  assert.equal((input as HTMLInputElement).value, "600");
});
test("history contains one root for two collection slices", async (t) => {
  const f = await renderApp(t, {
    route: "#/logs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [root] }
        : p === "/runs"
          ? {
              runs: [
                {
                  runId: "slice1",
                  collectionRole: "collection_slice",
                  status: "completed",
                },
                {
                  runId: "slice2",
                  collectionRole: "collection_slice",
                  status: "partial",
                },
              ],
            }
          : syntheticApi(p, o),
  });
  await f.screen.findByText("activity-A");
  assert.equal(f.screen.queryByText("slice1"), null);
  assert.equal(f.screen.queryByText("slice2"), null);
  assert.ok(f.screen.getByText(/¥3.20/));
});
