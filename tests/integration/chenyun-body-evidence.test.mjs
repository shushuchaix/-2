import test from "node:test";
import assert from "node:assert/strict";
import { parseDetail } from "../../src/sources/chenyun.mjs";
import { createLegacyProvider } from "../../src/sources/adapters/legacy.mjs";
import {
  assessRecruitmentEvidence,
  isVerifiedRecommendation,
} from "../../src/domain/recruitment-evidence.mjs";

const now = Date.parse("2026-10-12T00:00:00Z");
const tail =
  "报名截止时间：2027年1月1日。任职要求：须取得一级注册消防工程师资格。";
const requirements =
  "岗位职责：负责消防设施检查、维护和隐患排查。".repeat(250) + tail;
const nativePage = (body) =>
  '<div class="infor-tllf"><h3>消防设施维护工程师' +
  '<span class="update-time">发布于2026-10-10</span></h3></div>' +
  '<div id="index_detail_content"><p>' +
  body +
  "</p></div>";
const nestedDuty = "岗位职责：负责消防设施检查、维护和隐患排查。";
const nestedPage = (attribute) =>
  '<div class="infor-tllf"><h3>消防设施维护工程师</h3></div>' +
  "<div " +
  attribute +
  "><div>" +
  nestedDuty +
  "</div><p>" +
  tail +
  "</p></div>" +
  "<div>其他岗位任职要求：必须具有十年工作经验。</div>";

for (const [name, attribute] of [
  ["native ID container", 'id="index_detail_content"'],
  ["job_need fallback", 'class="content job_need"'],
]) {
  test(`Chenyun ${name} retains the full nested body after the first child div`, () => {
    const detail = parseDetail(nestedPage(attribute));
    assert.equal(detail.requirement, nestedDuty + " " + tail);
    assert.equal(detail.description.endsWith(tail), true);
    assert.equal(detail.description.includes("其他岗位"), false);
  });

  test(`Chenyun ${name} exposes its trailing deadline and certificate requirement as full detail`, async () => {
    const record = {
      sourceId: "chenyun",
      siteId: "chenyun-school",
      sourceRecordId:
        "https://school.example.org/index/index/employjobdetail.html?id=1",
      title: "消防设施维护工程师",
      company: "合成公开雇主",
      url: "https://school.example.org/index/index/employjobdetail.html?id=1",
      parserVersion: "legacy-adapter-2",
    };
    const detail = await createLegacyProvider("chenyun").fetchDetail(record, {
      request: async (url) => ({
        status: 200,
        headers: {},
        url,
        text: nestedPage(attribute),
      }),
    });
    assert.equal(detail.description.endsWith(tail), true);
    assert.equal(detail.description.includes("一级注册消防工程师资格"), true);
    assert.equal(detail.deadlineAt, "2027-01-01T15:59:59.999Z");
    assert.equal(detail.bodyStatus, "complete");
    assert.equal(detail.detailStatus, "complete");
    assert.equal(detail.parserVersion, "chenyun-body-1");
    assert.equal(
      assessRecruitmentEvidence({ record: detail, now }).bodyVerified,
      true,
    );
  });
}

for (const [name, bodyContainer] of [
  ["missing body containers", ""],
  [
    "empty native ID container",
    '<div id="index_detail_content"><p> </p></div>',
  ],
  ["empty fallback container", '<div class="job_need"><div> </div></div>'],
]) {
  test(`Chenyun ${name} cannot verify a description containing only the address`, async () => {
    const html =
      '<div class="infor-tllf"><h3>消防设施维护工程师</h3></div>' +
      bodyContainer +
      "<p>工作地址</p><p>上海市合成工作地址</p>";
    const record = {
      sourceId: "chenyun",
      siteId: "chenyun-school",
      sourceRecordId:
        "https://school.example.org/index/index/employjobdetail.html?id=1",
      title: "消防设施维护工程师",
      company: "合成公开雇主",
      url: "https://school.example.org/index/index/employjobdetail.html?id=1",
      parserVersion: "legacy-adapter-2",
      description: "旧正文不能成为本次缺失正文的证据。",
      bodyStatus: "complete",
      detailStatus: "complete",
    };
    const detail = await createLegacyProvider("chenyun").fetchDetail(record, {
      request: async (url) => ({ status: 200, headers: {}, url, text: html }),
    });
    assert.equal(detail.description, "工作地址：上海市合成工作地址");
    assert.equal(
      assessRecruitmentEvidence({ record: detail, now }).bodyVerified,
      false,
    );
    assert.equal(detail.bodyStatus, "incomplete");
    assert.equal(detail.detailStatus, "incomplete");
    assert.equal(detail.parserVersion, "chenyun-body-1");
  });
}

