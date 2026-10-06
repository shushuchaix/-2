import test from "node:test";
import assert from "node:assert/strict";
import job91 from "../../src/sources/adapters/university-91job.mjs";
import smart from "../../src/sources/adapters/smartrecruiters.mjs";
import greenhouse from "../../src/sources/adapters/greenhouse.mjs";
import { assertSourceRecord } from "../../src/domain/contracts.mjs";
import { job } from "../helpers/fixtures.mjs";

const requirements =
  "负责公开招聘岗位的工程实践工作，要求具备相关专业知识及项目经验。";
const cases = [
  {
    name: "91job job",
    provider: job91,
    sourceId: "university-91job",
    site: {
      siteId: "school",
      tenantId: "10286",
      origin: "https://school.example.com",
      name: "学校",
    },
    body: (fields = {}) => ({
      success: true,
      code: 200,
      result: { zpgwid: "1", zwms: requirements, ...fields },
    }),
    blank: { zwmc: "  ", dwmc: "", gzdd: "", xlyq: "", fbsj: "", gzxz: "" },
    update: {
      zwmc: "详情岗位名称",
      dwmc: "详情公司",
      gzdd: "苏州",
      xlyq: "硕士",
      fbsj: "2026-09-02",
    },
  },
  {
    name: "91job notice",
    provider: job91,
    sourceId: "university-91job",
    sourceRecordId: "notice:1",
    kind: "recruitment_notice",
    site: {
      siteId: "school",
      tenantId: "10286",
      origin: "https://school.example.com",
      name: "学校",
    },
    body: (fields = {}) => ({
      success: true,
      code: 200,
      result: { zpggid: "1", zpggxq: requirements, ...fields },
    }),
    blank: { zpggbt: "  ", gzcs: "", fbsj: "" },
    update: { zpggbt: "详情岗位名称", gzcs: "苏州", fbsj: "2026-09-02" },
  },
  {
    name: "SmartRecruiters",
    provider: smart,
    sourceId: "smartrecruiters",
    site: {
      siteId: "company",
      tenantId: "SyntheticCompany",
      name: "目录公司名",
    },
    body: (fields = {}) => ({
      id: "1",
      jobAd: { sections: { qualifications: { text: requirements } } },
      ...fields,
    }),
    blank: {
      name: "  ",
      company: { name: "" },
      location: { city: "" },
      applyUrl: "",
      releasedDate: "",
    },
    update: {
      name: "详情岗位名称",
      company: { identifier: "SyntheticCompany", name: "详情公司" },
      location: { city: "苏州" },
      releasedDate: "2026-09-02",
    },
  },
  {
    name: "Greenhouse",
    provider: greenhouse,
    sourceId: "greenhouse",
    site: { siteId: "board", tenantId: "synthetic", name: "目录公司名" },
    body: (fields = {}) => ({
      id: "1",
      content: "<p>" + requirements + "</p>",
      ...fields,
    }),
    blank: {
      title: "  ",
      company_name: "",
      location: { name: "" },
      absolute_url: "",
      first_published: "",
      application_deadline: "",
    },
    update: {
      title: "详情岗位名称",
      company_name: "详情公司",
      location: { name: "苏州" },
      first_published: "2026-09-02",
    },
  },
];

function fixture(c, fields) {
  const record = job({
    sourceId: c.sourceId,
    siteId: c.site.siteId,
    identityScope: c.site.tenantId,
    sourceRecordId: c.sourceRecordId || "1",
    kind: c.kind || "job",
    title: "列表岗位名称",
    company: "列表公司",
    cities: ["南京", "北京"],
    url: "https://jobs.example.com/listed/1",
    applyUrl: "https://jobs.example.com/apply/1",
    jobType: "internship",
    degree: "本科",
    description: null,
    publishedAt: "2026-09-01T00:00:00.000Z",
    deadlineAt: "2026-12-01T00:00:00.000Z",
    salary: {
      raw: "8000–10000元",
      min: null,
      max: null,
      currency: "CNY",
      unit: "unknown",
    },
    extra: { major: "机械工程", sourceExpiry: "2026-12-01" },
    evidence: [{ field: "title", source: "public_list" }],
  });
  const context = {
    sites: [c.site],
    request: async () => ({
      status: 200,
      text: JSON.stringify(c.body(fields)),
    }),
  };
  return { record, context };
}

for (const c of cases) {
  for (const [name, fields] of [
    ["omitted", {}],
    ["blank", c.blank],
  ]) {
    test(
      c.name + " preserves list facts when detail fields are " + name,
      async () => {
        const { record, context } = fixture(c, fields);
        const detail = await c.provider.fetchDetail(record, context);
        assert.equal(detail.title, "列表岗位名称");
        assert.equal(detail.company, "列表公司");
        assert.deepEqual(detail.cities, ["南京", "北京"]);
        assert.equal(detail.url, "https://jobs.example.com/listed/1");
        assert.equal(detail.applyUrl, "https://jobs.example.com/apply/1");
        assert.equal(detail.jobType, "internship");
        assert.equal(detail.degree, "本科");
        assert.equal(detail.publishedAt, "2026-09-01T00:00:00.000Z");
        assert.equal(detail.deadlineAt, "2026-12-01T00:00:00.000Z");
        assert.equal(detail.salary.raw, "8000–10000元");
        assert.equal(detail.extra.major, "机械工程");
        assert.equal(detail.extra.sourceExpiry, "2026-12-01");
        assert.ok(detail.evidence.some((e) => e.source === "public_list"));
        assert.equal(detail.description, requirements);
        assert.equal(detail.sourceRecordId, c.sourceRecordId || "1");
        assert.equal(detail.identityScope, c.site.tenantId);
        assert.equal(detail.kind, c.kind || "job");
        assert.doesNotThrow(() => assertSourceRecord(detail));
        assert.equal(record.description, null);
      },
    );
  }

  test(
    c.name + " accepts facts explicitly supplied by the detail response",
    async () => {
      const { record, context } = fixture(c, c.update);
      const detail = await c.provider.fetchDetail(record, context);
      assert.equal(detail.title, "详情岗位名称");
      assert.deepEqual(detail.cities, ["苏州"]);
      assert.equal(detail.publishedAt, "2026-09-02T00:00:00.000Z");
      assert.equal(detail.description, requirements);
      assert.equal(detail.sourceRecordId, c.sourceRecordId || "1");
      assert.equal(detail.identityScope, c.site.tenantId);
      assert.doesNotThrow(() => assertSourceRecord(detail));
    },
  );
}

test("detail retention still rejects mismatched provider identities", async () => {
  for (const c of cases) {
    const { record, context } = fixture(
      c,
      c.sourceId === "university-91job"
        ? c.kind === "recruitment_notice"
          ? { zpggid: "other" }
          : { zpgwid: "other" }
        : { id: "other" },
    );
    await assert.rejects(c.provider.fetchDetail(record, context), /identity/);
  }
});
