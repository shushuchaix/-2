import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLegacyProvider } from "../../src/sources/adapters/legacy.mjs";
import { normalizeNowcoderJob } from "../../src/sources/nowcoder.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";

const html = readFileSync(
  new URL("../fixtures/nowcoder-detail/443976-reduced.html", import.meta.url),
  "utf8",
);
const state = JSON.parse(
  html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/)[1],
);
const expectedBody =
  "工作内容：负责消防设备巡检和安全检查。\n" +
  "任职要求：本科及以上学历，熟悉消防设备维护。";

function page(mutator) {
  const copy = structuredClone(state);
  mutator(copy);
  return html.replace(
    /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/,
    "window.__INITIAL_STATE__ = " + JSON.stringify(copy) + ";</script>",
  );
}

function fixture(text = html, fields = {}) {
  const record = {
    sourceId: "nowcoder",
    siteId: "nowcoder",
    identityScope: "nowcoder",
    sourceRecordId: "443976",
    sourceRecordIdKind: "authority",
    urlKind: "job_detail",
    kind: "job",
    title: "旧列表标题",
    company: "旧列表单位",
    url: "https://www.nowcoder.com/jobs/detail/443976",
    parserVersion: "legacy-adapter-2",
    description: "旧列表 ext 摘要不能充当详情正文。",
    detailStatus: "complete",
    bodyStatus: "complete",
    extra: { preservedListHint: true },
    ...fields,
  };
  const requests = [],
    claims = [];
  const context = {
    budget: { claimDetail: async (key) => claims.push(key) },
    request: async (url, options) => {
      requests.push({ url, method: options.method || "GET" });
      return { status: 200, text, headers: { "content-type": "text/html" } };
    },
  };
  return { record, context, requests, claims };
}

test("Nowcoder native detail binds identity, returns scoped full body and leaves application unknown", async () => {
  const f = fixture();
  const provider = createLegacyProvider("nowcoder");
  assert.equal(provider.capabilities.body, true);
  const detail = await provider.fetchDetail(f.record, f.context);
  assert.equal(detail.description, expectedBody);
  assert.equal(detail.bodyStatus, "complete");
  assert.equal(detail.detailStatus, "complete");
  assert.equal(detail.retryEligible, false);
  assert.equal(detail.sourceRecordId, "443976");
  assert.equal(detail.url, f.record.url);
  assert.equal(detail.title, "合成消防工程师");
  assert.equal(detail.company, "合成单位");
  assert.equal(detail.extra.preservedListHint, true);
  assert.equal(detail.extra.deliverBegin, "2026-09-30");
  assert.equal(detail.extra.deliverEnd, "2026-12-31");
  assert.equal(detail.startsAt, "2026-09-30T16:00:00.000Z");
  assert.equal(detail.deadlineAt, "2026-12-31T15:59:59.999Z");
  const deadlineEvidence = detail.sourceEvidence.find(
    (e) => e.field === "deadlineAt",
  );
  assert.equal(deadlineEvidence.status, "verified");
  assert.equal(deadlineEvidence.value, "2026-12-31T15:59:59.999Z");
  assert.equal(
    deadlineEvidence.sourcePath,
    "store.jobDetail.detail.deliverEnd",
  );
  assert.equal(
    deadlineEvidence.location.selector,
    ".job-detail-word .job-detail-infos > .deliver-range",
  );
  assert.equal(detail.applyUrl ?? null, null);
  const evidence = assessRecruitmentEvidence({
    record: detail,
    now: Date.parse("2026-10-12T00:00:00Z"),
  });
  assert.equal(evidence.bodyVerified, true);
  assert.equal(evidence.openingStatus, "open");
  assert.equal(evidence.applicationStatus, "unknown");
  assert.deepEqual(f.requests, [{ url: f.record.url, method: "GET" }]);
  assert.equal(f.claims.length, 1);
});

test("Nowcoder list ext remains incomplete even when it contains long text", () => {
  const native = structuredClone(state.store.jobDetail.detail);
  native.ext = JSON.stringify({
    infos: "列表岗位职责，不能证明详情响应。".repeat(250),
    requirements: "任职要求：本科。",
  });
  const record = normalizeNowcoderJob(native);
  assert.equal(record.bodyStatus, "incomplete");
  assert.equal(record.detailStatus, "incomplete");
  assert.ok(record.summary.length <= 241);
});

