import test from "node:test";
import assert from "node:assert/strict";
import official from "../../src/sources/adapters/official-announcements.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";

const tenant = "60b79f9bbef57c1189691f8b";
const origin = "https://wecruit.hotjob.cn";
const params = "?iSaJAx=isAjax&request_locale=zh_CN";
const endpoint =
  origin + "/wecruit/positionInfo/listPosition/SU" + tenant + params;
const configUrl = origin + "/wecruit/suite/config/SU" + tenant + params;
const detailUrl =
  origin + "/wecruit/positionInfo/listPositionDetail/SU" + tenant + params;
const site = {
  siteId: "official-5cf1fdcffbefdbb8",
  providerId: "official-announcements",
  name: "深圳市机场（集团）有限公司",
  origin: "https://szairport.hotjob.cn",
  allowedDomains: ["szairport.hotjob.cn", "wecruit.hotjob.cn"],
  status: "candidate",
  verifiedAt: null,
  template: {
    nativePortal: "shenzhen-airport-wecruit-1",
    tenantKey: tenant,
    listUrl: endpoint,
  },
};
const nativeConfig = () => ({
  companyName: site.name,
  suiteKey: tenant,
  templateNum: "pb",
  config: {
    campus: {
      jobList: { jobListData: { listType: "row", searchType: "postName" } },
    },
    society: {
      jobList: { jobListData: { listType: "row", searchType: "postName" } },
    },
  },
});
const empty = () => ({
  positonNum: 0,
  pageForm: {
    totalPage: 0,
    pageSize: 0,
    currentPage: 0,
    dataCount: 0,
    pageData: [],
  },
});
// All positive job rows are synthetic controls. The current live tenant was
// verified as empty, so these tests do not claim measured positive body quality.
const row = (extra = {}) => ({
  postId: "synthetic-role",
  postName: "合成消防安全岗位",
  currentSuiteKey: tenant,
  orgName: site.name,
  ...extra,
});
const listing = (rows, page = 1, total = rows.length) => ({
  positonNum: total,
  pageForm: {
    totalPage: Math.ceil(total / 15),
    pageSize: 15,
    currentPage: page,
    dataCount: total,
    pageData: rows,
  },
});
function replay({
  config = nativeConfig(),
  lists = null,
  detail = null,
  override = null,
  target = null,
} = {}) {
  const calls = [];
  const context = {
    sites: [structuredClone(site)],
    targetSnapshot: target || { jobTypes: ["campus", "social"] },
    clock: { now: () => Date.parse("2026-10-14T01:00:00Z") },
    signal: new AbortController().signal,
    request: async (url, options = {}) => {
      calls.push({ url, options });
      if (override) return override(url, options);
      const form = new URLSearchParams(options.body);
      const data =
        url === configUrl
          ? config
          : url === detailUrl
            ? detail
            : lists
              ? lists(
                  Number(form.get("recruitType")),
                  Number(form.get("currentPage")),
                )
              : empty();
      return {
        status: 200,
        url,
        text: JSON.stringify({ state: "200", data }),
        headers: {},
      };
    },
  };
  return {
    calls,
    context,
    collect: (cursor = null) =>
      official.collectPage({
        site: context.sites[0],
        query: { keyword: "消防" },
        cursor,
        context,
      }),
  };
}
test("Shenzhen airport native empty responses are valid empty coverage, not missing templates", async () => {
  const f = replay(),
    p = await f.collect();
  assert.deepEqual(p.records, []);
  assert.equal(p.hasMore, false);
  assert.equal(p.nextCursor, null);
  assert.equal(p.coverageScope, "query");
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].url, configUrl);
  assert.deepEqual(
    f.calls
      .slice(1)
      .map((c) => Object.fromEntries(new URLSearchParams(c.options.body))),
    [1, 2].map((type) => ({
      isFrompb: "true",
      recruitType: String(type),
      pageSize: "15",
      currentPage: "1",
      postName: "消防",
    })),
  );
  assert.ok(
    f.calls.every(
      (c) =>
        !Object.keys(c.options.headers || {}).some((k) =>
          /cookie|auth|token/i.test(k),
        ),
    ),
  );
  assert.equal(site.verifiedAt, null);
});
test("an unrelated company or changed native config cannot supply this airport's jobs", async () => {
  for (const config of [
    { ...nativeConfig(), companyName: "其他机构" },
    { ...nativeConfig(), suiteKey: "other" },
    { ...nativeConfig(), templateNum: "mc" },
    { ...nativeConfig(), config: {} },
  ]) {
    const f = replay({ config });
    await assert.rejects(f.collect(), { code: "detail_identity_mismatch" });
    assert.equal(f.calls.length, 1);
  }
});
test("airport template and cursor scope are checked before requests", async () => {
  for (const extra of [
    { siteId: "other" },
    { origin: "https://other.example.org" },
    { template: { ...site.template, tenantKey: "other" } },
    { allowedDomains: ["szairport.hotjob.cn"] },
  ]) {
    const f = replay();
    Object.assign(f.context.sites[0], extra);
    await assert.rejects(f.collect(), { code: "template_not_configured" });
    assert.equal(f.calls.length, 0);
  }
  for (const cursor of [
    { page: 2 },
    {
      page: 2,
      shenzhenAirport: {
        siteId: site.siteId,
        tenantKey: tenant,
        queryHash: "wrong",
        seenPages: [],
      },
    },
  ]) {
    const f = replay();
    await assert.rejects(f.collect(cursor), {
      code: "collection_cursor_invalid",
    });
    assert.equal(f.calls.length, 0);
  }
});
test("native list facts stay incomplete until the matching job detail is read", async () => {
  const f = replay({
    target: { jobTypes: ["campus"] },
    lists: () => listing([row()]),
    detail: {
      ...row(),
      workContent: "负责合成消防安全设备记录、应急演练和消防设施检查。",
      serviceCondition: "本科消防工程专业，工作经验不限，此处为合成边界测试。",
    },
  });
  const record = (await f.collect()).records[0];
  assert.equal(record.bodyStatus, "incomplete");
  assert.equal(record.applyUrl, null);
  const detail = await official.fetchDetail(record, f.context);
  assert.equal(f.calls.at(-1).url, detailUrl);
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(f.calls.at(-1).options.body)),
    { postId: "synthetic-role" },
  );
  assert.equal(detail.bodyStatus, "complete");
  assert.ok(detail.description.includes("任职要求"));
  const evidence = prepareRecruitmentRecord(
    detail,
    f.context.clock.now(),
  ).recruitmentEvidence;
  assert.equal(evidence.bodyVerified, true);
  assert.equal(evidence.openingStatus, "unknown");
  assert.equal(evidence.applicationStatus, "unknown");
  assert.equal(detail.publishedAt, null);
  assert.equal(detail.deadlineAt, null);
});
test("foreign-tenant list rows and inconsistent native page totals fail closed", async () => {
  for (const data of [
    listing([row({ currentSuiteKey: "other" })]),
    listing([row(), row()]),
    { ...empty(), positonNum: 1 },
    listing([row()], 2),
  ]) {
    const f = replay({ lists: () => data });
    await assert.rejects(f.collect(), { code: "parse_error" });
  }
});
test("a resumed native page cannot replay the same rows", async () => {
  const f = replay({
    target: { jobTypes: ["campus"] },
    lists: (_type, page) =>
      listing(
        Array.from({ length: 15 }, (_, i) => row({ postId: "synthetic-" + i })),
        page,
        30,
      ),
  });
  const first = await f.collect();
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor.page, 2);
  await assert.rejects(f.collect(first.nextCursor), {
    code: "pagination_cycle",
  });
});
test("continuation reads only the recruitment stream that still has native pages", async () => {
  const f = replay({
    lists: (type, page) => {
      if (type === 1) {
        assert.equal(page, 1, "finished campus stream was requested again");
        return listing([row({ postId: "campus-only" })]);
      }
      return listing(
        Array.from({ length: 15 }, (_, i) =>
          row({ postId: "social-" + page + "-" + i }),
        ),
        page,
        30,
      );
    },
  });
  const first = await f.collect();
  const next = await f.collect(first.nextCursor);
  assert.equal(next.records.length, 15);
  assert.equal(next.hasMore, false);
});
test("detail identity, body completeness and challenge gates prevent incorrect job upgrades", async () => {
  for (const detail of [
    row({
      postId: "other",
      workContent: "合成职责足够长但属于其他岗位记录。",
      serviceCondition: "合成条件足够长但属于其他岗位记录。",
    }),
    row({ postName: "其他岗位" }),
  ]) {
    const f = replay({
      target: { jobTypes: ["campus"] },
      lists: () => listing([row()]),
      detail,
    });
    await assert.rejects(
      official.fetchDetail((await f.collect()).records[0], f.context),
      { code: "detail_identity_mismatch" },
    );
  }
  const f = replay({
    target: { jobTypes: ["campus"] },
    lists: () => listing([row()]),
    detail: {
      ...row(),
      workContent: "负责合成消防设施检查、应急演练和记录整理。",
      serviceCondition:
        "<div hidden>本科消防工程学历要求，此处为合成控制。</div>",
    },
  });
  assert.equal(
    (await official.fetchDetail((await f.collect()).records[0], f.context))
      .bodyStatus,
    "incomplete",
  );
  const challenge = replay({
    override: () => ({
      status: 200,
      text: "<html><body><p>请先完成人机验证。</p></body></html>",
    }),
  });
  await assert.rejects(challenge.collect(), { code: "captcha" });
});
