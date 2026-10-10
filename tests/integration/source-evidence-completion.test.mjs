import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ncss from "../../src/sources/adapters/ncss.mjs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import {
  extractApplicationLinks,
  createPagedProvider,
} from "../../src/sources/adapters/shared.mjs";
import {
  prepareApplicationCheck,
  prepareRecruitmentRecord,
} from "../../src/domain/recruitment-evidence.mjs";
import { createCollectionRefresh } from "../../src/application/collection-refresh.mjs";
import { createJobVerificationService } from "../../src/application/job-verification-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { contentKey } from "../../src/sources/content-queue.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";

test("application discovery distinguishes explicit public entry, placeholder, login and ambiguous entries", () => {
  const record = job(),
    opts = { baseUrl: record.url, record };
  const explicit = extractApplicationLinks(
    '<a href="/apply">在线报名</a>',
    opts,
  );
  assert.equal(explicit.applyUrl, "https://jobs.example.com/apply");
  assert.equal(explicit.sourceEvidence[0].field, "applyUrl");
  for (const html of [
    '<a href="#">投递简历</a>',
    '<a href="/login">登录后投递</a>',
    '<nav><a href="/apply">报名导航</a></nav>',
    '<a href="/a">报名</a><a href="/b">报名</a>',
    '<a href="/apply?token=secret">报名</a>',
  ])
    assert.equal(extractApplicationLinks(html, opts).applyUrl, null);
});
test("public NCSS DOM preserves factual body and does not invent a placeholder application", async () => {
  const html = await fs.readFile(
    new URL(
      "../fixtures/recruitment-details/ncss-fire-control.html",
      import.meta.url,
    ),
    "utf8",
  );
  const result = await ncss.fetchDetail(
    job({
      sourceId: "ncss",
      siteId: "ncss",
      title: "消防中控员",
      description: null,
    }),
    { request: async () => ({ status: 200, text: html }) },
  );
  assert.match(result.description, /系统监控/);
  assert.equal(result.bodyStatus, "complete");
  assert.equal(result.applyUrl, null);
  assert.equal(result.deadlineAt, null);
});
test("short official notice retains a recruitment attachment for parsing without verifying an empty body", async () => {
  const result = await announcements.fetchDetail(
    job({
      sourceId: "official-announcements",
      siteId: "s",
      kind: "recruitment_notice",
      description: null,
    }),
    {
      sites: [{ siteId: "s", template: { bodyRule: "main" } }],
      request: async () => ({
        status: 200,
        text: '<main>详见附件<a href="/jobs.xlsx">岗位表</a></main>',
      }),
    },
  );
  assert.equal(result.attachments.length, 1);
  assert.equal(result.bodyStatus, "incomplete");
  assert.equal(
    prepareRecruitmentRecord(result).recruitmentEvidence.bodyVerified,
    false,
  );
});
test("application check prepares visible deadlines/conflicts on a clone before requesting", () => {
  const record = job({
    detailStatus: "complete",
    applyUrl: "https://jobs.example.com/apply",
    description: "消防工程人员负责设施维护，本科。报名截止时间：2020年1月1日。",
  });
  const before = structuredClone(record);
  const check = prepareApplicationCheck(record, Date.parse("2026-10-10"));
  assert.equal(check.evidence.openingStatus, "expired");
  assert.equal(check.shouldRequest, false);
  assert.deepEqual(record, before);
  assert.equal(
    prepareApplicationCheck(
      { ...record, deadlineAt: "2030-01-01" },
      Date.parse("2026-10-10"),
    ).shouldRequest,
    false,
  );
});
test("observed Guizhou DOM reads body, sibling attachment and explicit text portal while respecting its ended window", async () => {
  const site = loadSiteCatalog().find(
    (s) => s.siteId === "official-guizhou-airport",
  );
  assert.ok(site);
  assert.equal(site.status, "candidate");
  const html = await fs.readFile(
    new URL(
      "../fixtures/recruitment-details/guizhou-airport.html",
      import.meta.url,
    ),
    "utf8",
  );
  const result = await announcements.fetchDetail(
    job({
      sourceId: "official-announcements",
      siteId: site.siteId,
      kind: "recruitment_notice",
      title: "贵州省支线机场2026年社会招聘公告",
      url: site.evidenceUrl,
    }),
    { sites: [site], request: async () => ({ status: 200, text: html }) },
  );
  assert.match(result.description, /公开招聘为消防/);
  assert.equal(result.attachments.length, 1);
  assert.equal(
    result.applyUrl,
    "https://rlzy.gzairports.com:15600/zp.html#/channel/02",
  );
  const check = prepareApplicationCheck(
    result,
    Date.parse("2026-07-09T09:01:00Z"),
  );
  assert.equal(check.evidence.openingStatus, "expired");
  assert.equal(check.shouldRequest, false);
  assert.equal(
    prepareRecruitmentRecord(result).deadlineAt,
    "2026-07-09T09:00:00.000Z",
  );
  assert.equal(
    prepareRecruitmentRecord({ ...result, title: "招聘拟聘用人员公示" })
      .recruitmentEvidence.openingStatus,
    "historical",
  );
});
test("manual verification skips historical/expired entry requests and appends to the owned schema3 application", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  const saved = await c.commit({
    pageKey: "expired",
    done: false,
    nextCursor: { page: 2 },
    records: [
      job({
        detailStatus: "complete",
        applyUrl: "https://jobs.example.com/apply",
        description: "负责消防设施维护，本科。报名截止时间：2020年1月1日。",
      }),
    ],
  });
  const id = saved.jobIds[0];
  const application = await f.jobs.updateJobApplication(
    id,
    { status: "interested" },
    f.scope,
  );
  let requests = 0;
  const service = createJobVerificationService({
    repository: f.repository,
    registry: createSourceRegistry([]),
    activityContext: async (ref, callback) =>
      callback({
        ref,
        token: c.token,
        operationLease: c.lease,
        collectionGuard: { ref, token: c.token },
        request: async () => {
          requests++;
          return { status: 200, text: "<form>报名</form>" };
        },
      }),
  });
  const result = await service.verifyJob({
    scope: f.scope,
    jobId: id,
    ref: c.ref,
  });
  assert.equal(requests, 0);
  assert.equal(result.recruitmentEvidence.openingStatus, "expired");
  const w = await f.repository.read();
  assert.ok(
    w.applications[application.applicationId].events.some(
      (e) => e.type === "recruitment_verified",
    ),
  );
});
test("automatic body refresh runs after the list completes, stops after three failures, and allows explicit recheck", async (t) => {
  let details = 0;
  const record = job({
    description: null,
    bodyStatus: "incomplete",
    retryEligible: true,
  });
  const provider = createPagedProvider({
    id: "synthetic",
    name: "synthetic",
    capabilities: {},
    listPage: async () => ({ records: [record], hasMore: false }),
    detail: async () => {
      details++;
      throw Object.assign(Error("transient"), {
        code: "ECONNRESET",
        retryable: true,
      });
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  const start = await f.service.start({ scope: f.scope }),
    ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  await f.repository.mutateWorkspace((w) => {
    w.packages[f.scope.packageId].collectionSettings = {
      sourceOverrides: {},
      sessionRefs: {},
      refreshEnabled: true,
    };
    const p = w.runs[ref.activityId].collectionProgress;
    p.refreshReady = true;
    p.manualPaused = false;
    assert.equal(p.units["unit-0"].status, "completed");
  });
  const refresh = createCollectionRefresh({
    repository: f.repository,
    service: f.service,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    f.clock.advance(600001);
    await refresh.tick();
    await f.service.wait(ref);
  }
  assert.equal(details, 4);
  let root = await f.service.get(ref),
    pending = root.collectionProgress.pendingBodies[contentKey(record)];
  assert.equal(pending.automaticAttempts, 3);
  assert.equal(pending.status, "needs_review");
  f.clock.advance(600001);
  assert.deepEqual(await refresh.tick(), []);
  assert.equal(details, 4);
  await f.service.resume({ ref, requestId: "explicit-body-check" });
  await f.service.wait(ref);
  assert.equal(details, 5);
  pending = (await f.service.get(ref)).collectionProgress.pendingBodies[
    contentKey(record)
  ];
  assert.equal(pending.automaticAttempts, 3);
});
test("a short notice becomes expandable only after complete confident attachment extraction", async (t) => {
  const record = job({
    title: "消防工程岗位招聘公告",
    kind: "recruitment_notice",
    description: "详见岗位表",
    detailStatus: "incomplete",
    bodyStatus: "incomplete",
    attachmentBodyPending: true,
    retryEligible: true,
    attachments: [{ url: "https://jobs.example.com/jobs.xlsx" }],
  });
  const p = createPagedProvider({
    id: "synthetic",
    name: "synthetic",
    capabilities: {},
    listPage: async () => ({ records: [record], hasMore: false }),
    detail: async (r) => ({
      ...r,
      bodyStatus: "incomplete",
      detailStatus: "incomplete",
      retryEligible: true,
    }),
  });
  const f = await collectionFixture(t, { providers: [p] });
  f.service.setAttachmentService({
    enrich: async ({ record }) => ({
      ...record,
      attachments: record.attachments.map((a) => ({
        ...a,
        extraction: {
          status: "extracted",
          blocks: [
            {
              text: "合成公司公开招聘消防工程师，负责消防设施维护与检测，要求消防工程相关专业、本科及以上学历，具体任职要求以本岗位原文为准。",
              confidence: 100,
            },
          ],
          tables: [],
        },
      })),
    }),
  });
  const start = await f.service.start({ scope: f.scope }),
    ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  const root = await f.service.get(ref),
    fields = Object.values((await f.repository.read()).observations)[0].fields;
  assert.equal(fields.bodyStatus, "complete");
  assert.equal(fields.retryEligible, false);
  assert.equal(Object.keys(root.collectionProgress.pendingBodies).length, 0);
  assert.equal(Object.keys(root.collectionProgress.pendingArticles).length, 1);
});
test("expanded article jobs run the same readonly application check before ingestion", async (t) => {
  const excerpt =
    "消防工程师，北京，本科，负责消防设施检查、日常维护、隐患排查与消防设备运行保障，具备相关专业知识与工程实践能力。";
  const record = job({
    title: "合成公司招聘公告",
    kind: "recruitment_notice",
    description:
      "合成公司招聘公告\n报名截止时间：2030年1月1日。\n统一投递入口：https://jobs.example.com/apply。\n消防工程师\n" +
      excerpt +
      "\n本次招聘采用公开招聘流程，岗位事实和报名要求均以当前岗位正文内容为准。",
    detailStatus: "complete",
    bodyStatus: "complete",
    applyUrl: "https://jobs.example.com/apply",
  });
  const p = createPagedProvider({
    id: "synthetic",
    name: "synthetic",
    capabilities: {},
    listPage: async () => ({ records: [record], hasMore: false }),
  });
  const urls = [];
  const f = await collectionFixture(t, {
    providers: [p],
    modelFactory: () => ({
      available: true,
      chatJson: async () => ({
        isRecruiting: true,
        company: "合成公司",
        batch: "",
        deadline: "2030-01-01",
        applyMethod: "官网网申",
        positions: [
          {
            title: "消防工程师",
            company: "合成公司",
            city: "北京",
            education: "本科",
            major: "",
            experience: "",
            jobType: "",
            salary: "",
            headcount: "",
            summary: "设施维护",
            requirementsExcerpt: excerpt,
          },
        ],
      }),
    }),
    transport: async (url) => {
      urls.push(url);
      return { status: 200, text: "<form><button>提交申请</button></form>" };
    },
  });
  const start = await f.service.start({
    scope: f.scope,
    options: { mode: "ai" },
  });
  await f.service.wait({ scope: f.scope, activityId: start.activityId });
  assert.deepEqual(urls, ["https://jobs.example.com/apply"]);
  const fields = Object.values((await f.repository.read()).observations)
    .map((o) => o.fields)
    .find((r) => r.kind === "job");
  assert.equal(fields.applicationVerification.formVerified, true);
});
