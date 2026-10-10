import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyProvider } from "../../src/sources/adapters/legacy.mjs";
import { fetchSchedule } from "../../src/sources/nowcoder.mjs";
import { withSourceContext } from "../../src/sources/request-context.mjs";
import { gateRecommendation } from "../../src/domain/recruitment-evidence.mjs";

const now = Date.parse("2026-10-10T00:00:00Z");
const originalFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = () => {
    throw Error("external_network_denied");
  };
});
test.after(() => {
  globalThis.fetch = originalFetch;
});
const bochaRow = (dates = {}) => ({
  name: "合成消防岗位",
  url: "https://jobs.example.test/fire",
  summary: "消防设施检查与维护。",
  ...dates,
});
const nowcoderRow = (dates = {}) => ({
  id: 123,
  jobName: "合成消防岗位",
  refreshTime: 1791590400000,
  deliverBegin: 1788220800000,
  deliverEnd: 1798675200000,
  recommendInternCompany: { companyName: "合成企业" },
  ext: JSON.stringify({ requirements: "岗位要求：本科，专业不限。" }),
  ...dates,
});
const shixisengRow = (dates = {}) => ({
  uuid: "inn_synthetic",
  name: "合成消防实习",
  cname: "合成企业",
  type: "intern",
  refresh: "刚刚刷新",
  hope_you: ["岗位要求：本科，专业不限。"],
  ...dates,
});
async function collect(id, row) {
  const text =
    id === "searchapi"
      ? JSON.stringify({ code: 200, data: { webPages: { value: [row] } } })
      : id === "nowcoder"
        ? `<script>window.__INITIAL_STATE__=${JSON.stringify({ jobListData: [row] })};</script>`
        : `<script>window.__NUXT__=${JSON.stringify({ interns: { data: [row] } })};</script>`;
  const result = await createLegacyProvider(id).collect({
    queries: [{ keyword: "合成招聘", pageLimit: 1 }],
    clock: { now: () => now },
    targetSnapshot: {},
    profileRevision: { profile: {} },
    config: {
      __activeSearchProvider: "bocha",
      __searchKeys: { bocha: "synthetic-key" },
    },
    request: async (url) => ({ status: 200, headers: {}, url, text }),
  });
  assert.equal(result.issues.length, 0);
  assert.equal(result.records.length, 1);
  return result.records[0];
}

test("Bocha crawl time cannot become a publication date", async () => {
  const record = await collect(
    "searchapi",
    bochaRow({ dateLastCrawled: "2026-10-10T01:02:03Z" }),
  );
  assert.equal(record.publishTime, "");
  assert.equal(record.extra.dateLastCrawled, "2026-10-10T01:02:03Z");
  assert.equal(record.publishedAt ?? null, null);
});

test("Bocha retains an explicit publication date and both exact source time fields", async () => {
  const record = await collect(
    "searchapi",
    bochaRow({
      datePublished: "2020-01-02T03:04:05+08:00",
      dateLastCrawled: "2026-10-10T01:02:03Z",
    }),
  );
  assert.equal(record.publishTime, "2020-01-02");
  assert.equal(record.extra.datePublished, "2020-01-02T03:04:05+08:00");
  assert.equal(record.extra.dateLastCrawled, "2026-10-10T01:02:03Z");
  assert.equal(record.publishedAt ?? null, null);
});

test("an unknown Bocha publication date stays unknown while raw values remain inspectable", async () => {
  const record = await collect(
    "searchapi",
    bochaRow({ datePublished: "待核验", dateLastCrawled: "2026-10-10" }),
  );
  assert.equal(record.publishTime, "");
  assert.equal(record.extra.datePublished, "待核验");
  assert.equal(record.extra.dateLastCrawled, "2026-10-10");
});

test("Nowcoder refresh time stays raw instead of becoming a publication date", async () => {
  const record = await collect("nowcoder", nowcoderRow());
  assert.equal(record.publishTime, "");
  assert.equal(record.extra.refreshTime, 1791590400000);
  assert.equal(record.extra.deliverBegin, "2026-09-01");
  assert.equal(record.extra.deliverEnd, "2026-12-31");
  assert.equal(record.publishedAt ?? null, null);
});

test("Nowcoder preserves an uninterpreted refresh value without inventing publication metadata", async () => {
  const record = await collect(
    "nowcoder",
    nowcoderRow({ refreshTime: "平台原始刷新值" }),
  );
  assert.equal(record.publishTime, "");
  assert.equal(record.extra.refreshTime, "平台原始刷新值");
});

test("Nowcoder schedule update time does not masquerade as a campaign publication date", async () => {
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({
    datas: [
      {
        name: "合成机场企业",
        companyId: 321,
        batchName: "2027届秋招",
        updateTime: "1791590400000",
        wangshenBeginDate: 1788220800000,
        wangshenEndDate: 1798675200000,
      },
    ],
  })};</script>`;
  const result = await withSourceContext(
    { request: async (url) => ({ status: 200, headers: {}, url, text: html }) },
    () => fetchSchedule(),
  );
  assert.equal(result.items.length, 1);
  const record = result.items[0];
  assert.equal(record.publishTime, "");
  assert.equal(record.extra.updateTime, "1791590400000");
  assert.equal(record.extra.wangshenBegin, "2026-09-01");
  assert.equal(record.extra.wangshenEnd, "2026-12-31");
});

test("Shixiseng refresh text stays raw instead of becoming a publication date", async () => {
  const record = await collect("shixiseng", shixisengRow());
  assert.equal(record.publishTime, "");
  assert.equal(record.extra.refresh, "刚刚刷新");
  assert.equal(record.publishedAt ?? null, null);
});

test("source freshness cannot replace explicit recruitment opening evidence", async () => {
  for (const [id, row] of [
    ["searchapi", bochaRow({ dateLastCrawled: "2026-10-10" })],
    ["nowcoder", nowcoderRow()],
    ["shixiseng", shixisengRow({ refresh: "2026-10-10" })],
  ]) {
    const collected = await collect(id, row);
    const supported = {
      ...collected,
      description: "岗位职责：维护消防设施。岗位要求：本科，专业不限。",
      bodyStatus: "complete",
      detailStatus: "complete",
      parserVersion: "synthetic-body-1",
      applyUrl: "https://jobs.example.test/apply",
      applicationVerification: {
        status: 200,
        formVerified: true,
        checkedAt: "2026-10-10T00:00:00.000Z",
      },
    };
    for (const [deadlineAt, openingStatus, recommended] of [
      [undefined, "unknown", false],
      ["2020-01-01T00:00:00Z", "expired", false],
      ["2026-12-31T00:00:00Z", "open", true],
    ]) {
      const gated = gateRecommendation(
        { qualification: { status: "pass" }, recommendation: "recommended" },
        { ...supported, deadlineAt },
        now,
      );
      assert.equal(gated.recruitmentEvidence.openingStatus, openingStatus, id);
      assert.equal(gated.recommended, recommended, id);
    }
  }
});
