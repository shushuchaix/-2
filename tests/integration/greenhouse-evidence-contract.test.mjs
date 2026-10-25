import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import greenhouse, {
  GREENHOUSE_LIST_RESPONSE_BYTES,
  greenhouseListUrl,
  isGreenhouseContentListRequest,
} from "../../src/sources/adapters/greenhouse.mjs";
import { assessRecruitmentEvidence, isVerifiedRecommendation } from "../../src/domain/recruitment-evidence.mjs";
import { createRequestClient, socketTransport } from "../../src/infrastructure/http/client.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";
import { createActivityBudgets } from "../../src/application/collection-ledger.mjs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";

// Every response and candidate below is synthetic; request is never a network client.
const site = { siteId: "synthetic-board", providerId: "greenhouse", tenantId: "synthetic", name: "合成企业" };
const at = Date.parse("2026-10-21T00:00:00Z");
const api = "https://boards-api.greenhouse.io/v1/boards/synthetic/";
const hosted = (id = 1) => "https://job-boards.greenhouse.io/synthetic/jobs/" + id;
const content = "<p>本岗位负责消防巡检、应急演练和机场设施安全，要求本科消防工程专业。</p>";
const row = (overrides = {}) => ({
  id: 1, title: "设施工程师", company_name: "合成企业",
  location: { name: "合成市" }, absolute_url: hosted(), content,
  first_published: "2026-10-20T00:00:00Z", ...overrides,
});
function replay({ rows = [row()], detail = row(), responseUrl, listPayload, listText } = {}) {
  const calls = [];
  const context = {
    sites: [site], clock: { now: () => at }, signal: new AbortController().signal,
    request: async (url, options = {}) => {
      calls.push({ url, options });
      const list = url === greenhouseListUrl(site);
      return {
        status: 200, url: responseUrl || url,
        requestId: "q-00000000-0000-0000-0000-000000000001",
        text: list ? listText ?? JSON.stringify(listPayload ?? { jobs: rows, meta: { total: rows.length } })
          : JSON.stringify(detail),
      };
    },
  };
  return {
    calls, context,
    collect: (keyword = "消防") => greenhouse.collectPage({ site, query: { keyword }, context }),
  };
}

test("Greenhouse list policy is inert, bounded and exact for a configured tenant", () => {
  assert.equal(GREENHOUSE_LIST_RESPONSE_BYTES, 8388608);
  const url = greenhouseListUrl(site);
  assert.equal(url, api + "jobs?content=true");
  assert.equal(isGreenhouseContentListRequest(url, site), true);
  assert.equal(isGreenhouseContentListRequest(new URL(url), site), true);
  for (const value of [
    url + "&page=1", url + "#fragment", url.replace("content=true", "content=false"),
    url.replace("synthetic", "other"), url.replace("https:", "http:"),
    url.replace("boards-api.greenhouse.io", "boards-api.greenhouse.io.evil.example"),
    url.replace("boards-api.greenhouse.io", "user@boards-api.greenhouse.io"),
    url.replace("boards-api.greenhouse.io", "boards-api.greenhouse.io:444"),
    api + "jobs/1", {}, null,
  ]) assert.equal(isGreenhouseContentListRequest(value, site), false);
  for (const candidate of [
    {}, { ...site, tenantId: "../foreign" }, { ...site, tenantId: "bad/token" },
    { ...site, tenantId: "" }, { ...site, providerId: "other" },
  ]) {
    assert.equal(isGreenhouseContentListRequest(url, candidate), false);
    assert.throws(() => greenhouseListUrl(candidate), { code: "template_not_configured" });
  }
});

test("complete list content over 2MiB retains body-only matches and real raw counts", async () => {
  const large = "<p>" + "合成正文".repeat(190000) + "</p>",
    rows = [row(), row({ id: 2, title: "其它岗位", absolute_url: hosted(2), content: large })],
    text = JSON.stringify({ jobs: rows, meta: { total: 2 } });
  assert.ok(Buffer.byteLength(text) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(text) < GREENHOUSE_LIST_RESPONSE_BYTES);
  const f = replay({ rows, listText: text }), page = await f.collect();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.maxBytes, GREENHOUSE_LIST_RESPONSE_BYTES);
  assert.equal(new URL(f.calls[0].url).searchParams.get("content"), "true");
  assert.equal(page.raw, 2);
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].title, "设施工程师");
  assert.equal(page.records[0].bodyStatus, "complete");
  assert.equal(page.records[0].detailStatus, "complete");
  assert.equal(page.hasMore, false);
  const evidence = page.records[0].sourceEvidence.find((item) => item.field === "description");
  assert.equal(evidence.sourceUrl, greenhouseListUrl(site));
  assert.equal(evidence.location.jsonPath, "content");
  assert.equal(evidence.appliesTo.jobRowId, "1");
  assert.equal(evidence.status, "verified");
  assert.equal(assessRecruitmentEvidence({ record: page.records[0], now: at }).bodyVerified, true);
  assert.equal((await f.collect("机场")).records.length, 1);
  assert.equal(f.calls.length, 2); // No new cross-context cache is claimed.
});

