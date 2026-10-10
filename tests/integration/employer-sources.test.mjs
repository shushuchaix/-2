import test from "node:test";
import assert from "node:assert/strict";
import tencent from "../../src/sources/adapters/tencent.mjs";
import smart from "../../src/sources/adapters/smartrecruiters.mjs";
import greenhouse from "../../src/sources/adapters/greenhouse.mjs";
const ctx = (site, request) => ({
  sites: [site],
  queries: [{ keyword: "", pageLimit: 1 }],
  request,
  clock: { now: Date.now },
});
test("Tencent preserves social identity and never uses update time as publication", async () => {
  const c = ctx({ siteId: "tencent" }, async (url) => ({
    status: 200,
    text: JSON.stringify(
      url.includes("ByPostId")
        ? {
            Code: 200,
            Data: {
              PostId: "p1",
              RecruitPostName: "开发工程师",
              Responsibility: "负责开发和维护产品。",
              Requirement: "本科以上，三年Java开发经验。",
            },
          }
        : {
            Code: 200,
            Data: {
              Count: 1,
              Posts: [
                {
                  PostId: "p1",
                  RecruitPostName: "开发工程师",
                  LocationName: "深圳",
                  LastUpdateTime: "2026-10-01",
                },
              ],
            },
          },
    ),
  }));
  const r = await tencent.collect(c);
  assert.equal(r.records[0].jobType, "social");
  assert.equal(r.records[0].publishedAt, null);
  assert.ok(
    (await tencent.fetchDetail(r.records[0], c)).description.includes("三年"),
  );
  c.request = async () => ({
    status: 200,
    text: JSON.stringify({ Code: 403 }),
  });
  assert.equal((await tencent.collect(c)).issues[0].code, "restricted");
});
test("documented ATS bodies preserve tenant ownership and real publication fields", async () => {
  const site = { siteId: "bosch", tenantId: "BoschGroup", name: "博世" };
  const c = ctx(site, async (url) => ({
    status: 200,
    text: JSON.stringify(
      url.includes("/postings/x1")
        ? {
            id: "x1",
            name: "设备工程师",
            company: { identifier: "BoschGroup" },
            releasedDate: "2026-09-01",
            applyUrl: "https://jobs.smartrecruiters.com/BoschGroup/x1",
            jobAd: {
              sections: {
                qualifications: {
                  text: "本科机械专业，负责生产线设备维护，具备工程实践经验。",
                },
              },
            },
          }
        : {
            totalFound: 100,
            content: [
              {
                id: "x1",
                name: "设备工程师",
                ref: "https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/x1",
                location: { city: "苏州" },
                company: { identifier: "BoschGroup" },
              },
            ],
          },
    ),
  }));
  const r = await smart.collect(c);
  assert.equal(r.coverage[0].truncated, true);
  assert.equal(
    (await smart.fetchDetail(r.records[0], c)).publishedAt,
    "2026-09-01T00:00:00.000Z",
  );
  const g = ctx(
    { siteId: "canonical", tenantId: "canonical", name: "Canonical" },
    async () => ({
      status: 200,
      text: JSON.stringify({
        meta: { total: 1 },
        jobs: [
          {
            id: 1,
            title: "Graduate engineer",
            absolute_url: "https://job-boards.greenhouse.io/canonical/jobs/1",
            first_published: "2026-08-01",
            updated_at: "2026-10-01",
            content:
              "<p>Graduate engineers develop Linux services. Knowledge of Python is required.</p>",
            location: { name: "Home based APAC" },
          },
        ],
      }),
    }),
  );
  const gr = await greenhouse.collect(g);
  assert.equal(gr.records[0].publishedAt, "2026-08-01T00:00:00.000Z");
  assert.ok(gr.records[0].description.includes("Linux"));
  assert.equal(gr.records[0].jobType, "unknown");
});
