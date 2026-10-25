import test from "node:test";
import assert from "node:assert/strict";
import official from "../../src/sources/adapters/official-announcements.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";
import { buildAlibabaPublicSearchRequest } from "../../src/sources/adapters/alibaba-public-read.mjs";
import { safeSourceIssues, safeSourceContractMetadata } from "../../src/sources/source-status.mjs";
import { cleanMetadata } from "../../src/infrastructure/diagnostics/fields.mjs";
import { diagnosticError } from "../../src/infrastructure/diagnostics/log.mjs";
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

const requestId = "q-12345678-1234-4234-8234-123456789abc";
function publicPage(fields = {}) {
  return { status: 200, url: origin + "/", text: html(), requestId,
    headers: { "set-cookie": `XSRF-TOKEN=${nonce}; Path=/, SESSION=synthetic-anonymous-session; Path=/` }, ...fields };
}
function build(response, fields = {}) {
  return buildAlibabaPublicSearchRequest({ siteId: "alibaba", query: "消防", page: 1, response, ...fields });
}
test("Alibaba data script MIME types do not become executable configuration", async () => {
  const f = replay({ pageHtml: html() + '<script type="application/ld+json">{"@context":"synthetic","@type":"JobPosting"}</script>' +
    '<script type="application/json">{"window.__sysconfig":{"ignored":true}}</script>' +
    '<script type="importmap">{"imports":{}}</script>' });
  assert.equal((await f.collect()).records.length, 1);
  assert.equal(f.calls.length, 2);
  const onlyDataConfig = html().replace('<script>window.__userconfig=', '<script type="application/json">window.__userconfig=');
  assert.throws(() => build(publicPage({ text: onlyDataConfig })), { code: "native_transport_contract_mismatch", contractStage: "config_shape" });
});

for (const [name, fields, stage, reason] of [
  ["status", { status: 500 }, "response_identity", "unexpected_status"],
  ["url", { url: "https://foreign.example.org/" }, "response_identity", "unexpected_url"],
  ["body type", { text: null }, "response_size", "invalid_body"],
  ["body bound", { text: "x".repeat(1048577) }, "response_size", "body_too_large"],
  ["title", { text: html().replace("阿里巴巴集团招聘官网", "其他企业") }, "portal_identity", "title_mismatch"],
  ["asset pin", { text: html().replaceAll("2.0.4", "2.0.5") }, "asset_identity", "asset_missing_or_duplicate"],
  ["JavaScript syntax", { text: html() + "<script>const broken = ;</script>" }, "inline_parse", "javascript_syntax_invalid"],
  ["duplicate config", { text: html() + "<script>window.__sysconfig={};</script>" }, "config_shape", "config_duplicate_or_dynamic"],
  ["missing property", { text: html().replace('locale:"zh"', 'other:"zh"') }, "config_shape", "property_missing_or_duplicate"],
  ["dynamic token", { text: html().replace(`__token__:"${nonce}"`, "__token__:dynamicSecret()") }, "token_shape", "property_not_literal"],
  ["portal channel", { text: html().replace("group_official_site", "foreign-channel") }, "config_identity", "portal_config_mismatch"],
  ["token format", { text: html().replace(nonce, "synthetic-invalid-token") }, "token_shape", "token_invalid"],
  ["duplicate cookie", { headers: { "set-cookie": `XSRF-TOKEN=${nonce}, SESSION=one, SESSION=two` } }, "anonymous_cookie", "cookie_invalid_or_duplicate"],
  ["missing cookie", { headers: {} }, "anonymous_cookie", "cookie_missing"],
  ["token-cookie binding", { headers: { "set-cookie": "XSRF-TOKEN=11111111-1111-1111-1111-111111111111, SESSION=synthetic-session" } }, "token_cookie_mismatch", "token_cookie_mismatch"],
]) test("Alibaba bounded contract diagnostics: " + name, () => {
  assert.throws(() => build(publicPage(fields)), error => {
    assert.equal(error.code, "native_transport_contract_mismatch");
    assert.equal(error.contractStage, stage); assert.equal(error.contractReason, reason); assert.equal(error.requestId, requestId);
    const safe = safeSourceIssues([error], "official-announcements", "alibaba")[0];
    for (const value of [safe, cleanMetadata(error), diagnosticError(error)]) {
      assert.equal(value.contractStage, stage); assert.equal(value.contractReason, reason);
      assert.equal(value.requestId, requestId);
      assert.doesNotMatch(JSON.stringify(value), /synthetic-anonymous-session|dynamicSecret|synthetic-invalid-token|11111111/);
    }
    return true;
  });
});

test("Alibaba invalid input and arbitrary metadata never widen the fixed contract vocabulary", () => {
  assert.throws(() => build(publicPage(), { page: 0 }), { code: "native_transport_contract_mismatch", contractStage: "input", contractReason: "invalid_input" });
  const forged = { contractStage: "synthetic-private-token", contractReason: "synthetic-private-cookie", configurationReason: "synthetic-private-path" };
  assert.deepEqual(safeSourceContractMetadata(forged), {});
  assert.equal(cleanMetadata(forged).contractReason, undefined);
});

test("Alibaba shared collect retains the same bounded contract branch in page diagnostics and safe issues", async () => {
  const f = replay({ pageHtml: html().replaceAll("2.0.4", "2.0.5") }), events = [], directErrors = [];
  const original = f.context.request;
  f.context.request = async (...args) => ({ ...await original(...args), requestId });
  f.context.reportDiagnostic = event => events.push(cleanMetadata(event));
  f.context.reportError = error => { directErrors.push(diagnosticError(error)); };
  f.context.queries = [{ keyword: "消防", pageLimit: 1 }];
  const result = await official.collect(f.context);
  assert.equal(f.calls.length, 1);
  assert.equal(result.issues[0].contractStage, "asset_identity");
  assert.equal(safeSourceIssues(result.issues)[0].contractReason, "asset_missing_or_duplicate");
  assert.ok(events.some(event => event.contractStage === "asset_identity" && event.contractReason === "asset_missing_or_duplicate" && event.requestId === requestId));
  assert.equal(directErrors[0].contractStage, "asset_identity");
  assert.equal(directErrors[0].contractReason, "asset_missing_or_duplicate");
  assert.doesNotMatch(JSON.stringify(directErrors), /synthetic-anonymous-session|synthetic-tracking/);
});