test("Nowcoder detail retains a long native body and its final hard requirement", async () => {
  const infos = "岗位职责：负责消防设备巡检和安全检查。".repeat(250);
  const requirements = "任职要求：本科及以上学历。必须持有注册消防工程师证书。";
  const f = fixture(
    page((s) => {
      s.store.jobDetail.detail.ext = JSON.stringify({ infos, requirements });
    }),
  );
  const detail = await createLegacyProvider("nowcoder").fetchDetail(
    f.record,
    f.context,
  );
  assert.equal(detail.description, infos + "\n" + requirements);
  assert.ok(detail.description.length > 3000);
  assert.ok(detail.description.endsWith("必须持有注册消防工程师证书。"));
  assert.equal(detail.bodyStatus, "complete");
});

for (const [name, mutate] of [
  [
    "native detail identity differs",
    (s) => {
      s.store.jobDetail.detail.id = 443977;
    },
  ],
  [
    "native detail identity is absent",
    (s) => {
      delete s.store.jobDetail.detail.id;
    },
  ],
  [
    "native page identity differs",
    (s) => {
      s.store.jobDetail.jobId = 443977;
    },
  ],
  [
    "native ext is invalid JSON",
    (s) => {
      s.store.jobDetail.detail.ext = "{broken}";
    },
  ],
  [
    "native ext has a non-text body field",
    (s) => {
      s.store.jobDetail.detail.ext = JSON.stringify({
        infos: {},
        requirements: "本科",
      });
    },
  ],
  [
    "only recommended jobs contain body",
    (s) => {
      s.store.jobDetail.recommendJobs = [s.store.jobDetail.detail];
      delete s.store.jobDetail.detail;
    },
  ],
]) {
  test("Nowcoder rejects " + name, async () => {
    const f = fixture(page(mutate));
    await assert.rejects(
      createLegacyProvider("nowcoder").fetchDetail(f.record, f.context),
      { code: "parse_error", retryable: false },
    );
  });
}

test("Nowcoder rejects an empty scoped body instead of inheriting the previous list text", async () => {
  const f = fixture(
    page((s) => {
      s.store.jobDetail.detail.ext = JSON.stringify({
        infos: " ",
        requirements: "\n",
      });
    }),
  );
  await assert.rejects(
    createLegacyProvider("nowcoder").fetchDetail(f.record, f.context),
    { code: "detail_insufficient", retryable: false },
  );
});

test("Nowcoder DOM body without native detail state is not complete evidence", async () => {
  const f = fixture(html.replace(/<script>[\s\S]*?<\/script>/, ""));
  await assert.rejects(
    createLegacyProvider("nowcoder").fetchDetail(f.record, f.context),
    { code: "parse_error", retryable: false },
  );
});

test("Nowcoder challenge page is reported as captcha", async () => {
  const f = fixture(
    "<html><title>安全验证</title><body>请完成验证码</body></html>",
  );
  await assert.rejects(
    createLegacyProvider("nowcoder").fetchDetail(f.record, f.context),
    { code: "captcha" },
  );
});

test("Nowcoder rejects URL and record identity conflicts before requesting", async () => {
  for (const fields of [
    { sourceRecordId: "443977" },
    { sourceRecordId: null },
    { url: "https://www.nowcoder.com/jobs/school/detail/443976" },
    { url: "https://other.example/jobs/detail/443976" },
  ]) {
    const f = fixture(html, fields);
    await assert.rejects(
      createLegacyProvider("nowcoder").fetchDetail(f.record, f.context),
      { code: "parse_error", retryable: false },
    );
    assert.equal(f.requests.length, 0);
  }
});

test("Nowcoder mismatched visible and native delivery dates invalidate inherited deadlines", async () => {
  const f = fixture(
    page((s) => {
      s.store.jobDetail.detail.deliverEnd = 1796054399999;
    }),
    {
      deadlineAt: "2026-12-31T15:59:59.999Z",
      startsAt: "2026-09-30T16:00:00.000Z",
    },
  );
  const detail = await createLegacyProvider("nowcoder").fetchDetail(
    f.record,
    f.context,
  );
  assert.equal(detail.bodyStatus, "complete");
  assert.equal(detail.deadlineAt ?? null, null);
  assert.equal(detail.startsAt ?? null, null);
  assert.ok(
    detail.evidenceConflicts.some(
      (e) =>
        e.field === "deadlineAt" && e.code === "visible_structured_conflict",
    ),
  );
  assert.equal(
    assessRecruitmentEvidence({
      record: detail,
      now: Date.parse("2026-10-12T00:00:00Z"),
    }).openingStatus,
    "unknown",
  );
});