for (const [name, payload] of [
  ["missing jobs", {}], ["nonarray jobs", { jobs: {} }],
  ["nonobject payload", []], ["wrong total", { jobs: [row()], meta: { total: 2 } }],
  ["bad metadata", { jobs: [row()], meta: { total: "1" } }],
  ["duplicate ID", { jobs: [row(), row()] }],
  ["fractional ID", { jobs: [row({ id: 1.5 })] }],
  ["empty title", { jobs: [row({ title: "  " })] }],
  ["missing URL", { jobs: [row({ absolute_url: null })] }],
  ["object content", { jobs: [row({ content: {} })] }],
  ["invalid location", { jobs: [row({ location: [] })] }],
]) test("invalid Greenhouse list payload: " + name, async () => {
  const f = replay({ listPayload: payload });
  await assert.rejects(f.collect(), { code: "parse_error" });
});

test("truncated JSON and typed size limits cannot turn into an empty successful list", async () => {
  await assert.rejects(replay({ listText: '{"jobs":[' }).collect(), { code: "parse_error" });
  const f = replay();
  f.context.request = async () => { throw Object.assign(Error("limit"), { code: "response_size_exceeded" }); };
  await assert.rejects(f.collect(), { code: "response_size_exceeded" });
});

for (const url of [
  "https://job-boards.greenhouse.io/foreign/jobs/1",
  "https://boards.greenhouse.io/synthetic/jobs/2",
  hosted() + "?gh_jid=2", hosted() + "?token=secret",
  hosted() + "?gh_jid=1&gh_jid=1", hosted() + "/other",
  "https://job-boards.greenhouse.io./foreign/jobs/1",
  hosted().replace("https:", "http:"),
]) test("known hosted URL ownership conflict is rejected: " + url, async () => {
  const f = replay({ rows: [row({ absolute_url: url })] });
  await assert.rejects(f.collect(), { code: "detail_identity_mismatch" });
});

test("hosted tracking is removed but never promoted to a verified application", async () => {
  const f = replay({ rows: [row({ absolute_url: hosted() + "?gh_src=public-referral&utm_source=synthetic#app" })] }),
    record = (await f.collect()).records[0];
  assert.equal(record.url, hosted());
  assert.equal(record.urlKind, "job_detail");
  assert.deepEqual(record.applicationCandidates, [hosted()]);
  assert.equal(record.applyUrl, null);
  const evidence = assessRecruitmentEvidence({ record, now: at });
  assert.equal(evidence.openingStatus, "unknown");
  assert.equal(evidence.applicationStatus, "unknown");
  assert.equal(isVerifiedRecommendation({ qualification: { status: "pass" }, evidence }), false);
});

test("custom careers URLs retain their jobs through an explicitly constructed API locator", async () => {
  const candidate = "https://careers.example.com/engineering?gh_jid=1",
    f = replay({ rows: [row({ absolute_url: candidate })], detail: row({ absolute_url: candidate }) }),
    record = (await f.collect()).records[0];
  assert.equal(record.url, api + "jobs/1");
  assert.equal(record.urlKind, "unknown");
  assert.equal(record.nativeRecruitmentBinding.locatorKind, "constructed_api");
  assert.deepEqual(record.applicationCandidates, [candidate]);
  assert.equal(record.applyUrl, null);
  assert.ok(record.sourceEvidence.every((item) => item.sourceUrl === greenhouseListUrl(site)));
  assert.equal(record.verifiedJobLocator, undefined);
  const detail = await greenhouse.fetchDetail(record, f.context);
  assert.equal(detail.url, record.url);
  assert.equal(detail.urlKind, "unknown");
  assert.ok(detail.sourceEvidence.every((item) => item.sourceUrl === api + "jobs/1"));
  assert.equal(f.calls.at(-1).url, api + "jobs/1");
  assert.equal(f.calls.at(-1).options.maxBytes, undefined);
});

