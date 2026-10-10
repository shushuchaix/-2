import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
import { render, cleanup } from "@testing-library/react";
import { RecruitmentEvidence } from "../../ui/src/features/jobs/RecruitmentEvidence";
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
test("quality reports measured numerator/denominator and keeps unknown requests separate", async (t) => {
  const measured = {
    ...root,
    quality: {
      uniqueRecords: 8,
      bodyVerified: 6,
      open: 3,
      applicationAvailable: 2,
      qualificationPass: 4,
      qualificationUnknown: 3,
      qualificationFail: 1,
      historicalOrExpired: 2,
      suspectedDuplicates: 1,
      validNewUnique: 1,
      knownRequests: 10,
      unknownRequestUpperBound: 2,
      validPer100KnownRequests: 10,
    },
  };
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections" ? { collections: [measured] } : syntheticApi(p, o),
  });
  await f.screen.findByText(/正文已核验 6 \/ 8/);
  assert.ok(f.screen.getByText(/有效新增 1 \/ 已核实请求 10/));
  assert.ok(f.screen.getByText(/未知请求上界 2/));
  assert.ok(f.screen.getByText(/召回率与误合并率：未测量/));
});
test("job evidence labels expired and invalid and separates stale platform observations", (t) => {
  t.after(cleanup);
  const view = render(
    <RecruitmentEvidence
      row={{
        jobId: "synthetic",
        recruitmentEvidence: {
          bodyVerified: true,
          openingStatus: "expired",
          applicationStatus: "invalid",
        },
        platformEvidence: {
          opening: {
            status: "verified",
            value: "recruiting",
            checkedAt: "2026-10-01T00:00:00Z",
          },
          entry: { kind: "communication", status: "verified" },
        },
      }}
    />,
  );
  assert.ok(view.getByText("已过期"));
  assert.ok(view.getByText("入口失效"));
  assert.ok(view.getByText(/平台观察：待复核/));
  assert.ok(view.getByText(/沟通入口.*不构成投递证据/));
});
test("communication-only job keeps application unverified even with a current platform status", (t) => {
  t.after(cleanup);
  const view = render(
    <RecruitmentEvidence
      row={{
        jobId: "synthetic",
        recruitmentEvidence: {
          bodyVerified: true,
          openingStatus: "unknown",
          applicationStatus: "unknown",
        },
        platformEvidence: {
          opening: {
            status: "verified",
            value: "recruiting",
            checkedAt: new Date().toISOString(),
          },
          entry: { kind: "communication", status: "verified" },
        },
      }}
    />,
  );
  assert.ok(view.getByText("投递入口待核验"));
  assert.ok(view.getByText(/平台观察：在招/));
  assert.ok(view.getByText(/沟通入口.*不构成投递证据/));
});
test("review: source changes can replan the same activity with preserved cost", async (t) => {
  const changed = {
    ...root,
    collectionProgress: { ...root.collectionProgress, replanRequired: true },
  };
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [changed] }
        : p === "/collections/activity-A"
          ? changed
          : p.endsWith("/resume")
            ? new Promise(() => {})
            : syntheticApi(p, o),
  });
  await f.screen.findByText(/活动累计费用上界 ¥3.20/);
  await f.user.click(
    f.screen.getByRole("button", { name: "确认重新规划并继续" }),
  );
  const call = f.apiCalls.find((c) => c.path.endsWith("/resume"));
  assert.equal(call?.options.body?.replan, true);
  assert.equal(call?.path, "/collections/activity-A/resume");
});
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
