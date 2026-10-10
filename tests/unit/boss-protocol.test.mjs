import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBossOperation,
  parseBossResponse,
} from "../../src/sources/boss/protocol.mjs";
import {
  mapBossJob,
  bossPlatformEvidence,
} from "../../src/sources/boss/records.mjs";
const checkedAt = "2026-10-10T00:00:00.000Z";

test("Boss search and card operations use only their fixed read contracts", () => {
  assert.deepEqual(
    buildBossOperation({
      kind: "boss.search",
      query: "消防",
      city: "101290100",
    }),
    {
      kind: "boss.search",
      method: "POST",
      url: "https://www.zhipin.com/wapi/zpgeek/search/joblist.json",
      parameters: {
        query: "消防",
        city: "101290100",
        page: 1,
        pageSize: 15,
        scene: 1,
      },
    },
  );
  assert.deepEqual(
    buildBossOperation({
      kind: "boss.detail",
      securityId: "synthetic-reference",
      lid: "synthetic-list",
    }),
    {
      kind: "boss.detail",
      method: "GET",
      url: "https://www.zhipin.com/wapi/zpgeek/job/card.json",
      parameters: { securityId: "synthetic-reference", lid: "synthetic-list" },
    },
  );
  for (const input of [
    { kind: "boss.greet" },
    { kind: "boss.search", query: "消防", page: 21 },
    { kind: "boss.search", query: "消防", page: 0 },
    { kind: "boss.search", query: "消防", pageSize: 31 },
    { kind: "boss.search", query: "消防", city: "昆明" },
    { kind: "boss.search", query: "消防", url: "https://evil.example.org" },
    { kind: "boss.search", query: "消防", method: "GET" },
    { kind: "boss.detail", securityId: "x".repeat(2049) },
    { kind: "boss.detail", securityId: "reference", lid: "x".repeat(257) },
    { kind: "boss.detail", securityId: "reference", query: "extra" },
  ])
    assert.throws(() => buildBossOperation(input), {
      code: "boss_request_invalid",
    });
});

test("Boss business response success requires the expected envelope and pagination shape", () => {
  const result = parseBossResponse({
    kind: "boss.search",
    status: 200,
    payload: { code: 0, zpData: { jobList: [], hasMore: false } },
    checkedAt,
  });
  assert.equal(result.status, "success");
  assert.deepEqual(result.records, []);
  assert.equal(result.hasMore, false);
  for (const payload of [
    { code: 0 },
    { code: 0, zpData: { jobList: [], hasMore: "yes" } },
    { code: 0, zpData: { jobList: {}, hasMore: false } },
  ])
    assert.equal(
      parseBossResponse({
        kind: "boss.search",
        status: 200,
        payload,
        checkedAt,
      }).code,
      "boss_response_invalid",
    );
  const detail = parseBossResponse({
    kind: "boss.detail",
    status: 200,
    payload: {
      code: 0,
      zpData: {
        jobCard: {
          postDescription:
            "招聘消防工程师，本科，负责防火检查、设施维护和消防设计。",
        },
      },
    },
    checkedAt,
  });
  assert.equal(detail.status, "success");
  assert.ok(detail.detail.postDescription.includes("消防工程师"));
  assert.equal(
    parseBossResponse({
      kind: "boss.detail",
      status: 200,
      payload: { code: 0, zpData: { jobInfo: {} } },
      checkedAt,
    }).code,
    "boss_response_invalid",
  );
});

test("Boss account and environment risk stop conservatively while token expiry stays distinct", () => {
  for (const payload of [
    { code: 36, message: "账户限制" },
    { code: 37, message: "访问环境异常，stoken过期" },
    { code: 37, message: "unknown response" },
  ])
    assert.equal(
      parseBossResponse({
        kind: "boss.search",
        status: 200,
        payload,
        checkedAt,
      }).status,
      "risk_blocked",
    );
  const expired = parseBossResponse({
    kind: "boss.search",
    status: 200,
    payload: { code: 37, msg: "登录状态过期" },
    checkedAt,
  });
  assert.equal(expired.status, "login_required");
  assert.equal(expired.code, "boss_auth_expired");
  assert.equal(
    parseBossResponse({
      kind: "boss.search",
      status: 429,
      payload: {},
      checkedAt,
    }).code,
    "boss_rate_limited",
  );
});

test("Boss mapping retains public job identity and never persists read references or recruiter fields", () => {
  const raw = {
    encryptJobId: "public-job~1",
    jobName: "消防工程师",
    brandName: "合成企业",
    cityName: "昆明",
    jobDegree: "本科",
    jobExperience: "经验不限",
    salaryDesc: "6-8K",
    securityId: "synthetic-ref",
    lid: "synthetic-lid",
    bossName: "合成招聘联系人",
    bossOnline: true,
    accountCity: "北京",
    jobStatus: "active",
  };
  const { record, readRef } = mapBossJob(raw, {
    site: { siteId: "boss" },
    checkedAt,
  });
  assert.equal(record.sourceRecordId, "public-job~1");
  assert.equal(record.sourceRecordIdKind, "authority");
  assert.equal(
    record.url,
    "https://www.zhipin.com/job_detail/public-job~1.html",
  );
  assert.deepEqual(record.cities, ["昆明"]);
  assert.deepEqual(readRef, {
    securityId: "synthetic-ref",
    lid: "synthetic-lid",
  });
  const stored = JSON.stringify(record);
  for (const value of [
    "synthetic-ref",
    "synthetic-lid",
    "合成招聘联系人",
    "北京",
  ])
    assert.ok(!stored.includes(value));
  assert.equal(record.platformEvidence.opening.status, "unknown");
  assert.equal(record.applicationVerification.status, "unknown");
  assert.throws(
    () =>
      mapBossJob(
        { ...raw, encryptJobId: null },
        { site: { siteId: "boss" }, checkedAt },
      ),
    { code: "boss_record_invalid" },
  );
});

test("Boss communication and stale or unverified recruitment signals cannot prove an available application", () => {
  const observation = {
    jobId: "job-1",
    checkedAt,
    semanticVerified: true,
    value: "recruiting",
  };
  const entry = {
    jobId: "job-1",
    checkedAt,
    kind: "communication",
    loggedIn: true,
    enabled: true,
    semanticVerified: true,
  };
  const result = bossPlatformEvidence({
    jobId: "job-1",
    opening: observation,
    entry,
    now: Date.parse(checkedAt),
  });
  assert.equal(result.opening.status, "verified");
  assert.equal(result.entry.kind, "communication");
  assert.equal(result.applicationStatus, "unknown");
  assert.equal(result.formVerified, false);
  for (const opening of [
    { ...observation, checkedAt: "2026-10-06T00:00:00Z" },
    { ...observation, jobId: "other-job" },
    { ...observation, semanticVerified: false },
  ])
    assert.equal(
      bossPlatformEvidence({
        jobId: "job-1",
        opening,
        entry,
        now: Date.parse(checkedAt),
      }).opening.status,
      "unknown",
    );
});
