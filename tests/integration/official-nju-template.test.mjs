import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  collectNjuPublicJobs,
  fetchNjuPublicJob,
  isNjuPublicTemplateConfigured,
} from "../../src/sources/adapters/nju-public-career.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";
import { classifyJobDuplicate } from "../../src/domain/job-duplicates.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { evaluateRules } from "../../src/domain/ranking.mjs";
import { profile, target } from "../helpers/fixtures.mjs";

const origin = "https://job.nju.edu.cn",
  listUrl = origin + "/api/career/job/recruitments?page=0&size=50";
const now = Date.parse("2026-10-12T00:00:00Z");
const read = () =>
  JSON.parse(
    fs.readFileSync(
      new URL(
        "../fixtures/official-template-repair/nju-list.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const site = {
  siteId: "official-nju",
  providerId: "official-announcements",
  origin: origin + "/",
  allowedDomains: ["job.nju.edu.cn"],
  status: "candidate",
  verifiedAt: null,
  template: { nativePortal: "nju-public-career-1", listUrl },
};
function replay({
  data = read(),
  detail = null,
  status = 200,
  text = null,
  responseUrl = null,
  cursor = null,
  signal = null,
} = {}) {
  const requests = [];
  const context = {
    cursor,
    signal,
    clock: { now: () => now },
    request: async (url, options) => {
      requests.push({ url, options });
      return {
        status,
        text:
          text ??
          JSON.stringify(url === listUrl ? data : detail || data.content[1]),
        headers: { "content-type": "application/json" },
        url: responseUrl || url,
      };
    },
  };
  return {
    site: structuredClone(site),
    data,
    requests,
    context,
    collect(page = 1) {
      return collectNjuPublicJobs(this.site, page, this.context);
    },
  };
}
const pick = async (f) =>
  (await f.collect()).records.find(
    (r) => r.sourceRecordId === "626000000000000003",
  );
async function detailed(f) {
  return fetchNjuPublicJob(f.site, await pick(f), f.context);
}
function fifty() {
  const d = read(),
    base = d.content[0];
  return {
    content: Array.from({ length: 50 }, (_, i) => ({
      ...structuredClone(base),
      id: "synthetic-ann-" + i,
      positions: [
        { ...structuredClone(base.positions[0]), id: "synthetic-row-" + i },
      ],
    })),
    page: { size: 50, number: 0, totalElements: 100, totalPages: 2 },
  };
}

test("NJU native IDs and canonical per-row URLs preserve independent rows sharing one definition", async () => {
  const f = replay(),
    page = await f.collect();
  assert.equal(page.records.length, 5);
  const [a, b] = page.records;
  assert.equal(a.sourceRecordId, "620905077883801602");
  assert.equal(b.sourceRecordId, "620905077883801603");
  assert.equal(a.sourceRecordIdKind, "authority");
  assert.equal(a.url, origin + "/career/jobs-v2?jobId=620905077883801602");
  assert.equal(b.url, origin + "/career/jobs-v2?jobId=620905077883801603");
  assert.equal(
    a.nativeRecruitmentBinding.positionId,
    b.nativeRecruitmentBinding.positionId,
  );
  assert.equal(a.nativeRecruitmentBinding.recruitmentId, "620905077799915522");
  assert.equal(a.kind, "job");
  assert.equal(a.degree, "博士");
  assert.deepEqual(a.cities, ["天津市"]);
  assert.equal(a.publishedAt, null);
  assert.equal(a.jobType, "campus");
  assert.notEqual(classifyJobDuplicate(a, b).relation, "duplicate");
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.coverageScope, "query");
  assert.equal(f.requests.length, 1);
  assert.equal(f.site.status, "candidate");
  assert.equal(f.site.verifiedAt, null);
});
test("native distinct row IDs sharing a definition remain two jobs through production version ingestion", async (t) => {
  const f = replay(),
    records = (await f.collect()).records.slice(0, 2),
    business = await packageBusinessFixture(t),
    { a } = await business.twoTargets();
  const ids = await business.ingest(
    { packageId: a.packageId, targetRevisionId: a.revisionId },
    records,
  );
  assert.equal(new Set(ids).size, 2);
});
test("NJU shared announcement text and enabled/PUBLISHED do not fill an absent role body", async () => {
  const f = replay(),
    r = (await f.collect()).records[0],
    prepared = prepareRecruitmentRecord(r, now);
  assert.equal(r.bodyIncomplete, true);
  assert.equal(r.bodyStatus, "incomplete");
  assert.equal(r.detailStatus, "incomplete");
  assert.equal(r.sectionCompleteness.duties, false);
  assert.ok(!r.description.includes("招聘公告共用文字"));
  assert.ok(
    r.sourceEvidence.some(
      (e) =>
        e.field === "announcementText" && e.sourceExcerpt.includes("共用文字"),
    ),
  );
  assert.equal(prepared.recruitmentEvidence.bodyVerified, false);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(r.applicationVerification, undefined);
});
test("NJU complete own intro requires separate meaningful duties and qualification sections", async () => {
  const f = replay(),
    r = await pick(f),
    p = prepareRecruitmentRecord(r, now);
  assert.equal(r.bodyStatus, "complete");
  assert.equal(r.sectionCompleteness.duties, true);
  assert.equal(r.sectionCompleteness.qualification, true);
  assert.equal(p.recruitmentEvidence.bodyVerified, true);
  assert.equal(p.recruitmentEvidence.openingStatus, "open");
  assert.equal(p.deadlineAt, "2026-10-31T15:59:59.999Z");
  assert.equal(r.applyUrl, null);
  assert.equal(p.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(r.publishedAt, null);
});
for (const [name, intro] of [
  [
    "only qualifications",
    "任职要求：\n本科消防工程专业，应具备良好的沟通协调能力，工作经验不限。",
  ],
  [
    "only duties",
    "岗位职责：\n负责消防设施巡检、维护管理和应急演练组织，记录设备工作情况。",
  ],
  [
    "empty qualification section",
    "岗位职责：\n负责消防设施巡检、维护管理和应急演练组织，记录设备工作情况。\n任职要求：\n",
  ],
  [
    "headings in a narrative paragraph",
    "本工作会整理岗位职责：文档以及任职要求：材料，属于普通介绍，不能证明两段职责和条件。",
  ],
  [
    "hidden qualification",
    "<p>岗位职责：</p><p>负责消防设施巡检、维护管理和应急演练组织，记录设备工作情况。</p><div hidden><p>任职要求：</p><p>本科消防工程专业，应具备良好的沟通协调能力，工作经验不限。</p></div>",
  ],
  [
    "repeated qualification sections",
    "岗位职责：\n负责消防设施巡检、维护管理和应急演练组织，记录设备工作情况。\n任职要求：\n本科消防工程专业，应具备良好的沟通协调能力。\n任职要求：\n硕士及以上学历，应具备良好的沟通协调能力。",
  ],
])
  test(`NJU ${name} remains incomplete`, async () => {
    const data = read();
    data.content[1].positions[0].position.intro = intro;
    const r = await pick(replay({ data }));
    assert.equal(r.bodyIncomplete, true);
    assert.equal(
      prepareRecruitmentRecord(r, now).recruitmentEvidence.bodyVerified,
      false,
    );
  });
test("NJU enumerated roles stay aggregate and no-row announcements remain single notices", async () => {
  const f = replay(),
    page = await f.collect();
  const aggregate = page.records.find(
    (r) => r.sourceRecordId === "recruit_recruitdata_post_synthetic",
  );
  assert.equal(aggregate.kind, "recruitment_notice");
  assert.equal(aggregate.bodyIncomplete, true);
  assert.equal(aggregate.rowAmbiguous, true);
  const notice = page.records.find(
    (r) => r.sourceRecordId === "synthetic-notice-parent",
  );
  assert.equal(notice.kind, "recruitment_notice");
  assert.ok(notice.description.includes("未提供任何逐岗职责"));
  assert.equal(notice.nativeRecruitmentBinding.jobRowId, null);
});
test("NJU same parent detail binds row, definition, title, company and canonical URL", async () => {
  const f = replay(),
    r = await detailed(f);
  assert.equal(r.bodyStatus, "complete");
  assert.equal(r.sourceRecordId, "626000000000000003");
  assert.equal(
    f.requests[1].url,
    origin + "/api/career/job/recruitments/626000000000000001",
  );
  assert.equal(r.url, origin + "/career/jobs-v2?jobId=626000000000000003");
  assert.equal(r.publishedAt, null);
});
test("NJU real-shaped empty detail rows retain incompleteness despite long common announcement", async () => {
  const data = read(),
    f = replay({ data, detail: data.content[0] }),
    r = (await f.collect()).records[0],
    result = await fetchNjuPublicJob(f.site, r, f.context);
  assert.equal(result.bodyIncomplete, true);
  assert.equal(result.degree, "博士");
  assert.equal(result.publishedAt, null);
  assert.equal(
    f.requests[1].url,
    origin + "/api/career/job/recruitments/620905077799915522",
  );
});
for (const [name, mutate] of [
  [
    "parent ID",
    (e) => {
      e.id = "other-parent";
    },
  ],
  [
    "row ID",
    (e) => {
      e.positions[0].id = "other-row";
    },
  ],
  [
    "definition ID",
    (e) => {
      e.positions[0].position.id = "other-definition";
    },
  ],
  [
    "title",
    (e) => {
      e.positions[0].position.name = "其他岗位";
    },
  ],
  [
    "company ID",
    (e) => {
      e.company.id = "other-company";
    },
  ],
  [
    "duplicate matching row",
    (e) => {
      e.positions.push(structuredClone(e.positions[0]));
    },
  ],
])
  test(`NJU detail rejects mismatched ${name}`, async () => {
    const data = read(),
      detail = structuredClone(data.content[1]);
    mutate(detail);
    await assert.rejects(detailed(replay({ data, detail })), {
      code: "detail_identity_mismatch",
    });
  });
for (const [name, mutate] of [
  [
    "foreign site",
    (s) => {
      s.siteId = "other-school";
    },
  ],
  [
    "foreign provider",
    (s) => {
      s.providerId = "other-provider";
    },
  ],
  [
    "foreign origin",
    (s) => {
      s.origin = "https://jobs.example.org";
    },
  ],
  [
    "unconfigured portal",
    (s) => {
      delete s.template.nativePortal;
    },
  ],
  [
    "unproved list path",
    (s) => {
      s.template.listUrl = origin + "/api/guessed/jobs";
    },
  ],
])
  test(`NJU ${name} is refused before a request`, async () => {
    const f = replay();
    mutate(f.site);
    await assert.rejects(f.collect(), { code: "template_not_configured" });
    assert.equal(f.requests.length, 0);
  });
for (const [name, mutate] of [
  [
    "row native ID",
    (d) => {
      delete d.content[0].positions[0].id;
    },
  ],
  [
    "numeric unsafe ID",
    (d) => {
      d.content[0].positions[0].id = 620905077883801602;
    },
  ],
  [
    "position definition ID",
    (d) => {
      delete d.content[0].positions[0].position.id;
    },
  ],
  [
    "duplicate row ID",
    (d) => {
      d.content[0].positions[1].id = d.content[0].positions[0].id;
    },
  ],
  [
    "duplicate parent ID",
    (d) => {
      d.content[1].id = d.content[0].id;
    },
  ],
  [
    "wrong content shape",
    (d) => {
      d.content = {};
    },
  ],
  [
    "wrong page number",
    (d) => {
      d.page.number = 1;
    },
  ],
  [
    "wrong total pages",
    (d) => {
      d.page.totalPages = 2;
    },
  ],
  [
    "wrong page size",
    (d) => {
      d.page.size = 20;
    },
  ],
])
  test(`NJU malformed ${name} fails the native contract`, async () => {
    const data = read();
    mutate(data);
    await assert.rejects(replay({ data }).collect(), { code: "parse_error" });
  });
for (const [name, status, text, code] of [
  [
    "anonymous authorization required",
    401,
    '{"message":"unauthorized"}',
    "restricted",
  ],
  ["forbidden", 403, "denied", "restricted"],
  ["HTML shell", 200, "<html><title>招聘</title></html>", "parse_error"],
  [
    "challenge",
    200,
    "<html><title>安全验证</title><p>请完成人机验证</p></html>",
    "captcha",
  ],
  ["non JSON response", 200, "not-json", "parse_error"],
])
  test(`NJU ${name} is never accepted as jobs`, async () => {
    await assert.rejects(replay({ status, text }).collect(), { code });
  });
test("NJU response URL cannot redirect native JSON onto an unrelated origin", async () => {
  await assert.rejects(
    replay({ responseUrl: "https://jobs.example.org/list" }).collect(),
    { code: "detail_identity_mismatch" },
  );
});
test("NJU paging is one request at a time with a persistable scope-bound zero-based cursor", async () => {
  const f = replay({ data: fifty() }),
    first = await f.collect();
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor.page, 2);
  assert.equal(f.requests.length, 1);
  const data = fifty();
  data.content = data.content
    .slice(0, 1)
    .map((e) => ({
      ...e,
      id: "final-ann",
      positions: [{ ...e.positions[0], id: "final-row" }],
    }));
  data.page = { size: 50, number: 1, totalElements: 51, totalPages: 2 };
  const second = replay({ data, cursor: first.nextCursor });
  second.context.request = async (url, options) => {
    second.requests.push({ url, options });
    return { status: 200, text: JSON.stringify(data), headers: {}, url };
  };
  const last = await second.collect(2);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.equal(second.requests.length, 1);
  assert.equal(
    second.requests[0].url,
    origin + "/api/career/job/recruitments?page=1&size=50",
  );
  assert.ok(JSON.stringify(first.nextCursor).length < 4096);
});
test("NJU repeated native page content is rejected as a pagination loop", async () => {
  const f = replay({ data: fifty() }),
    first = await f.collect(),
    data = fifty();
  data.page.number = 1;
  const second = replay({ data, cursor: first.nextCursor });
  second.context.request = async (url) => ({
    status: 200,
    text: JSON.stringify(data),
    headers: {},
    url,
  });
  await assert.rejects(second.collect(2), { code: "pagination_loop" });
});
test("NJU page two without its matching native cursor is rejected before requesting", async () => {
  const f = replay({ data: fifty() });
  await assert.rejects(f.collect(2), { code: "collection_cursor_invalid" });
  assert.equal(f.requests.length, 0);
});
test("NJU unknown deadlines stay unknown regardless of published flags and scheduling timestamps", async () => {
  const data = read();
  data.content[1].deadline = null;
  const r = await pick(replay({ data })),
    p = prepareRecruitmentRecord(r, now);
  assert.equal(r.deadlineAt, null);
  assert.equal(p.recruitmentEvidence.openingStatus, "unknown");
  assert.equal(r.publishedAt, null);
});
test("NJU malformed calendar deadline stays unknown rather than rolling into another month", async () => {
  const data = read();
  data.content[1].deadline = "2026-02-31";
  const r = await pick(replay({ data }));
  assert.equal(r.deadlineAt, null);
  assert.equal(
    prepareRecruitmentRecord(r, now).recruitmentEvidence.openingStatus,
    "unknown",
  );
});
test("NJU explicit common deadline conflicting with parent metadata blocks a complete row", async () => {
  const data = read();
  data.content[1].intro = "<p>所有岗位报名截止：2026年10月20日。</p>";
  const r = await pick(replay({ data }));
  assert.equal(r.bodyIncomplete, true);
  assert.ok(r.evidenceConflicts.length);
  assert.notEqual(
    prepareRecruitmentRecord(r, now).recruitmentEvidence.openingStatus,
    "open",
  );
});
test("NJU explicit common degree conflicting with row education remains unresolved", async () => {
  const data = read();
  data.content[1].intro =
    "<p>所有岗位均要求硕士及以上学历，其他条件详见岗位正文。</p>";
  const r = await pick(replay({ data }));
  assert.equal(r.bodyIncomplete, true);
  assert.ok(r.evidenceConflicts.some((c) => c.field === "degree"));
});
test("NJU an aborted context performs no source request", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = replay({ signal: controller.signal });
  await assert.rejects(f.collect());
  assert.equal(f.requests.length, 0);
});