test("Nowcoder invalid native milliseconds or absent scoped visible window cannot prove opening", async () => {
  for (const text of [
    page((s) => {
      s.store.jobDetail.detail.deliverEnd = "1798732799999";
    }),
    page((s) => {
      s.store.jobDetail.detail.deliverEnd = 0;
    }),
    page((s) => {
      s.store.jobDetail.detail.deliverEnd = Number.MAX_SAFE_INTEGER;
    }),
    html.replace(/<div class="deliver-range">[^<]+<\/div>/, ""),
    html.replace(
      '<h1 class="title">合成消防工程师</h1>',
      '<h1 class="title">另一个岗位</h1>',
    ),
  ]) {
    const f = fixture(text);
    const detail = await createLegacyProvider("nowcoder").fetchDetail(
      f.record,
      f.context,
    );
    assert.equal(detail.description, expectedBody);
    assert.equal(detail.detailStatus, "complete");
    assert.equal(detail.bodyStatus, "complete");
    assert.equal(detail.deadlineAt ?? null, null);
    assert.equal(
      assessRecruitmentEvidence({
        record: detail,
        now: Date.parse("2026-10-12T00:00:00Z"),
      }).openingStatus,
      "unknown",
    );
  }
});

test("Nowcoder status and refresh time do not replace its verified delivery window", async () => {
  const f = fixture(
    page((s) => {
      s.store.jobDetail.detail.status = 3;
      s.store.jobDetail.detail.refreshTime = 1823356799999;
    }),
  );
  const detail = await createLegacyProvider("nowcoder").fetchDetail(
    f.record,
    f.context,
  );
  assert.equal(detail.deadlineAt, "2026-12-31T15:59:59.999Z");
  assert.equal(
    assessRecruitmentEvidence({
      record: detail,
      now: Date.parse("2026-10-12T00:00:00Z"),
    }).openingStatus,
    "open",
  );
});

test("Nowcoder fresh matching window replaces its prior native window conflict", async () => {
  const prior = fixture(
    page((s) => {
      s.store.jobDetail.detail.deliverEnd = 1796054399999;
    }),
  );
  const provider = createLegacyProvider("nowcoder");
  const conflicted = await provider.fetchDetail(prior.record, prior.context);
  assert.equal(
    assessRecruitmentEvidence({
      record: conflicted,
      now: Date.parse("2026-10-12T00:00:00Z"),
    }).openingStatus,
    "unknown",
  );
  const fresh = fixture(html, conflicted);
  const detail = await provider.fetchDetail(fresh.record, fresh.context);
  assert.equal(detail.deadlineAt, "2026-12-31T15:59:59.999Z");
  assert.equal(detail.evidenceConflicts.length, 0);
  assert.equal(
    assessRecruitmentEvidence({
      record: detail,
      now: Date.parse("2026-10-12T00:00:00Z"),
    }).openingStatus,
    "open",
  );
});

test("Nowcoder unverified window clears the old deadline alias as well as deadlineAt", async () => {
  const f = fixture(
    html.replace(/<div class="deliver-range">[^<]+<\/div>/, ""),
    {
      deadline: "2026-01-01T00:00:00Z",
    },
  );
  const detail = await createLegacyProvider("nowcoder").fetchDetail(
    f.record,
    f.context,
  );
  assert.equal(detail.deadline ?? null, null);
  assert.equal(detail.deadlineAt ?? null, null);
  assert.equal(
    assessRecruitmentEvidence({
      record: detail,
      now: Date.parse("2026-10-12T00:00:00Z"),
    }).openingStatus,
    "unknown",
  );
});

test("Nowcoder fresh native window does not erase another origin's deadline conflict", async () => {
  const f = fixture(html, {
    evidenceConflicts: [
      {
        field: "deadlineAt",
        code: "visible_structured_conflict",
        sourceId: "manual",
        sourcePath: "manual.deadlineAt",
      },
    ],
  });
  const detail = await createLegacyProvider("nowcoder").fetchDetail(
    f.record,
    f.context,
  );
  assert.equal(detail.deadlineAt, "2026-12-31T15:59:59.999Z");
  assert.equal(detail.evidenceConflicts[0].sourceId, "manual");
  assert.equal(
    assessRecruitmentEvidence({
      record: detail,
      now: Date.parse("2026-10-12T00:00:00Z"),
    }).openingStatus,
    "unknown",
  );
});
