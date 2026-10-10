import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { job } from "../helpers/fixtures.mjs";
test("root announcement queue processes more than five articles across slices and never resets budget", async (t) => {
  let calls = 0;
  const articles = Array.from({ length: 12 }, (_, i) =>
    job({
      sourceRecordId: String(i),
      kind: "recruitment_notice",
      title: "单位招聘公告" + i,
      url: "https://jobs.example.com/notice/" + i,
      bodyStatus: "complete",
      intent: "employer_recruitment",
      description:
        "公司现招聘消防岗位" + i + "。消防岗位" + i + "：本科要求。".repeat(5),
    }),
  );
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({ records: articles, hasMore: false }),
  });
  const f = await collectionFixture(t, {
    providers: [provider],
    modelFactory: () => ({
      chatJson: async (_system, text) => {
        calls++;
        const title = text.match(/消防岗位\d+/)[0];
        return {
          isRecruiting: true,
          positions: [{ title, requirementsExcerpt: title }],
        };
      },
    }),
  });
  const start = await f.service.start({
      scope: f.scope,
      options: { mode: "ai" },
    }),
    ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  let root = await f.service.get(ref);
  assert.equal(calls, 10);
  assert.equal(Object.keys(root.collectionProgress.pendingArticles).length, 2);
  await f.service.resume({ ref, requestId: "remaining" });
  await f.service.wait(ref);
  root = await f.service.get(ref);
  assert.equal(calls, 12);
  assert.equal(root.collectionProgress.status, "completed");
  assert.equal(Object.keys(root.collectionProgress.articleCache).length, 12);
  assert.equal((await f.ledger.snapshot(ref)).maxCostCny, 10);
});
test("completed list leaves failed body retryable across restart without repeating the list", async (t) => {
  let lists = 0,
    details = 0;
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => {
      lists++;
      return {
        records: [
          {
            ...job(),
            description: null,
            bodyStatus: "incomplete",
            retryEligible: true,
          },
        ],
        hasMore: false,
      };
    },
    detail: async (record) => {
      details++;
      return details === 1
        ? { ...record, bodyStatus: "challenge_required", retryEligible: true }
        : {
            ...record,
            description: "消防工程师招聘条件为本科应届生。".repeat(4),
            bodyStatus: "complete",
            retryEligible: false,
          };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  let start = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  let root = await f.service.get(ref);
  assert.equal(root.collectionProgress.status, "waiting_for_auth");
  assert.equal(Object.keys(root.collectionProgress.pendingBodies).length, 1);
  assert.equal(root.collectionProgress.units["unit-0"].seenIds.length, 0);
  await f.reopen();
  await f.service.resume({ ref, requestId: "retry-body" });
  await f.service.wait(ref);
  root = await f.service.get(ref);
  assert.equal(lists, 1);
  assert.equal(details, 2);
  assert.equal(
    root.collectionProgress.lastErrorCode,
    undefined,
    JSON.stringify(root.collectionProgress),
  );
  assert.equal(
    Object.keys(root.collectionProgress.pendingBodies).length,
    0,
    JSON.stringify(root.collectionProgress.pendingBodies),
  );
  assert.equal(root.collectionProgress.status, "completed");
  assert.equal((await f.ledger.snapshot(ref)).maxCostCny, 10);
});
