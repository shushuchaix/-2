import test from "node:test";
import assert from "node:assert/strict";
import { job } from "../helpers/fixtures.mjs";
import {
  relateJobs,
  canonicalizeSourceUrl,
} from "../../src/domain/identity.mjs";
const trusted = (overrides) =>
  job({ sourceRecordIdKind: "authority", urlKind: "job_detail", ...overrides });
for (const [field, value] of Object.entries({
  kind: "company_campaign",
  company: "合成公司子公司",
  title: "高级Java工程师",
  cities: ["北京", "上海"],
  graduationYear: 2028,
  batch: "第二批",
  jobType: "social",
  level: "高级",
  degree: "硕士",
  experience: "三年",
  requiredCertificates: ["注册消防工程师"],
  workMode: "remote",
})) {
  test("conflicts precede authority IDs: " + field, () => {
    const left = trusted({
      batch: "第一批",
      experience: "一年",
      workMode: "onsite",
      level: "初级",
    });
    assert.equal(
      relateJobs(left, { ...left, [field]: value }).relation,
      "distinct",
    );
  });
}
test("generic URLs and weak incomplete text are not proof of one job", () => {
  const listing = job({
    sourceRecordId: null,
    sourceRecordIdKind: "hint",
    urlKind: "campaign",
    url: "https://example.com/careers",
  });
  assert.equal(
    relateJobs(listing, { ...listing, title: "产品工程师" }).relation,
    "distinct",
  );
  const weak = job({
    sourceRecordId: null,
    sourceRecordIdKind: "hint",
    urlKind: "unknown",
    url: null,
    description: "点击查看详情",
  });
  assert.equal(relateJobs(weak, { ...weak }).relation, "possible");
});
test("duplicate classifier exposes confirmed possible distinct with stable reasons", async () => {
  const mod = await import("../../src/domain/job-duplicates.mjs").catch(
    () => null,
  );
  assert.equal(typeof mod?.classifyJobDuplicate, "function");
  assert.equal(
    mod.classifyJobDuplicate(trusted(), trusted()).relation,
    "confirmed",
  );
  assert.equal(
    mod.classifyJobDuplicate(trusted(), trusted({ graduationYear: 2028 }))
      .relation,
    "distinct",
  );
  assert.ok(mod.classifyJobDuplicate(trusted(), trusted()).reasonCodes.length);
});
test("only known tracking parameters disappear, signatures and SPA IDs survive", () => {
  assert.equal(
    canonicalizeSourceUrl(
      "https://x.example/a?sig=s&jobid=2&utm_source=one#/jobs/2",
    ),
    "https://x.example/a?jobid=2&sig=s#/jobs/2",
  );
});
test("reused IDs across years and generated UUIDs have different evidential weight", async () => {
  const { classifyJobDuplicate, jobBusinessFingerprint } = await import(
    "../../src/domain/job-duplicates.mjs"
  );
  const { resolveJobIdentity } = await import("../../src/domain/identity.mjs");
  assert.equal(
    classifyJobDuplicate(
      trusted(),
      trusted({ publishedAt: "2027-10-01T00:00:00.000Z" }),
    ).relation,
    "distinct",
  );
  const manual = job({
    sourceId: "manual",
    sourceRecordIdKind: "generated",
    urlKind: "unknown",
    url: null,
    description:
      "负责消防设施运行和安全检查工作，要求本科消防工程专业，具备机场消防工作经验和相关职业资格。",
  });
  const replay = {
    ...manual,
    sourceRecordId: "another-generated-id",
    retrievedAt: "2026-10-09",
    runId: "other",
  };
  assert.equal(classifyJobDuplicate(manual, replay).relation, "confirmed");
  assert.equal(jobBusinessFingerprint(manual), jobBusinessFingerprint(replay));
  assert.equal(resolveJobIdentity(manual).key, resolveJobIdentity(replay).key);
});
test("old IDs resolve through bounded redirects and ambiguous aliases are rejected", async () => {
  const { resolveJobId, resolveJobIds, resolveApplicationAssociation } =
    await import("../../src/domain/job-resolution.mjs");
  const w = {
    jobs: { kept: {}, other: {} },
    identityAliases: { single: ["old", "kept"], ambiguous: ["old", "other"] },
    jobRedirects: { old: { toJobId: "middle" }, middle: { toJobId: "kept" } },
  };
  assert.equal(resolveJobId(w, "old"), "kept");
  assert.deepEqual(resolveJobIds(w, ["old", "single", "kept"]), ["kept"]);
  assert.throws(
    () => resolveJobId(w, "ambiguous"),
    (e) => e.code === "job_identity_ambiguous",
  );
  assert.equal(
    resolveApplicationAssociation(w, {
      jobId: "legacy",
      legacyJobIds: ["old", "kept"],
    }).status,
    "single",
  );
  assert.equal(
    resolveApplicationAssociation(w, {
      jobId: "legacy",
      legacyJobIds: ["old", "other"],
    }).status,
    "ambiguous",
  );
  assert.throws(
    () =>
      resolveJobId(
        {
          ...w,
          jobRedirects: {
            old: { toJobId: "middle" },
            middle: { toJobId: "old" },
          },
        },
        "old",
      ),
    /cyclic/,
  );
});
