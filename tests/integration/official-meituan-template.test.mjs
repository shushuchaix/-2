import test from "node:test";
import assert from "node:assert/strict";
import official from "../../src/sources/adapters/official-announcements.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";

const origin = "https://zhaopin.meituan.com",
  endpoint = origin + "/api/official/job/getJobList";
const site = {
  siteId: "meituan",
  providerId: "official-announcements",
  name: "美团",
  origin,
  allowedDomains: ["zhaopin.meituan.com"],
  status: "candidate",
  verifiedAt: null,
  template: { nativePortal: "meituan-public-career-1", listUrl: endpoint },
};
const now = Date.parse("2026-10-13T05:00:00Z");
const row = (extra = {}) => ({
  jobUnionId: "synthetic-role-1",
  name: "合成消防安全岗",
  jobType: "1",
  jobStatus: "000",
  cityList: [{ name: "合成市" }],
  jobDuty: "负责合成消防设施记录与应急演练资料整理，此句不代表真实职责。",
  jobRequirement:
    "本科消防工程专业，工作经验不限，负责认真核对记录，此句不代表实际条件。",
  firstPostTime: null,
  refreshTime: now,
  expiredTime: null,
  ...extra,
});
function replay({
  data = null,
  status = 200,
  text = null,
  detail = null,
  cursor = null,
  page = 1,
} = {}) {
  const calls = [],
    body = data || {
      status: 1,
      data: {
        list: [row()],
        page: { pageNo: page, pageSize: 10, totalPage: 1, totalCount: 1 },
      },
    };
  const context = {
    cursor,
    clock: { now: () => now },
    signal: new AbortController().signal,
    sites: [site],
    request: async (url, options) => {
      calls.push({ url, options });
      return {
        status,
        url,
        text:
          text ??
          JSON.stringify(
            url === endpoint ? body : { status: 1, data: detail || row() },
          ),
        headers: {},
      };
    },
  };
  return {
    calls,
    context,
    collect: () =>
      official.collectPage({
        site: structuredClone(site),
        query: { keyword: "消防" },
        cursor,
        context,
      }),
  };
}
test("Meituan uses the observed public list POST and retains separate own body facts", async () => {
  const f = replay(),
    p = await f.collect(),
    r = p.records[0];
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, endpoint);
  assert.equal(f.calls[0].options.method, "POST");
  const sent = JSON.parse(f.calls[0].options.body);
  assert.deepEqual(sent.page, { pageNo: 1, pageSize: 10 });
  assert.equal(sent.keywords, "消防");
  assert.equal(sent.jobShareType, "1");
  assert.deepEqual(
    Object.keys(sent).sort(),
    [
      "page",
      "jobShareType",
      "keywords",
      "cityList",
      "department",
      "jfJgList",
      "jobType",
      "typeCode",
      "specialCode",
      "u_query_id",
      "r_query_id",
    ].sort(),
  );
  assert.equal(r.sourceRecordId, "synthetic-role-1");
  assert.equal(r.kind, "job");
  assert.equal(r.jobType, "campus");
  assert.equal(r.bodyIncomplete, false);
  assert.ok(r.description.includes("岗位职责"));
  assert.ok(r.description.includes("任职要求"));
  assert.equal(r.publishedAt, null);
  const prepared = prepareRecruitmentRecord(r, now);
  assert.equal(prepared.recruitmentEvidence.bodyVerified, true);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(p.hasMore, false);
  assert.equal(site.verifiedAt, null);
});
for (const [name, change] of [
  ["missing duties", { jobDuty: "" }],
  [
    "hidden requirements",
    { jobRequirement: "<div hidden>必须具备合成证书及本科学历。</div>" },
  ],
  [
    "summary without role body",
    { jobDuty: "", jobRequirement: "", desc: "招聘摘要不能成为逐岗完整正文。" },
  ],
])
  test(`Meituan ${name} stays incomplete`, async () => {
    const f = replay({
      data: {
        status: 1,
        data: {
          list: [row(change)],
          page: { pageNo: 1, pageSize: 10, totalPage: 1, totalCount: 1 },
        },
      },
    });
    const r = (await f.collect()).records[0];
    assert.equal(r.bodyIncomplete, true);
    assert.equal(
      prepareRecruitmentRecord(r, now).recruitmentEvidence.bodyVerified,
      false,
    );
  });
