import test from "node:test";
import assert from "node:assert/strict";
import official from "../../src/sources/adapters/official-announcements.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";
const origin = "https://talent.alibaba.com",
  endpoint = origin + "/position/search";
const nonce = "00000000-0000-0000-0000-000000000000";
const site = {
  siteId: "alibaba",
  providerId: "official-announcements",
  name: "阿里巴巴",
  origin: origin + "/",
  allowedDomains: ["talent.alibaba.com"],
  status: "candidate",
  verifiedAt: null,
  template: { nativePortal: "alibaba-public-career-1", listUrl: endpoint },
};
const html = () =>
  `<title>阿里巴巴集团招聘官网</title><script src="https://g.alicdn.com/platform/new-careers-portal/2.0.4/vendors.min.js"></script><script src="https://g.alicdn.com/platform/new-careers-portal/2.0.4/alibaba-group.min.js"></script><script>window.__userconfig={locale:"zh"};window.__sysconfig={environment:"online",__token__:"${nonce}",circle:{circleAliasName:"阿里巴巴集团",portalOfficialChannel:"group_official_site",portalDomain:"${origin}"}};</script>`;
// The response schema was observed live. Every job row and body here is synthetic.
const row = (id = 1001, extra = {}) => ({
  id,
  name: "合成消防安全工程师" + id,
  positionUrl:
    "/off-campus/position-detail?positionId=" +
    id +
    "&track_id=synthetic-tracking",
  description:
    "负责合成设施的消防检查、演练记录和整改追踪，此处仅用于验证本岗位正文的归属。",
  requirement:
    "本科消防工程专业，三年以上消防工作经验，持有一级注册消防工程师，此处为合成控制。",
  workLocations: ["合成市"],
  publishTime: Date.parse("2026-10-13T00:00:00Z"),
  status: null,
  ...extra,
});
function replay({
  rows = [row()],
  total = rows.length,
  pageHtml = html(),
  override = null,
  target = null,
} = {}) {
  const calls = [];
  const context = {
    sites: [structuredClone(site)],
    signal: new AbortController().signal,
    clock: { now: () => Date.parse("2026-10-14T01:00:00Z") },
    targetSnapshot: target || { jobTypes: ["social"] },
    request: async (url, options = {}) => {
      calls.push({ url, options });
      if (override) return override(url, options);
      if (url === origin + "/")
        return {
          status: 200,
          url,
          text: pageHtml,
          headers: {
            "set-cookie": `XSRF-TOKEN=${nonce}; Path=/; HttpOnly, SESSION=synthetic-anonymous-session; Path=/; HttpOnly`,
          },
        };
      const input = JSON.parse(options.body),
        page = input.pageIndex;
      return {
        status: 200,
        url,
        text: JSON.stringify({
          success: true,
          errorMsg: null,
          errorCode: null,
          content: {
            datas: typeof rows === "function" ? rows(page) : rows,
            totalCount: total,
            currentPage: page,
            pageSize: 10,
          },
        }),
        headers: {},
      };
    },
  };
  return {
    context,
    calls,
    collect: (cursor = null) =>
      official.collectPage({
        site: context.sites[0],
        query: { keyword: "消防" },
        cursor,
        context,
      }),
  };
}
test("Alibaba native list keeps complete own bodies without leaking anonymous material or tracking identifiers", async () => {
  const f = replay(),
    p = await f.collect(),
    r = p.records[0];
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, origin + "/");
  assert.equal(f.calls[0].options.headers?.cookie, undefined);
  assert.equal(new URL(f.calls[1].url).pathname, "/position/search");
  assert.deepEqual(JSON.parse(f.calls[1].options.body), {
    batchId: "",
    corpCode: "",
    pageIndex: 1,
    pageSize: 10,
    key: "消防",
    channel: "group_official_site",
    language: "zh_CN",
  });
  assert.equal(r.url, origin + "/off-campus/position-detail?positionId=1001");
  assert.equal(r.sourceRecordId, "1001");
  assert.equal(r.bodyStatus, "complete");
  assert.ok(r.description.includes("任职要求"));
  assert.equal(
    r.sourceEvidence.find((e) => e.field === "description").appliesTo.jobRowId,
    "1001",
  );
  assert.ok(!JSON.stringify(p).includes(nonce));
  assert.ok(!JSON.stringify(p).includes("synthetic-anonymous-session"));
  assert.ok(!JSON.stringify(p).includes("synthetic-tracking"));
  const e = prepareRecruitmentRecord(
    r,
    f.context.clock.now(),
  ).recruitmentEvidence;
  assert.equal(e.bodyVerified, true);
  assert.equal(e.openingStatus, "unknown");
  assert.equal(e.applicationStatus, "unknown");
  assert.equal(r.deadlineAt, null);
  assert.equal(r.applyUrl, null);
});
test("Alibaba portal identity and top-level page metadata must be established before the native POST", async () => {
  for (const pageHtml of [
    html().replace("阿里巴巴集团招聘官网", "其他企业"),
    html().replace("group_official_site", "foreign-channel"),
    html().replace(`__token__:"${nonce}"`, "__token__:getSecret()"),
    html() + `<script>window.__sysconfig={};</script>`,
    html().replace(
      "window.__sysconfig=",
      "function dormant(){window.__sysconfig=",
    ) + "}",
  ]) {
    const f = replay({ pageHtml });
    await assert.rejects(f.collect(), {
      code: "native_transport_contract_mismatch",
    });
    assert.equal(f.calls.length, 1);
  }
  const f = replay();
  f.context.sites[0].siteId = "other";
  await assert.rejects(f.collect(), { code: "template_not_configured" });
  assert.equal(f.calls.length, 0);
});
test("native identity, pagination, hidden bodies and explicit access gates cannot fabricate jobs", async () => {
  for (const rows of [
    [
      row(1001, {
        positionUrl: "/off-campus/position-detail?positionId=other",
      }),
    ],
    [row(1001, { positionUrl: "https://other.example.org/role" })],
    [row(), row()],
    [row(1001, { id: NaN })],
  ])
    await assert.rejects(replay({ rows }).collect(), { code: "parse_error" });
  await assert.rejects(replay({ rows: [row()], total: 11 }).collect(), {
    code: "parse_error",
  });
  const hidden = replay({
    rows: [
      row(1001, {
        requirement:
          "<p hidden>本科消防工程专业，此句不应被用于证明任职条件完整。</p>",
      }),
    ],
  });
  assert.equal((await hidden.collect()).records[0].bodyStatus, "incomplete");
  for (const [status, text, code] of [
    [412, "limited", "restricted"],
    [
      200,
      JSON.stringify({ success: false, errorCode: "LOGIN_EXPIRED" }),
      "login_required",
    ],
    [200, "<p>请先完成人机验证</p>", "captcha"],
  ]) {
    const normal = replay();
    const native = normal.context.request;
    normal.context.request = async (url, opt) =>
      url === origin + "/"
        ? native(url, opt)
        : { status, url, text, headers: {} };
    await assert.rejects(normal.collect(), { code });
  }
});
test("native cursor binds the query and page, finishes a partial last page, and rejects repeated rows", async () => {
  const f = replay({
    rows: (page) =>
      page === 1
        ? Array.from({ length: 10 }, (_, i) => row(1001 + i))
        : [row(1011)],
    total: 11,
  });
  const first = await f.collect(),
    next = await f.collect(first.nextCursor);
  assert.equal(first.nextCursor.page, 2);
  assert.equal(next.records.length, 1);
  assert.equal(next.hasMore, false);
  const bad = {
    ...first.nextCursor,
    alibaba: { ...first.nextCursor.alibaba, queryHash: "wrong" },
  };
  const count = f.calls.length;
  await assert.rejects(f.collect(bad), { code: "collection_cursor_invalid" });
  assert.equal(f.calls.length, count);
  const repeated = replay({
    rows: () => Array.from({ length: 10 }, (_, i) => row(1001 + i)),
    total: 20,
  });
  const p = await repeated.collect();
  await assert.rejects(repeated.collect(p.nextCursor), {
    code: "pagination_cycle",
  });
});
test("a detail refresh validates the owned native row and removes stale application verification", async () => {
  const f = replay(),
    r = (await f.collect()).records[0];
  r.applicationVerification = { status: "available" };
  const d = await official.fetchDetail(r, f.context);
  assert.equal(d.bodyStatus, "complete");
  assert.equal(d.applicationVerification, undefined);
  const count = f.calls.length;
  await assert.rejects(
    official.fetchDetail(
      { ...r, url: origin + "/off-campus/position-detail?positionId=1002" },
      f.context,
    ),
    { code: "detail_identity_mismatch" },
  );
  assert.equal(f.calls.length, count);
  const changed = replay({ rows: [row(1001, { name: "其他岗位" })] });
  await assert.rejects(official.fetchDetail(r, changed.context), {
    code: "detail_identity_mismatch",
  });
});
test("the observed social contract does not claim coverage for a campus-only target", async () => {
  const f = replay({ target: { jobTypes: ["campus"] } }),
    p = await f.collect();
  assert.deepEqual(p.records, []);
  assert.equal(p.coverageScope, "limited");
  assert.equal(f.calls.length, 0);
});
