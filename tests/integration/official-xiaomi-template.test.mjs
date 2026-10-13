import test from "node:test";
import assert from "node:assert/strict";
import official from "../../src/sources/adapters/official-announcements.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";
const origin = "https://hr.xiaomi.com",
  endpoint = origin + "/website/cli/api/hrportal/domestic/campusNews/list";
const site = {
  siteId: "xiaomi",
  providerId: "official-announcements",
  name: "小米",
  origin: origin + "/website/campus.html",
  allowedDomains: ["hr.xiaomi.com"],
  status: "candidate",
  verifiedAt: null,
  template: {
    nativePortal: "xiaomi-public-notices-1",
    recordKind: "recruitment_notice",
    listUrl: endpoint,
  },
};
// Synthetic controls matching the observed public configuration schema.
const row = (id = 13, extra = {}) => ({
  id,
  title: "合成企业2027届校园招聘计划",
  tag: "投递须知",
  status: 1,
  isDel: false,
  body: "<h2>一、招聘对象</h2><p>2027届消防工程等相关专业应届毕业生，以下内容为合成边界测试，不能作为实际招聘事实。</p><h2>二、岗位范围</h2><p>消防设备记录与应急演练资料整理。本公告包含多个岗位类别，具体职责与条件需要到每个岗位另行核对。本测试保留整份公告，不将它拆分为虚构岗位，也不能将它标记为明确仍在招或可直接申请。</p>",
  createTime: "2026-10-01 12:30:00",
  updateTime: "2026-10-14 01:00:00",
  ...extra,
});
function replay({
  rows = [row()],
  body = null,
  status = 200,
  url = null,
} = {}) {
  const calls = [],
    context = {
      sites: [structuredClone(site)],
      signal: new AbortController().signal,
      clock: { now: () => Date.parse("2026-10-14T01:00:00Z") },
      request: async (requestUrl, options = {}) => {
        calls.push({ url: requestUrl, options });
        return {
          status,
          url: url || requestUrl,
          text:
            body ||
            JSON.stringify({
              code: 200,
              success: true,
              error: null,
              data: rows,
              paging: "",
            }),
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
test("Xiaomi public news keep full owned notices and separate hash IDs without becoming individual jobs", async () => {
  const f = replay({
      rows: [row(), row(2, { title: "合成企业新零售招聘计划" })],
    }),
    p = await f.collect();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, endpoint);
  assert.equal(f.calls[0].options.method, undefined);
  assert.equal(f.calls[0].options.headers?.cookie, undefined);
  assert.equal(p.records.length, 2);
  assert.notEqual(p.records[0].url, p.records[1].url);
  assert.equal(p.records[0].url, origin + "/website/campus-notice.html#id=13");
  assert.ok(
    p.records.every(
      (r) => r.kind === "recruitment_notice" && r.bodyStatus === "complete",
    ),
  );
  assert.equal(p.coverageScope, "limited");
  assert.equal(p.truncationReason, "listing_only");
  const r = p.records[0],
    e = prepareRecruitmentRecord(r, f.context.clock.now()).recruitmentEvidence;
  assert.equal(e.bodyVerified, true);
  assert.equal(e.openingStatus, "unknown");
  assert.equal(e.applicationStatus, "unknown");
  assert.equal(r.publishedAt, null);
  assert.equal(r.deadlineAt, null);
  assert.equal(r.applyUrl, null);
  assert.ok(!JSON.stringify(p).includes("createTime"));
  assert.ok(!JSON.stringify(p).includes("updateTime"));
});
test("FAQs and deleted or unpublished entries are excluded rather than accepted as vacancies", async () => {
  const f = replay({
    rows: [
      row(),
      row(6, { title: "FAQ 常见问题", tag: "FAQ" }),
      row(7, { isDel: true }),
      row(8, { status: 0 }),
    ],
  });
  assert.equal((await f.collect()).records.length, 1);
});
test("native public config shape, identity and access gates are required", async () => {
  for (const rows of [[row(), row()], [row(-1)], [row(1, { body: 42 })]])
    await assert.rejects(replay({ rows }).collect(), { code: "parse_error" });
  for (const body of [
    JSON.stringify({
      success: true,
      code: 200,
      data: [row()],
      paging: { page: 1 },
    }),
    JSON.stringify({ success: false, code: 200, data: [row()], paging: "" }),
  ])
    await assert.rejects(replay({ body }).collect(), { code: "parse_error" });
  await assert.rejects(replay({ status: 412 }).collect(), {
    code: "restricted",
  });
  await assert.rejects(replay({ body: "<p>请先完成人机验证</p>" }).collect(), {
    code: "captcha",
  });
  await assert.rejects(
    replay({ url: "https://other.example.org/config" }).collect(),
    { code: "detail_identity_mismatch" },
  );
  const f = replay();
  f.context.sites[0].name = "其他公司";
  await assert.rejects(f.collect(), { code: "template_not_configured" });
  assert.equal(f.calls.length, 0);
});
test("a notice detail refresh verifies its own ID/title and removes stale application evidence", async () => {
  const f = replay(),
    r = (await f.collect()).records[0];
  r.applicationVerification = { status: "available" };
  const d = await official.fetchDetail(r, f.context);
  assert.equal(d.applicationVerification, undefined);
  assert.equal(d.bodyStatus, "complete");
  const count = f.calls.length;
  await assert.rejects(
    official.fetchDetail(
      { ...r, url: origin + "/website/campus-notice.html#id=2" },
      f.context,
    ),
    { code: "detail_identity_mismatch" },
  );
  assert.equal(f.calls.length, count);
  const changed = replay({ rows: [row(13, { title: "其他招聘计划" })] });
  await assert.rejects(official.fetchDetail(r, changed.context), {
    code: "detail_identity_mismatch",
  });
  const hidden = replay({
    rows: [row(13, { body: "<div hidden>" + row().body + "</div>" })],
  });
  assert.equal((await hidden.collect()).records[0].bodyStatus, "incomplete");
});
test("a second page cannot claim deeper vacancy coverage for the observed unpaged notice config", async () => {
  const f = replay(),
    p = await f.collect({ page: 2 });
  assert.deepEqual(p.records, []);
  assert.equal(p.hasMore, false);
  assert.equal(p.coverageScope, "limited");
  assert.equal(f.calls.length, 0);
});
