import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import { createRecordEnrichment } from "../../src/application/record-enrichment.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";

const site = loadSiteCatalog().find(
  (s) => s.siteId === "official-2ea9828ffe1d2682",
);
const list = fs.readFileSync(
  new URL(
    "../fixtures/official-template-repair/hzairport-inline.html",
    import.meta.url,
  ),
  "utf8",
);
const form = fs
  .readFileSync(
    new URL(
      "../fixtures/official-template-repair/hzairport-application-37.html",
      import.meta.url,
    ),
    "utf8",
  )
  .replace('<label>验证码<input type="text" name="verifyCode"></label>', "");
const now = Date.parse("2026-10-12T00:00:00Z");
const clock = { now: () => now };
async function fixture() {
  const page = await announcements.collectPage({
    site,
    query: { keyword: "机场" },
    context: {
      sites: [site],
      clock,
      request: async (url) => {
        assert.equal(url, site.template.listUrl);
        return { status: 200, url, text: list, headers: {} };
      },
    },
  });
  return page.records[0];
}
async function enrich(html, patch = {}, runId = "synthetic-run") {
  const record = { ...(await fixture()), ...patch };
  let successes = 0,
    fixtureErrors = 0;
  const result = await createRecordEnrichment({ clock, officialSites: [site] })(
    record,
    {
      runId,
      request: async (url) => {
        try {
          assert.equal(url, record.applyUrl);
          successes++;
          return { status: 200, url, text: html, headers: {} };
        } catch (error) {
          fixtureErrors++;
          throw error;
        }
      },
    },
  );
  assert.equal(fixtureErrors, 0);
  return {
    result,
    successes,
    evidence: prepareRecruitmentRecord(result, now).recruitmentEvidence,
  };
}
for (const [name, html] of [
  ["another native job", form.replace('value="37"', 'value="58"')],
  [
    "another native title",
    form.replace('value="合成勤务观察员"', 'value="合成其他岗位"'),
  ],
  ["only an unrelated visible form", "<form><button>提交申请</button></form>"],
  [
    "hidden native ancestor",
    form
      .replace("<form id=", "<section hidden><form id=")
      .replace("</form>", "</form></section>")
      .replace("</body>", "<form><button>提交申请</button></form></body>"),
  ],
])
  test("normal full-body enrichment rejects " + name, async () => {
    const f = await enrich(html);
    assert.equal(f.successes, 1);
    assert.equal(f.result.applicationVerification.formVerified, false);
    assert.equal(f.evidence.applicationStatus, "unknown");
  });
for (const [name, wrapper, close] of [
  ["uppercase aria-hidden", '<section aria-hidden="TRUE">', "</section>"],
  ["padded aria-hidden", '<section aria-hidden=" true ">', "</section>"],
  ["collapsed ancestor", '<section style="visibility:collapse">', "</section>"],
  [
    "commented display none",
    '<section style="display: /*template*/ none">',
    "</section>",
  ],
  ["noscript ancestor", "<noscript>", "</noscript>"],
  ["template ancestor", "<template>", "</template>"],
])
  test("native form cannot escape its " + name, async () => {
    const html = form
      .replace("<form id=", wrapper + "<form id=")
      .replace("</form>", "</form>" + close)
      .replace("</body>", "<form><button>提交申请</button></form></body>");
    const f = await enrich(html);
    assert.equal(f.successes, 1);
    assert.equal(f.evidence.applicationStatus, "unknown");
    assert.equal(f.result.applicationVerification.formVerified, false);
  });
test("normal enrichment accepts the matching visible native job form", async () => {
  const f = await enrich(form);
  assert.equal(f.successes, 1);
  assert.equal(f.evidence.applicationStatus, "available");
});
test("old generic available proof cannot skip native binding", async () => {
  const f = await enrich(form.replace('value="37"', 'value="58"'), {
    applicationVerification: {
      status: 200,
      formVerified: true,
      checkedAt: new Date(now).toISOString(),
      checkedInRunId: "synthetic-run",
      checkedUrl: "https://www.hzairport.com/talent/detail/id/37.html",
    },
  });
  assert.equal(f.successes, 1);
  assert.equal(f.evidence.applicationStatus, "unknown");
});
test("fresh native same-run proof is reused, but a renamed job invalidates it", async () => {
  const first = await enrich(form);
  assert.equal(first.evidence.applicationStatus, "available");
  const again = await enrich(form, {
    applicationVerification: first.result.applicationVerification,
  });
  assert.equal(again.successes, 0);
  const renamed = await enrich(form, {
    title: "合成其他岗位",
    applicationVerification: first.result.applicationVerification,
  });
  assert.equal(renamed.successes, 1);
  assert.equal(renamed.evidence.applicationStatus, "unknown");
});
for (const [name, patch] of [
  ["source", { sourceId: "synthetic-other" }],
  ["site", { siteId: "official-synthetic-other" }],
  ["source and title", { sourceId: "synthetic-other", title: "合成其他岗位" }],
])
  test("native proof cannot move to another " + name, async () => {
    const first = await enrich(form);
    const changed = await enrich(form, {
      ...patch,
      applicationVerification: first.result.applicationVerification,
    });
    assert.equal(changed.successes, 0);
    assert.equal(changed.evidence.applicationStatus, "unknown");
  });
for (const [name, patch] of [
  [
    "expired",
    {
      deadlineAt: "2026-10-01T00:00:00Z",
      description:
        "岗位职责：合成岗位维护。岗位要求：大专学历。报名截止：2026年10月1日。",
      sourceEvidence: [],
    },
  ],
  [
    "incomplete",
    {
      detailStatus: "incomplete",
      bodyStatus: "incomplete",
      sourceEvidence: [],
    },
  ],
])
  test("native application read remains gated when " + name, async () => {
    const f = await enrich(form, patch);
    assert.equal(f.successes, 0);
    assert.notEqual(f.evidence.applicationStatus, "available");
  });