test("documented custom HTTP careers URL stays an unverified candidate, not a public fetch", async () => {
  const candidate = "http://careers.example.com/?gh_jid=1", f = replay({ rows: [row({ absolute_url: candidate })] }),
    record = (await f.collect()).records[0];
  assert.equal(record.url, api + "jobs/1");
  assert.deepEqual(record.applicationCandidates, [candidate]);
  assert.equal(record.applyUrl, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, greenhouseListUrl(site));
});

test("only visible fresh body is complete; missing detail content preserves facts without renewing proof", async () => {
  const f = replay({ detail: { id: 1 } }), record = (await f.collect()).records[0];
  record.applicationVerification = { status: 200, formVerified: true, checkedAt: new Date(at).toISOString() };
  const detail = await greenhouse.fetchDetail(record, f.context);
  assert.equal(detail.description, record.description);
  assert.equal(detail.title, record.title);
  assert.equal(detail.url, record.url);
  assert.equal(detail.publishedAt, record.publishedAt);
  assert.equal(detail.bodyStatus, "incomplete");
  assert.equal(detail.detailStatus, "incomplete");
  assert.equal(detail.bodyIncomplete, true);
  assert.equal(detail.applicationVerification, undefined);
  assert.equal(detail.sourceEvidence.some((item) => item.field === "description"), false);
  assert.equal(assessRecruitmentEvidence({ record: detail, now: at }).bodyVerified, false);
  assert.equal(record.applicationVerification.formVerified, true);
  for (const value of ["", "  ", "<script>fake()</script>", '<p hidden>消防岗位条件</p>', '<div style="display:none">机场招聘</div>']) {
    const hidden = replay({ rows: [row({ title: "消防", content: value })] });
    const result = (await hidden.collect()).records[0];
    assert.equal(result.bodyStatus, "incomplete");
    assert.equal(assessRecruitmentEvidence({ record: result, now: at }).bodyVerified, false);
  }
});

test("detail request ownership is checked before I/O, and response identity is checked before merging", async () => {
  const f = replay(), record = (await f.collect()).records[0];
  for (const override of [
    { sourceId: "other" }, { identityScope: "other" }, { sourceRecordId: "2" },
    { url: "https://job-boards.greenhouse.io/other/jobs/1" }, { kind: "recruitment_notice" },
    { nativeRecruitmentBinding: { ...record.nativeRecruitmentBinding, tenantId: "other" } },
  ]) {
    const before = f.calls.length;
    await assert.rejects(greenhouse.fetchDetail({ ...record, ...override }, f.context), { code: "detail_identity_mismatch" });
    assert.equal(f.calls.length, before);
  }
  const mismatch = replay({ detail: row({ id: 2 }) });
  await assert.rejects(greenhouse.fetchDetail(record, mismatch.context), { code: "detail_identity_mismatch" });
  const changedUrl = replay({ detail: row({ absolute_url: hosted(2) }) });
  await assert.rejects(greenhouse.fetchDetail(record, changedUrl.context), { code: "detail_identity_mismatch" });
  const redirect = replay({ responseUrl: "https://other.example.com/jobs" });
  await assert.rejects(redirect.collect(), { code: "detail_identity_mismatch" });
});

test("a valid fresh detail can update supplied facts but cannot manufacture an opening or application state", async () => {
  const f = replay({ detail: row({ title: "详情设施工程师", content: "<p>新的消防职责和机场设施任职要求。</p>" }) }),
    record = (await f.collect()).records[0], detail = await greenhouse.fetchDetail(record, f.context);
  assert.equal(detail.title, "详情设施工程师");
  assert.equal(detail.bodyStatus, "complete");
  assert.equal(detail.sourceEvidence.find((item) => item.field === "description").appliesTo.jobRowId, "1");
  const evidence = assessRecruitmentEvidence({ record: detail, now: at });
  assert.equal(evidence.bodyVerified, true);
  assert.equal(evidence.openingStatus, "unknown");
  assert.equal(evidence.applicationStatus, "unknown");
});

