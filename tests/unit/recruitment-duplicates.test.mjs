import test from "node:test";
import assert from "node:assert/strict";
import { classifyJobDuplicate } from "../../src/domain/job-identity.mjs";
test("age endpoint and alternative certificate grades remain distinct conflict evidence", () => {
  const base = {
    kind: "job",
    company: "合成消防公司",
    title: "消防工程师",
    sourceId: "example",
    siteId: "sample",
    sourceRecordId: "123",
    sourceRecordIdKind: "authority",
    url: "https://example.org/job/123",
    urlKind: "job_detail",
    description: "本科，消防工程专业。",
  };
  const age = {
    type: "age",
    operator: "minimum",
    values: [20],
    required: true,
    minimumInclusive: true,
  };
  assert.equal(
    classifyJobDuplicate(
      { ...base, conditions: [age] },
      { ...base, conditions: [{ ...age, minimumInclusive: false }] },
    ).relation,
    "possible",
  );
  const cert = {
    type: "certificate",
    operator: "any",
    values: ["注册消防工程师", "注册安全工程师"],
    required: true,
    certificateOptions: [
      { name: "注册消防工程师", grade: "一级" },
      { name: "注册安全工程师", grade: "中级" },
    ],
  };
  assert.equal(
    classifyJobDuplicate(
      { ...base, conditions: [cert] },
      {
        ...base,
        conditions: [
          {
            ...cert,
            certificateOptions: [
              { name: "注册消防工程师", grade: "二级" },
              { name: "注册安全工程师", grade: "中级" },
            ],
          },
        ],
      },
    ).relation,
    "possible",
  );
});
import { job } from "../helpers/fixtures.mjs";
import {
  compareRecruitmentFacts,
  findDuplicateCandidates,
  mergeRecruitmentFacts,
} from "../../src/domain/duplicate-candidates.mjs";
import { resolveJobIdentity } from "../../src/domain/identity.mjs";
import { jobFactHash } from "../../src/domain/job-facts.mjs";
test("qualification conflicts precede authority identity and employment differs independently of work mode", () => {
  const a = job({
    major: "消防工程",
    employmentMode: "direct",
    workMode: "onsite",
  });
  assert.equal(
    compareRecruitmentFacts(a, { ...a, major: "机械工程" }).decision,
    "review",
  );
  assert.equal(
    compareRecruitmentFacts(a, { ...a, employmentMode: "dispatch" }).decision,
    "distinct",
  );
  assert.notEqual(
    resolveJobIdentity(a).key,
    resolveJobIdentity({ ...a, major: "机械工程" }).key,
  );
  assert.notEqual(jobFactHash(a), jobFactHash({ ...a, major: "机械工程" }));
  const b = job({
    requiredCertificates: [
      { name: "注册消防工程师", grade: "一级", required: true },
    ],
  });
  assert.equal(
    compareRecruitmentFacts(b, {
      ...b,
      requiredCertificates: [
        { name: "注册消防工程师", grade: "二级", required: true },
      ],
    }).decision,
    "review",
  );
});
test("verified official job locator can connect a social mirror; unverified or shared apply URL cannot", () => {
  const a = job(),
    b = job({
      sourceId: "wechat",
      sourceRecordId: "article:1",
      sourceRecordIdKind: "generated",
      urlKind: "notice_detail",
      url: "https://mp.weixin.qq.com/s/abc",
      verifiedJobLocator: {
        url: a.url,
        kind: "job_detail",
        title: a.title,
        company: a.company,
        verified: true,
      },
    });
  assert.equal(compareRecruitmentFacts(a, b).decision, "same");
  assert.equal(
    compareRecruitmentFacts(a, {
      ...b,
      verifiedJobLocator: { ...b.verifiedJobLocator, verified: false },
    }).decision,
    "review",
  );
  assert.equal(
    compareRecruitmentFacts(a, {
      ...b,
      verifiedJobLocator: {
        ...b.verifiedJobLocator,
        kind: "shared_application",
      },
    }).decision,
    "review",
  );
  assert.equal(
    compareRecruitmentFacts(a, {
      ...b,
      batch: "第二批",
      verifiedJobLocator: b.verifiedJobLocator,
    }).decision,
    "review",
  );
  const candidates = findDuplicateCandidates({
    records: [b],
    existingJobs: [{ jobId: "j", canonical: a }],
  });
  assert.equal(candidates.length, 1);
});
test("incomplete refresh retains complete fields and all source evidence without duplicating replays", () => {
  const a = job({
      detailStatus: "complete",
      sourceEvidence: [
        {
          field: "degree",
          sourceUrl: "https://jobs.example.com/1",
          sourceExcerpt: "本科",
          status: "verified",
          evidenceId: "e1",
        },
      ],
    }),
    b = job({
      description: null,
      degree: null,
      cities: [],
      detailStatus: "pending",
      sourceId: "wechat",
      sourceEvidence: [
        {
          field: "company",
          sourceUrl: "https://mp.weixin.qq.com/s/abc",
          sourceExcerpt: a.company,
          status: "verified",
          evidenceId: "e2",
        },
      ],
    });
  const merged = mergeRecruitmentFacts(a, b);
  assert.equal(merged.description, a.description);
  assert.equal(merged.degree, "本科");
  assert.deepEqual(merged.cities, ["北京"]);
  assert.equal(merged.sourceEvidence.length, 2);
  assert.equal(mergeRecruitmentFacts(merged, b).sourceEvidence.length, 2);
  assert.notEqual(jobFactHash(merged), jobFactHash(a));
});