test("Chenyun retains requirements and deadlines beyond its old body cutoff", () => {
  const detail = parseDetail(nativePage(requirements));
  assert.equal(
    detail.description.endsWith(tail),
    true,
    "a complete native body must keep its trailing deadline and hard requirement",
  );
  assert.equal(detail.description.length, requirements.length);
});

test("Chenyun fresh detail proves its entire body while retaining the short summary", async () => {
  const record = {
    sourceId: "chenyun",
    siteId: "chenyun-school",
    sourceRecordId:
      "https://school.example.org/index/index/employjobdetail.html?id=1",
    title: "消防设施维护工程师",
    company: "合成公开雇主",
    city: "南京",
    url: "https://school.example.org/index/index/employjobdetail.html?id=1",
    extra: { university: "合成学校" },
    parserVersion: "legacy-adapter-2",
    description: "过往列表摘要不能成为当前正文。",
    detailStatus: "complete",
    bodyStatus: "complete",
  };
  const requested = [],
    claimed = [];
  const detail = await createLegacyProvider("chenyun").fetchDetail(record, {
    clock: { now: () => now },
    budget: { claimDetail: async (key) => claimed.push(key) },
    request: async (url) => {
      requested.push(url);
      return { status: 200, headers: {}, url, text: nativePage(requirements) };
    },
  });
  assert.equal(detail.description.endsWith(tail), true);
  assert.equal(detail.description.length, requirements.length);
  assert.equal(detail.bodyStatus, "complete");
  assert.equal(detail.detailStatus, "complete");
  assert.equal(detail.parserVersion, "chenyun-body-1");
  assert.equal(detail.deadlineAt, "2027-01-01T15:59:59.999Z");
  assert.ok(detail.summary.length <= 241);
  assert.equal(detail.summary.endsWith("…"), true);
  assert.equal(detail.url, record.url);
  assert.equal(detail.sourceRecordId, record.sourceRecordId);
  assert.equal(detail.company, record.company);
  assert.equal(detail.title, record.title);
  assert.equal(
    assessRecruitmentEvidence({ record: detail, now }).bodyVerified,
    true,
  );
  assert.deepEqual(requested, [record.url]);
  assert.equal(claimed.length, 1);
});

const persisted = {
  sourceId: "chenyun",
  title: "消防设施维护工程师",
  detailStatus: "complete",
  deadlineAt: "2027-01-01T15:59:59.999Z",
  applyUrl: "https://school.example.org/apply",
  applicationVerification: {
    status: 200,
    formVerified: true,
    checkedAt: "2026-10-12T00:00:00Z",
  },
};

for (const parserVersion of [
  "legacy-adapter-1",
  "legacy-adapter-2",
  "legacy-adapter-3",
]) {
  test(`persisted Chenyun ${parserVersion} bodies require fresh full body evidence`, () => {
    for (const description of [
      "岗位职责：负责消防设施检查、维护和隐患排查。",
      "招".repeat(3000) + "…",
    ]) {
      for (const bodyStatus of [undefined, "complete"]) {
        const evidence = assessRecruitmentEvidence({
          record: { ...persisted, parserVersion, description, bodyStatus },
          now,
        });
        assert.equal(evidence.bodyVerified, false);
        assert.equal(
          isVerifiedRecommendation({
            evidence,
            qualification: { status: "pass" },
          }),
          false,
        );
      }
    }
  });
}

for (const parserVersion of ["chenyun-body-1", "manual-verification-1"]) {
  test(`Chenyun ${parserVersion} preserves explicit complete body evidence`, () => {
    const evidence = assessRecruitmentEvidence({
      record: {
        ...persisted,
        parserVersion,
        description: requirements,
        bodyStatus: "complete",
      },
      now,
    });
    assert.equal(evidence.bodyVerified, true);
    assert.equal(
      isVerifiedRecommendation({ evidence, qualification: { status: "pass" } }),
      true,
    );
  });
}