// Copy the synthetic response-stream pattern from http-transport-empty.test.mjs.
// The real socketTransport, response decompressor and HTTP ledger path run; the
// only replacement is https.request, so no socket or external host is contacted.
function syntheticHttpsResponse(t, wire, gzip) {
  let calls = 0;
  t.mock.method(https, "request", (url, _options, onResponse) => {
    calls++;
    assert.equal(url.href, greenhouseListUrl(site));
    const request = new EventEmitter();
    request.destroy = (error) => {
      request.destroyed = true;
      request.emit("error", error);
      return request;
    };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {
        "content-type": "application/json; charset=utf-8",
        ...(gzip ? { "content-encoding": "gzip" } : {}),
      };
      onResponse(response);
      response.emit("data", wire);
      if (!request.destroyed) response.emit("end");
      return request;
    };
    queueMicrotask(() => {
      const socket = new EventEmitter();
      socket.remoteAddress = "93.184.216.34";
      request.emit("socket", socket);
      socket.emit("secureConnect");
    });
    return request;
  });
  return () => calls;
}
function paddedList(byteLength) {
  const payload = Buffer.from(JSON.stringify({ jobs: [row()], meta: { total: 1 } }));
  assert.ok(payload.length < byteLength);
  // JSON trailing whitespace keeps the document valid and makes exact wire /
  // expanded boundary sizes independent of its Chinese UTF-8 field lengths.
  return Buffer.concat([payload, Buffer.alloc(byteLength - payload.length, 0x20)]);
}

for (const [name, gzip, expandedLength, succeeds] of [
  ["ordinary >2MiB complete response", false, 2 * 1024 * 1024 + 1, true],
  ["gzip >2MiB complete expanded response", true, 2 * 1024 * 1024 + 1, true],
  ["ordinary 8MiB+1 wire response", false, GREENHOUSE_LIST_RESPONSE_BYTES + 1, false],
  ["gzip expansion to 8MiB+1", true, GREENHOUSE_LIST_RESPONSE_BYTES + 1, false],
]) test("adapter → real HTTP/socket decoding → formal ledger: " + name, async (t) => {
  const expanded = paddedList(expandedLength), wire = gzip ? gzipSync(expanded) : expanded,
    socketCalls = syntheticHttpsResponse(t, wire, gzip),
    f = await collectionFixture(t, { limits: { maxTotalAttachmentBytes: 16 * 1024 * 1024 } }),
    current = await f.openCommit(),
    budgets = await createActivityBudgets({
      ledger: f.ledger, ref: current.ref, token: current.token, operationLease: current.lease,
    });
  let during, transportLimit, page;
  const request = createRequestClient({
    budget: budgets.sources,
    scheduler: createScheduler({ minIntervalMs: 0 }),
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (input) => {
      transportLimit = input.maxBytes;
      during = await f.ledger.snapshot(current.ref);
      return socketTransport(input);
    },
  });
  const collect = async () => {
    page = await greenhouse.collectPage({
      site, query: { keyword: "消防" },
      context: {
        sites: [site], clock: { now: () => at },
        request: (url, options) => request(url, { ...options, maxRetries: 0 }),
      },
    });
  };
  if (succeeds) {
    await collect();
    assert.equal(page.raw, 1);
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0].bodyStatus, "complete");
    assert.match(page.records[0].description, /消防/);
  } else {
    await assert.rejects(collect(), { code: "response_size_exceeded" });
    assert.equal(page, undefined); // No partial job page escaped the adapter.
  }
  assert.equal(socketCalls(), 1);
  assert.equal(transportLimit, GREENHOUSE_LIST_RESPONSE_BYTES);
  assert.equal(during.usedRequests, 1);
  assert.equal(during.usedBytes, GREENHOUSE_LIST_RESPONSE_BYTES);
  assert.equal(during.knownPhysicalRequests, 0);
  assert.equal(during.unknownRequestUpperBound, 1);
  const after = await f.ledger.snapshot(current.ref),
    workspace = await f.repository.read(),
    reservations = Object.values(workspace.runs[current.ref.activityId].collectionProgress.ledger.reservations);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].bytesUpperBound, GREENHOUSE_LIST_RESPONSE_BYTES);
  assert.equal(reservations[0].requestUpperBound, 1);
  assert.equal(after.usedRequests, 1);
  assert.equal(after.usedBytes, succeeds ? wire.length : GREENHOUSE_LIST_RESPONSE_BYTES);
  assert.equal(after.knownPhysicalRequests, succeeds ? 1 : 0);
  assert.equal(after.unknownRequestUpperBound, succeeds ? 0 : 1);
  assert.equal(reservations[0].status, succeeds ? "settled" : "reserved");
  assert.equal(after.usedDetails, 0);
  assert.equal(after.usedModelRequests, 0);
  assert.equal(after.costUpperBoundCny, 0);
  if (gzip) assert.ok(wire.length < 2 * 1024 * 1024);
});