for (const [name, status, text, code] of [
  ["login", 401, "{}", "restricted"],
  [
    "challenge",
    200,
    "<html><head><title>安全验证</title></head><body><p>请完成人机验证</p></body></html>",
    "captcha",
  ],
  ["HTML shell", 200, "<html>校园招聘</html>", "parse_error"],
  ["native error", 200, '{"status":0,"message":"synthetic"}', "parse_error"],
])
  test(`Meituan ${name} returns a typed failure`, async () => {
    await assert.rejects(replay({ status, text }).collect(), { code });
  });
test("Meituan malformed native identity and duplicate rows fail closed", async () => {
  for (const list of [
    [row({ jobUnionId: "unsafe/id" })],
    [row(), row()],
    [row({ name: "" })],
  ])
    await assert.rejects(
      replay({
        data: {
          status: 1,
          data: {
            list,
            page: {
              pageNo: 1,
              pageSize: 10,
              totalPage: 1,
              totalCount: list.length,
            },
          },
        },
      }).collect(),
      { code: "parse_error" },
    );
});
test("Meituan exact site and native endpoint gates run before any request", async () => {
  for (const bad of [
    { siteId: "other" },
    { origin: "https://other.example.org" },
    {
      template: {
        nativePortal: "meituan-public-career-1",
        listUrl: origin + "/api/private/resume/get",
      },
    },
  ]) {
    const f = replay();
    await assert.rejects(
      official.collectPage({
        site: { ...site, ...bad },
        query: { keyword: "消防" },
        page: 1,
        context: f.context,
      }),
      { code: "template_not_configured" },
    );
    assert.equal(f.calls.length, 0);
  }
});
test("Meituan native detail binds the same ID, title and URL and never checks private apply APIs", async () => {
  const f = replay(),
    r = (await f.collect()).records[0],
    detail = await official.fetchDetail(r, f.context);
  assert.equal(f.calls[1].url, origin + "/api/official/job/getJobDetail");
  assert.deepEqual(JSON.parse(f.calls[1].options.body), {
    jobUnionId: r.sourceRecordId,
    jobShareType: "1",
  });
  assert.equal(detail.sourceRecordId, r.sourceRecordId);
  assert.equal(detail.applicationVerification, undefined);
  const bad = replay({ detail: row({ jobUnionId: "other-role" }) });
  await assert.rejects(official.fetchDetail(r, bad.context), {
    code: "detail_identity_mismatch",
  });
});
test("Meituan resumed pages bind query, site and native cursor and reject repeated rows", async () => {
  const list = Array.from({ length: 10 }, (_, i) =>
    row({ jobUnionId: "synthetic-" + i }),
  );
  const first = replay({
      data: {
        status: 1,
        data: {
          list,
          page: { pageNo: 1, pageSize: 10, totalPage: 2, totalCount: 20 },
        },
      },
    }),
    p = await first.collect();
  assert.equal(p.hasMore, true);
  assert.equal(p.nextCursor.page, 2);
  const next = replay({
    cursor: p.nextCursor,
    data: {
      status: 1,
      data: {
        list: list.map((r) => ({ ...r, jobUnionId: r.jobUnionId + "-next" })),
        page: { pageNo: 2, pageSize: 10, totalPage: 2, totalCount: 20 },
      },
    },
  });
  assert.equal((await next.collect()).records.length, 10);
  assert.equal(JSON.parse(next.calls[0].options.body).page.pageNo, 2);
  const repeated = replay({
    cursor: p.nextCursor,
    data: {
      status: 1,
      data: {
        list,
        page: { pageNo: 2, pageSize: 10, totalPage: 2, totalCount: 20 },
      },
    },
  });
  await assert.rejects(repeated.collect(), { code: "pagination_cycle" });
  for (const changed of [
    { ...p.nextCursor, meituan: { ...p.nextCursor.meituan, siteId: "other" } },
    {
      ...p.nextCursor,
      meituan: { ...p.nextCursor.meituan, queryHash: "a".repeat(64) },
    },
  ]) {
    const f = replay({ cursor: changed });
    await assert.rejects(f.collect(), { code: "collection_cursor_invalid" });
    assert.equal(f.calls.length, 0);
  }
});
test("Meituan native offline status and refreshTime cannot fabricate an open job or publication date", async () => {
  const f = replay({
      data: {
        status: 1,
        data: {
          list: [row({ jobStatus: "001" })],
          page: { pageNo: 1, pageSize: 10, totalPage: 1, totalCount: 1 },
        },
      },
    }),
    r = (await f.collect()).records[0];
  assert.equal(
    prepareRecruitmentRecord(r, now).recruitmentEvidence.openingStatus,
    "closed",
  );
  assert.equal(r.publishedAt, null);
});
