import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyProvider } from "../../src/sources/adapters/legacy.mjs";
import { createRecordEnrichment } from "../../src/application/record-enrichment.mjs";
import { evaluateQualification } from "../../src/domain/qualification.mjs";
import {
  assessRecruitmentEvidence,
  gateRecommendation,
  prepareApplicationCheck,
} from "../../src/domain/recruitment-evidence.mjs";

const now = Date.parse("2026-10-10T00:00:00Z");
const sources = ["zhaopin", "shixiseng", "jiuyeqiao"];
const navigation =
  "<nav>首页 帮助中心 用户协议 隐私政策 联系我们 网站导航</nav>" +
  "<footer>网站服务条款 联系我们 网站地图 © 2026</footer>";
const requirements =
  "岗位职责：负责消防设备巡检和工程设计。".repeat(240) +
  "任职要求：本科及以上学历，必须持有注册消防工程师证书。";

function fixture(sourceId, html, fields = {}) {
  const record = {
    sourceId,
    siteId: sourceId,
    sourceRecordId: "123",
    identityScope: sourceId,
    kind: "job",
    title: "合成消防工程师",
    company: "合成单位",
    degree: "本科",
    cities: ["上海"],
    url: "https://synthetic.invalid/zhiwei/123.html",
    applyUrl: "https://synthetic.invalid/apply",
    deadlineAt: "2026-12-31T15:59:59Z",
    retrievedAt: "2026-10-10T00:00:00Z",
    parserVersion: "legacy-adapter-3",
    // The replacement page must not inherit the last complete response.
    description: "上次完整正文：本科及以上学历。",
    detailStatus: "complete",
    bodyStatus: "complete",
    retryEligible: true,
    applicationVerification: {
      status: 200,
      formVerified: true,
      checkedAt: "2026-10-10T00:00:00Z",
    },
    ...fields,
  };
  const requested = [],
    claimed = [];
  const context = {
    budget: { claimDetail: async (key) => claimed.push(key) },
    request: async (url) => {
      requested.push(url);
      return { status: 200, headers: {}, text: html };
    },
  };
  return { record, context, requested, claimed };
}

for (const sourceId of sources) {
  for (const [name, html] of [
    ["navigation-only page", "<html><body>" + navigation + "</body></html>"],
    [
      "long whole-page fallback",
      "<html><body>" +
        navigation +
        "<p>网站公共说明与服务协议。".repeat(800) +
        "</p></body></html>",
    ],
  ]) {
    test(sourceId + " cannot verify or recommend a " + name, async () => {
      const f = fixture(sourceId, html);
      const detail = await createLegacyProvider(sourceId).fetchDetail(
        f.record,
        f.context,
      );
      const evidence = assessRecruitmentEvidence({ record: detail, now });
      assert.equal(evidence.bodyVerified, false);
      assert.equal(detail.detailStatus, "incomplete");
      assert.equal(detail.bodyStatus, "incomplete");
      assert.equal(detail.retryEligible, false);
      assert.equal(prepareApplicationCheck(detail, now).shouldRequest, false);
      const qualification = evaluateQualification(detail, { education: "本科" });
      assert.equal(
        gateRecommendation({ qualification }, detail, now).recommended,
        false,
      );
      await createRecordEnrichment({ clock: { now: () => now } })(
        detail,
        f.context,
      );
      assert.deepEqual(f.requested, [f.record.url]);
      assert.equal(f.claimed.length, 1);
      assert.equal(detail.sourceRecordId, "123");
      assert.equal(detail.applyUrl, f.record.applyUrl);
    });
  }
}

const nativePages = {
  zhaopin:
    "<html><body>" +
    navigation +
    "<script>window.__INITIAL_STATE__ = " +
    JSON.stringify({
      jobDetail: { detailedPosition: { position: { description: requirements } } },
    }) +
    ";</script></body></html>",
  shixiseng:
    "<html><body>" +
    navigation +
    "<script>window.__NUXT__ = " +
    JSON.stringify({
      data: [{ intern: { uuid: "123", description: requirements } }],
    }) +
    ";</script></body></html>",
  jiuyeqiao:
    "<html><body>" +
    navigation +
    '<div class="detail"><p>' +
    requirements +
    "</p></div><footer>其他岗位要求：必须具有十年经验。</footer></body></html>",
};

for (const sourceId of sources) {
  test(sourceId + " retains the entire native job body and upgrades old facts", async () => {
    const f = fixture(sourceId, nativePages[sourceId], {
      parserVersion: "legacy-adapter-2",
    });
    const detail = await createLegacyProvider(sourceId).fetchDetail(
      f.record,
      f.context,
    );
    assert.equal(detail.description, requirements);
    assert.equal(detail.bodyStatus, "complete");
    assert.equal(detail.detailStatus, "complete");
    assert.equal(detail.parserVersion, "legacy-adapter-3");
    assert.equal(
      assessRecruitmentEvidence({ record: detail, now }).bodyVerified,
      true,
    );
    assert.equal(detail.sourceRecordId, "123");
    assert.equal(detail.applyUrl, f.record.applyUrl);
    assert.deepEqual(f.requested, [f.record.url]);
    assert.equal(f.claimed.length, 1);
  });
}

test("a job heading in generic navigation does not prove a scoped Zhaopin body", async () => {
  const f = fixture(
    "zhaopin",
    "<html><body><nav>职位描述 " +
      "访问岗位详情请前往首页检索，我们的服务帮助中心提供公开使用说明。".repeat(20) +
      "</nav></body></html>",
  );
  const detail = await createLegacyProvider("zhaopin").fetchDetail(
    f.record,
    f.context,
  );
  assert.equal(
    assessRecruitmentEvidence({ record: detail, now }).bodyVerified,
    false,
  );
});

test("Shixiseng Nuxt company text or another position is not this job's body", async () => {
  for (const payload of [
    { data: [{ company: { description: requirements } }] },
    { data: [{ intern: { uuid: "another-position", description: requirements } }] },
  ]) {
    const f = fixture(
      "shixiseng",
      "<html><body>" +
        navigation +
        "<script>window.__NUXT__ = " +
        JSON.stringify(payload) +
        ";</script></body></html>",
    );
    const detail = await createLegacyProvider("shixiseng").fetchDetail(
      f.record,
      f.context,
    );
    assert.equal(
      assessRecruitmentEvidence({ record: detail, now }).bodyVerified,
      false,
    );
  }
});

test("Shixiseng matching job identity cannot turn a company field into a JD", async () => {
  const f = fixture(
    "shixiseng",
    "<html><body>" +
      navigation +
      "<script>window.__NUXT__ = " +
      JSON.stringify({
        data: [{ intern: { uuid: "123", companyIntroduction: requirements } }],
      }) +
      ";</script></body></html>",
  );
  const detail = await createLegacyProvider("shixiseng").fetchDetail(
    f.record,
    f.context,
  );
  assert.equal(
    assessRecruitmentEvidence({ record: detail, now }).bodyVerified,
    false,
  );
  assert.equal(prepareApplicationCheck(detail, now).shouldRequest, false);
});