test("NJU proven page-one string IDs and duplicate role text remain one independent complete role", async () => {
  const first = await replay({ data: fifty() }).collect();
  const data = JSON.parse(
    fs.readFileSync(
      new URL(
        "../fixtures/official-template-repair/nju-page1-reduced.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const f = replay({ data, cursor: first.nextCursor });
  f.context.request = async (url) => ({
    status: 200,
    text: JSON.stringify(data),
    url,
  });
  const page = await f.collect(2),
    r = page.records.find((r) => r.kind === "job");
  assert.equal(page.records.length, 2);
  assert.equal(
    r.sourceRecordId,
    "recruit_recruitdata_post_5b5bf32c9f6f1963019f8889eb4e01fd",
  );
  assert.equal(r.url, origin + "/career/jobs-v2?jobId=" + r.sourceRecordId);
  assert.equal(r.bodyStatus, "complete");
  assert.equal(r.description.split("岗位职责：").length - 1, 1);
  assert.equal(r.description.split("任职资格：").length - 1, 1);
  assert.equal(r.publishedAt, null);
  assert.equal(r.applyUrl, null);
  assert.equal(
    prepareRecruitmentRecord(r, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
  const notice = page.records.find((r) => r.kind === "recruitment_notice");
  assert.equal(notice.sourceRecordId, data.content[1].id);
  assert.equal(notice.unresolvedRowCount, 2);
  assert.equal(notice.bodyIncomplete, true);
  assert.equal(notice.rowAmbiguous, true);
  assert.equal(notice.nativeRecruitmentBinding.jobRowId, null);
  assert.equal(notice.nativeRecruitmentBinding.positionId, null);
  assert.ok(
    notice.sourceEvidence.some(
      (e) => e.field === "unresolvedJobRows" && e.value.length === 2,
    ),
  );
});
test("NJU explicit null position rows preserve a parent notice alongside healthy rows without invented job IDs", async () => {
  const data = read();
  data.content[1].positions.push({ id: "nullable-role-row", position: null });
  const page = await replay({ data }).collect(),
    jobs = page.records.filter(
      (r) => r.nativeRecruitmentBinding.recruitmentId === data.content[1].id,
    );
  assert.equal(jobs.length, 2);
  assert.equal(jobs.filter((r) => r.kind === "job").length, 1);
  const notice = jobs.find((r) => r.kind === "recruitment_notice");
  assert.equal(notice.sourceRecordId, data.content[1].id);
  assert.equal(notice.unresolvedRowCount, 1);
  assert.ok(
    !page.records.some((r) => r.sourceRecordId === "nullable-role-row"),
  );
});
test("NJU missing position property remains malformed rather than guessing a nullable schema", async () => {
  const data = read();
  delete data.content[1].positions[0].position;
  await assert.rejects(replay({ data }).collect(), { code: "parse_error" });
});
test("NJU observed id/updatedAt-only orphan rows are notice evidence and never publication timestamps", async () => {
  const data = read();
  data.content[1].positions = [
    { id: "orphan-native-row", updatedAt: "2026-10-12 00:00:00" },
  ];
  const r = (await replay({ data }).collect()).records.find(
    (r) => r.sourceRecordId === data.content[1].id,
  );
  assert.ok(r);
  assert.equal(r.kind, "recruitment_notice");
  assert.equal(r.unresolvedRowCount, 1);
  assert.equal(r.publishedAt, null);
  assert.equal(r.bodyIncomplete, true);
});
test("NJU orphan rows still require safe unique native IDs and supported metadata shape", async () => {
  for (const orphan of [
    { updatedAt: "2026-10-12" },
    { id: "orphan-row", updatedAt: 123 },
    { id: "orphan-row", guessedRole: "消防" },
  ]) {
    const data = read();
    data.content[1].positions = [orphan];
    await assert.rejects(replay({ data }).collect(), { code: "parse_error" });
  }
});
test("NJU refreshed detail strips stale application availability while preserving local linkage", async () => {
  const f = replay(),
    r = await pick(f);
  r.jobId = "synthetic-local-job";
  r.applicationVerification = {
    status: "available",
    formVerified: true,
    checkedAt: "2026-10-12T00:00:00Z",
  };
  const result = await fetchNjuPublicJob(f.site, r, f.context);
  assert.equal(result.jobId, r.jobId);
  assert.equal(result.applicationVerification, undefined);
  assert.equal(
    prepareRecruitmentRecord(result, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
});
for (const id of [
  "x".repeat(129),
  "unsafe/id",
  "unsafe.id",
  "unsafe?id=1",
  "unsafe#fragment",
  "unsafe%2fid",
])
  test(`NJU unsafe or oversized ID (${id.slice(0, 14)}) cannot become a native URL`, async () => {
    const data = read();
    data.content[1].positions[0].id = id;
    await assert.rejects(replay({ data }).collect(), { code: "parse_error" });
  });
test("NJU ID contract accepts a safe 128-character string without numeric conversion", async () => {
  const data = read();
  data.content[1].positions[0].id = "s".repeat(128);
  const page = await replay({ data }).collect();
  assert.ok(page.records.some((r) => r.sourceRecordId === "s".repeat(128)));
});
test("NJU shared announcement application links remain candidates instead of row-owned entries", async () => {
  const data = read();
  data.content[1].intro =
    '<p><a href="https://apply.example.org/all-jobs">投递简历</a></p>';
  const r = await pick(replay({ data }));
  assert.equal(r.applyUrl, null);
  assert.ok(
    r.applicationCandidates.includes("https://apply.example.org/all-jobs"),
  );
  assert.ok(
    r.sourceEvidence.some(
      (e) =>
        e.sourceKind === "native_announcement_application_candidate" &&
        e.status === "unknown",
    ),
  );
  assert.equal(
    prepareRecruitmentRecord(r, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
});
test("NJU explicit own role application link stays an unverified candidate until a fresh form check", async () => {
  const data = read();
  data.content[1].positions[0].position.intro +=
    '<p><a href="/career/job/application/synthetic-row">申请职位</a></p>';
  const r = await pick(replay({ data }));
  assert.equal(r.applyUrl, origin + "/career/job/application/synthetic-row");
  assert.equal(r.applicationVerification, undefined);
  assert.equal(
    prepareRecruitmentRecord(r, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
});
test("NJU configuration predicate is pure and uses the same strict native gate as collection", () => {
  assert.equal(isNjuPublicTemplateConfigured(site), true);
  for (const bad of [
    null,
    {},
    { ...site, siteId: "other-school" },
    { ...site, origin: origin + "/other" },
    { ...site, providerId: "other-provider" },
    { ...site, allowedDomains: "job.nju.edu.cn" },
    { ...site, template: { ...site.template, nativePortal: "guessed" } },
    {
      ...site,
      template: { ...site.template, listUrl: origin + "/api/guessed" },
    },
  ])
    assert.equal(isNjuPublicTemplateConfigured(bad), false);
});
for (const [name, orphan] of [
  ["null definition", { position: null }],
  ["missing definition", { updatedAt: "2026-10-12 00:00:00" }],
])
  test(`NJU detail that lost its previously bound ${name} returns a typed identity failure`, async () => {
    const data = read(),
      detail = structuredClone(data.content[1]);
    detail.positions[0] = { id: detail.positions[0].id, ...orphan };
    await assert.rejects(detailed(replay({ data, detail })), {
      code: "detail_identity_mismatch",
    });
  });
test("NJU observed row-level conditions and age remain own evidence without borrowing parent constraints", async () => {
  const data = read();
  data.content[1].positions[0].recruitmentCondition =
    "必须持有消防设施操作员证书，满足本岗位要求。";
  data.content[1].positions[0].ageRequirement = "30周岁及以下";
  const r = await pick(replay({ data }));
  assert.ok(r.description.includes("30周岁及以下"));
  assert.ok(
    r.sourceEvidence.some(
      (e) =>
        e.field === "rowRequirements" &&
        e.location.jsonPath === "positions[].recruitmentCondition",
    ),
  );
  assert.ok(
    r.sourceEvidence.some(
      (e) =>
        e.field === "ageRequirement" &&
        e.location.jsonPath === "positions[].ageRequirement",
    ),
  );
});
test("NJU parent-only notice prose cannot claim a complete job body", async () => {
  const r = (await replay().collect()).records.find(
    (r) => r.sourceRecordId === "synthetic-notice-parent",
  );
  assert.equal(r.kind, "recruitment_notice");
  assert.equal(r.bodyIncomplete, true);
  assert.equal(
    prepareRecruitmentRecord(r, now).recruitmentEvidence.bodyVerified,
    false,
  );
});
const eligibleProfile = () =>
  profile({
    education: "本科",
    major: "消防工程",
    graduationYear: 2027,
    experienceYears: 0,
    certificates: [],
    explicitFacts: { certificates: true },
  });
const fireTarget = () =>
  target({ roles: ["消防"], jobTypes: [], cityMode: "any" });
test("NJU same-parent explicit noon refines a date-only deadline and cannot stay open after noon", async () => {
  const data = read();
  data.content[1].intro = "<p>本次招聘报名截止时间：2026年10月31日12:00。</p>";
  const at = Date.parse("2026-10-31T06:00:00.000Z"),
    f = replay({ data });
  f.context.clock = { now: () => at };
  const r = await pick(f),
    p = prepareRecruitmentRecord(r, at);
  assert.equal(r.deadlineAt, "2026-10-31T04:00:00.000Z");
  assert.equal(p.recruitmentEvidence.openingStatus, "expired");
  assert.ok(
    r.sourceEvidence.some(
      (e) =>
        e.field === "deadlineAt" &&
        e.location.jsonPath === "intro" &&
        e.appliesTo.recruitmentId === r.nativeRecruitmentBinding.recruitmentId,
    ),
  );
});
for (const [name, intro] of [
  [
    "numbered paragraphs",
    "<p>所有应聘人员均须具备以下条件：</p><p>1. 必须持有注册消防工程师证书。</p><p>2. 必须具备五年以上相关工作经验。</p>",
  ],
  [
    "Chinese numbered paragraphs",
    "<p>全部应聘者必须满足下列条件：</p><p>一、必须持有注册消防工程师证书。</p><p>二、必须具备五年以上相关工作经验。</p>",
  ],
  [
    "native HTML list",
    "<p>所有应聘人员均须具备以下条件：</p><ol><li>必须持有注册消防工程师证书。</li><li>必须具备五年以上相关工作经验。</li></ol>",
  ],
  [
    "inherited mandatory qualification",
    "<p>所有应聘人员均须具备以下条件：</p><p>1. 注册消防工程师证书。</p><p>2. 五年以上相关工作经验。</p>",
  ],
])
  test(`NJU universal requirement heading scopes its ${name} without filling the role body`, async () => {
    const data = read();
    data.content[1].intro = intro;
    const r = await pick(replay({ data })),
      p = prepareRecruitmentRecord(r, now);
    assert.equal(r.bodyIncomplete, true);
    assert.equal(
      evaluateRules(p, eligibleProfile(), fireTarget(), { now }).qualification
        .status,
      "unknown",
    );
    assert.ok(
      r.conditions.filter((c) => c.type === "shared_requirements").length >= 2,
    );
    assert.ok(!r.description.includes("五年以上"));
    assert.ok(
      r.sourceEvidence.some(
        (e) =>
          e.sourceKind === "public_api_shared_requirement" &&
          /以下|下列/.test(e.sourceExcerpt),
      ),
    );
    assert.equal(
      evaluateRules(p, eligibleProfile(), fireTarget(), { now }).recommended,
      false,
    );
  });
for (const [name, intro] of [
  [
    "preferred item",
    "<p>所有应聘人员均须具备以下条件：</p><p>1. 持有注册消防工程师证书者优先。</p>",
  ],
  [
    "nonmandatory item",
    "<p>所有应聘人员均须具备以下条件：</p><p>1. 不要求持有注册消防工程师证书。</p>",
  ],
  [
    "new section ends scope",
    "<p>所有应聘人员均须具备以下条件：</p><p>1. 通过报名网站提交材料。</p><p>二、研发岗位条件：</p><p>1. 必须持有注册消防工程师证书。</p>",
  ],
  [
    "unrelated role heading",
    "<p>研发岗位应聘人员均须具备以下条件：</p><p>1. 必须持有注册消防工程师证书。</p>",
  ],
])
  test(`NJU ${name} does not inherit a universal mandatory qualification`, async () => {
    const data = read();
    data.content[1].intro = intro;
    const r = await pick(replay({ data }));
    assert.equal(r.bodyIncomplete, false);
    assert.ok(!r.conditions.some((c) => c.type === "shared_requirements"));
    assert.equal(
      evaluateRules(r, eligibleProfile(), fireTarget(), { now }).qualification
        .status,
      "pass",
    );
  });
for (const [name, common] of [
  ["mandatory certificate", "所有岗位应聘人员必须持有注册消防工程师证书。"],
  ["mandatory experience", "所有岗位应聘人员必须具备5年以上相关工作经验。"],
  ["mandatory graduation", "所有岗位仅接受2026届毕业生。"],
  ["all applicants age", "应聘人员均须满足年龄30周岁及以下要求。"],
  ["all positions qualification", "全部职位要求取得相应职业资格证书。"],
])
  test(`NJU ${name} remains a shared unresolved condition without a same-row proof`, async () => {
    const data = read();
    data.content[1].intro = "<p>" + common + "</p>";
    const r = await pick(replay({ data }));
    const evaluation = evaluateRules(r, eligibleProfile(), fireTarget(), {
      now,
    });
    assert.equal(r.bodyIncomplete, true);
    assert.equal(evaluation.qualification.status, "unknown");
    assert.ok(
      r.evidenceConflicts.some(
        (c) => c.code === "nju_shared_conditions_unresolved",
      ),
    );
    assert.ok(
      r.conditions.some(
        (c) =>
          c.origin === "structured_source" &&
          c.migrationStatus === "needs_review" &&
          c.required,
      ),
    );
    assert.ok(!r.description.includes(common));
    const e = r.sourceEvidence.find(
      (e) =>
        e.sourceKind === "public_api_shared_requirement" &&
        e.sourceExcerpt.includes(common.replace(/[。]$/, "")),
    );
    assert.ok(e);
    assert.equal(e.location.jsonPath, "intro");
    assert.equal(e.appliesTo.jobRowId, r.sourceRecordId);
    assert.equal(e.appliesTo.sharedCondition, true);
    const prepared = prepareRecruitmentRecord(r, now);
    assert.equal(
      evaluateRules(prepared, eligibleProfile(), fireTarget(), { now })
        .qualification.status,
      "unknown",
    );
    assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  });
for (const [name, common] of [
  ["certificate preference", "所有岗位持有注册消防工程师证书者优先。"],
  ["experience preference", "所有岗位有5年以上相关工作经验者优先考虑。"],
  ["nonmandatory certificate", "所有岗位不要求持有注册消防工程师证书。"],
  ["unrelated role requirement", "研发岗位应聘人员必须具备5年以上工作经验。"],
  [
    "company introduction",
    "公司拥有全部岗位的职业资格培训体系，鼓励员工提升技能。",
  ],
  ["company employees", "所有岗位的在职员工已经持有注册消防工程师证书。"],
  [
    "application procedure",
    "所有岗位必须通过报名网站提交简历，提交后等待通知。",
  ],
])
  test(`NJU ${name} does not create a parent-wide qualification barrier`, async () => {
    const data = read();
    data.content[1].intro = "<p>" + common + "</p>";
    const r = await pick(replay({ data }));
    assert.equal(r.bodyIncomplete, false);
    assert.equal(
      evaluateRules(r, eligibleProfile(), fireTarget(), { now }).qualification
        .status,
      "pass",
    );
    assert.ok(!r.conditions?.some((c) => c.type === "shared_requirements"));
  });
test("NJU identical literal shared requirement in own qualification is evaluated through that own proof", async () => {
  const common = "所有岗位应聘人员必须持有注册消防工程师证书";
  const data = read();
  data.content[1].intro = "<p>" + common + "。</p>";
  data.content[1].positions[0].position.intro += "<p>" + common + "。</p>";
  const r = await pick(replay({ data }));
  assert.equal(r.bodyIncomplete, false);
  assert.equal(
    evaluateRules(r, eligibleProfile(), fireTarget(), { now }).qualification
      .status,
    "fail",
  );
});
for (const [name, change] of [
  [
    "disabled",
    (e) => {
      e.enabled = false;
    },
  ],
  [
    "unknown status",
    (e) => {
      e.status = "SYNTHETIC_UNKNOWN";
    },
  ],
  [
    "missing enabled",
    (e) => {
      delete e.enabled;
    },
  ],
  [
    "missing status",
    (e) => {
      delete e.status;
    },
  ],
])
  test(`NJU ${name} cannot become open using a future deadline`, async () => {
    const data = read();
    change(data.content[1]);
    const r = await pick(replay({ data })),
      p = prepareRecruitmentRecord(r, now);
    assert.equal(r.bodyIncomplete, true);
    assert.equal(p.recruitmentEvidence.openingStatus, "unknown");
    assert.ok(
      r.evidenceConflicts.some(
        (c) => c.code === "nju_publication_state_unresolved",
      ),
    );
    assert.notEqual(p.recruitmentEvidence.openingStatus, "closed");
  });
test("NJU its last supported page explicitly reports limited coverage instead of an unusable page-21 cursor", async () => {
  const data = fifty();
  data.page = { size: 50, number: 19, totalElements: 3056, totalPages: 62 };
  const cursor = {
    page: 20,
    nju: {
      siteId: site.siteId,
      origin,
      seenPages: Array.from({ length: 19 }, (_, i) =>
        String(i + 1).padStart(64, "0"),
      ),
    },
  };
  const f = replay({ data, cursor });
  f.context.request = async (url) => {
    f.requests.push({ url });
    return { status: 200, text: JSON.stringify(data), url };
  };
  const page = await f.collect(20);
  assert.equal(page.records.length, 50);
  assert.equal(f.requests.length, 1);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.coverageScope, "limited");
  assert.equal(page.truncationReason, "page_limit");
});
