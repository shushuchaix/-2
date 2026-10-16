import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createApplicationContext } from "../../src/application/context.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { createCollectionLedger } from "../../src/application/collection-ledger.mjs";
import { createAttachmentService } from "../../src/attachments/service.mjs";
import { createConditionalCache } from "../../src/infrastructure/http/conditional-cache.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";

const attachmentUrl = "https://jobs.example.org/roles.xlsx";
const applyUrl = "https://jobs.example.org/apply";
const site = {
  siteId: "synthetic-site",
  providerId: "synthetic",
  category: "job_board",
  name: "Synthetic",
  status: "ready",
  verifiedAt: "2026-10-05T00:00:00.000Z",
  probeEvidence: [{ hasRequirements: true }],
  origin: "https://jobs.example.org",
};
const plan = () => ({
  units: [
    {
      unitId: "diagnostic-unit",
      sourceId: "synthetic",
      siteId: site.siteId,
      queryIndex: 0,
      site,
      query: { keyword: "synthetic", pageLimit: 2 },
    },
  ],
  hashes: {
    planHash: "diagnostic-plan",
    catalogHash: "c1",
    queryHash: "q1",
    parserVersion: "v1",
  },
  limits: { maxRequests: 5, maxDetails: 2, maxAttachments: 2, maxCostCny: 1 },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const notice = (overrides = {}) =>
  job({
    kind: "recruitment_notice",
    title: "合成公司招聘消防岗位公告",
    description: "详见附件岗位表",
    detailStatus: "incomplete",
    bodyStatus: "incomplete",
    attachmentBodyPending: true,
    retryEligible: true,
    attachments: [{ url: attachmentUrl, textStatus: "not_extracted" }],
    ...overrides,
  });
const openJob = (overrides = {}) =>
  job({
    title: "消防工程师",
    description:
      "消防工程师负责消防设施维护、巡检、隐患排查和消防设备运行保障，要求本科及以上学历。",
    bodyStatus: "complete",
    detailStatus: "complete",
    deadlineAt: "2030-01-01",
    applyUrl,
    ...overrides,
  });

async function applicationFixture(
  t,
  { planner = plan, transport, listPage } = {},
) {
  const f = await collectionFixture(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["合成招聘岗位表"],
      ["共用条件：遵纪守法"],
      ["岗位", "地区", "人数", "学历"],
      ["消防工程师", "合成城", 2, "本科"],
      ["消防维保员", "合成城", 1, "大专"],
    ]),
    "岗位表",
  );
  const spreadsheet = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  });
  const provider = createPagedProvider({
    id: "synthetic",
    name: "Synthetic",
    capabilities: {},
    listPage: listPage || (async () => ({ records: [], hasMore: false })),
  });
  const calls = [];
  const context = await createApplicationContext({
    cfg: {
      deepseek: {
        apiKey: "",
        model: "deepseek-flash",
        baseUrl: "https://api.deepseek.com",
      },
      limits: { persist: false, perIpCooldownMs: 0 },
    },
    dataDir: f.dataDir,
    dependencies: {
      repository: f.repository,
      registry: createSourceRegistry([provider]),
      catalog: [site],
      ...(planner === null ? {} : { collectionPlanner: planner }),
      startScheduler: false,
      requestFactory:
        ({ budget, signal }) =>
        async (url, options = {}) => {
          signal.throwIfAborted();
          const reservation = await budget.claimRequest(
            options.kind || "request",
            { bytesUpperBound: options.maxBytes || 0 },
          );
          calls.push(url);
          let response;
          if (transport) response = await transport(url, options, signal);
          else if (url === attachmentUrl)
            response = { status: 200, headers: {}, bytes: spreadsheet };
          else if (url === applyUrl)
            response = {
              status: 200,
              headers: {},
              text: "<form><label>公开招聘报名</label><button>提交申请</button></form>",
            };
          else throw Error("Unexpected synthetic request");
          if (!signal.aborted)
            await budget.settleRequest(reservation, {
              bytes:
                response.bytes?.length ||
                Buffer.byteLength(response.text || ""),
            });
          return response;
        },
    },
  });
  context.collectionRefresh.stop();
  t.after(() => context.close());
  const prepared = await context.collectionService.prepare({
    scope: f.scope,
    options: { mode: "rules", requestId: "prepare-diagnostic" },
  });
  return {
    ...f,
    context,
    calls,
    ref: { scope: f.scope, activityId: prepared.activityId },
  };
}

test("application context honors an internal collection planner without replacing its owned collection service", async (t) => {
  const f = await applicationFixture(t);
  const root = await f.context.collectionService.get(f.ref);
  assert.equal(root.collectionProgress.planHash, "diagnostic-plan");
  assert.deepEqual(Object.keys(root.collectionProgress.units), [
    "diagnostic-unit",
  ]);
  assert.equal(root.collectionUsage.maxRequests, 5);
  assert.equal(root.collectionUsage.usedRequests, 0);
  assert.equal(f.calls.length, 0);
});

test("application context retains normal catalog planning when no internal planner is supplied", async (t) => {
  const f = await applicationFixture(t, { planner: null });
  const root = await f.context.collectionService.get(f.ref);
  const units = Object.values(root.collectionProgress.units);
  assert.ok(units.length > 0);
  assert.ok(
    units.every(
      (u) => u.siteId === "synthetic-site" && u.sourceId === "synthetic",
    ),
  );
  assert.notEqual(root.collectionProgress.planHash, "diagnostic-plan");
  assert.equal(root.collectionUsage.usedRequests, 0);
  assert.equal(f.calls.length, 0);
});

test("diagnostic enrichment uses real attachment row parsing and public application checks in one root allowance", async (t) => {
  const f = await applicationFixture(t);
  const enriched = await f.context.collectionService.withDiagnosticContext(
    { ref: f.ref, requestId: "complete-job" },
    (ctx) =>
      ctx.enrichRecord(
        openJob({
          attachments: [{ url: attachmentUrl, textStatus: "not_extracted" }],
        }),
      ),
  );
  const record = prepareRecruitmentRecord(enriched, f.clock.now());
  assert.equal(record.applicationVerification.formVerified, true);
  assert.equal(record.recruitmentEvidence.applicationStatus, "available");
  assert.equal(record.attachments[0].extraction.format, "xlsx");
  const row = record.attachmentRows.find((r) => r.text.includes("消防工程师"));
  assert.ok(row);
  assert.equal(row.sourceUrl, attachmentUrl);
  assert.ok(
    row.cells.every((c) => c.location.sheet === "岗位表" && c.row === 4),
  );
  assert.ok(
    record.evidence.some(
      (e) =>
        e.kind === "attachment" &&
        e.url === attachmentUrl &&
        e.excerpt === "消防工程师",
    ),
  );
  let root = await f.context.collectionService.get(f.ref);
  assert.equal(root.collectionUsage.usedRequests, 2);
  assert.equal(root.collectionUsage.usedAttachments, 1);
  assert.equal(root.collectionUsage.usedDetails, 0);
  assert.equal(root.collectionUsage.costUpperBoundCny, 0);
  assert.equal(root.collectionUsage.usedModelRequests, 0);
  assert.equal(root.collectionProgress.status, "paused");
  await f.context.collectionService.withDiagnosticContext(
    { ref: f.ref, requestId: "same-root-next" },
    (ctx) => ctx.enrichRecord(openJob()),
  );
  root = await f.context.collectionService.get(f.ref);
  assert.equal(root.collectionUsage.usedRequests, 3);
  assert.equal(root.collectionUsage.usedAttachments, 1);
  assert.deepEqual(f.calls, [applyUrl, attachmentUrl, applyUrl]);
});

test("a running collection exposes the same owned attachment completion path to its activity context", async (t) => {
  const ready = deferred(),
    release = deferred();
  const f = await applicationFixture(t, {
    listPage: async () => {
      ready.resolve();
      await release.promise;
      return { records: [], hasMore: false };
    },
  });
  await f.context.collectionService.resume({
    ref: f.ref,
    requestId: "running",
  });
  await ready.promise;
  try {
    const record = await f.context.collectionService.withActivityContext(
      f.ref,
      (ctx) => ctx.enrichRecord(notice()),
    );
    assert.equal(record.bodyStatus, "complete");
    assert.ok(
      record.attachmentRows.some((row) => row.text.includes("消防工程师")),
    );
    assert.deepEqual(f.calls, [attachmentUrl]);
    assert.equal(
      (await f.context.collectionService.get(f.ref)).collectionUsage
        .usedAttachments,
      1,
    );
  } finally {
    release.resolve();
    await f.context.collectionService.wait(f.ref);
  }
});

test("only complete confident attachment evidence upgrades an incomplete notice body", async (t) => {
  const f = await applicationFixture(t);
  const record = await f.context.collectionService.withDiagnosticContext(
    { ref: f.ref, requestId: "complete-notice" },
    (ctx) => ctx.enrichRecord(notice()),
  );
  assert.equal(record.bodyStatus, "complete");
  assert.equal(record.detailStatus, "complete");
  assert.equal(record.attachmentBodyPending, false);
  assert.equal(record.retryEligible, false);
  assert.ok(record.attachmentRows.some((r) => r.text.includes("消防维保员")));
  const uncertain = notice({
    attachments: [
      {
        url: attachmentUrl,
        textStatus: "extracted",
        extraction: {
          status: "extracted",
          blocks: [
            {
              text: "合成公司公开招聘消防工程师，负责消防设施维护、巡检和安全保障。",
              confidence: 100,
              location: { page: 1, row: 1 },
            },
            {
              text: "UNTRUSTED_REQUIREMENT",
              confidence: 84,
              location: { page: 1, row: 2 },
            },
            {
              text: "AMBIGUOUS_REQUIREMENT",
              confidence: 100,
              ambiguousMerge: true,
              location: { page: 1, row: 3 },
            },
          ],
          tables: [],
        },
      },
    ],
  });
  const pending = await f.context.collectionService.withDiagnosticContext(
    { ref: f.ref, requestId: "uncertain-notice" },
    (ctx) => ctx.enrichRecord(uncertain),
  );
  assert.equal(pending.bodyStatus, "incomplete");
  assert.equal(pending.attachmentBodyPending, true);
  assert.doesNotMatch(
    pending.description,
    /UNTRUSTED_REQUIREMENT|AMBIGUOUS_REQUIREMENT/,
  );
  assert.equal(pending.attachmentRows.length, 1);
  assert.deepEqual(f.calls, [attachmentUrl]);
});

test("diagnostic application checks skip expired bodies and conflicting deadlines", async (t) => {
  const f = await applicationFixture(t);
  const records = await f.context.collectionService.withDiagnosticContext(
    { ref: f.ref, requestId: "expired-conflict" },
    async (ctx) => [
      await ctx.enrichRecord(
        openJob({
          description:
            "消防工程师负责消防设施维护和安全保障，要求本科。报名截止时间：2020年1月1日。",
          deadlineAt: null,
        }),
      ),
      await ctx.enrichRecord(
        openJob({
          description:
            "消防工程师负责消防设施维护和安全保障，要求本科。报名截止时间：2020年1月1日。",
        }),
      ),
    ],
  );
  assert.equal(
    prepareRecruitmentRecord(records[0], f.clock.now()).recruitmentEvidence
      .openingStatus,
    "expired",
  );
  assert.ok(
    prepareRecruitmentRecord(records[1], f.clock.now()).recruitmentEvidence
      .conflicts.length > 0,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.context.collectionService.get(f.ref)).collectionUsage.usedRequests,
    0,
  );
});

test("diagnostic helper sees attachment service changes made after context construction", async (t) => {
  const f = await applicationFixture(t);
  await f.context.collectionService.withDiagnosticContext(
    { ref: f.ref, requestId: "setter" },
    async (ctx) => {
      f.context.collectionService.setAttachmentService(undefined);
      const untouched = await ctx.enrichRecord(notice());
      assert.equal(untouched.bodyStatus, "incomplete");
      assert.equal(f.calls.length, 0);
      f.context.collectionService.setAttachmentService(
        createAttachmentService({
          ledger: createCollectionLedger({ repository: f.repository }),
          cleanup: f.context.attachmentCleanup,
          cache: createConditionalCache({ repository: f.repository }),
          clock: f.clock,
        }),
      );
      const enriched = await ctx.enrichRecord(notice());
      assert.equal(enriched.bodyStatus, "complete");
      assert.ok(
        enriched.attachmentRows.some((r) => r.text.includes("消防工程师")),
      );
    },
  );
  assert.equal(
    (await f.context.collectionService.get(f.ref)).collectionUsage
      .usedAttachments,
    1,
  );
  assert.deepEqual(f.calls, [attachmentUrl]);
});

test("a diagnostic helper retained after its callback returns cannot send another request", async (t) => {
  const f = await applicationFixture(t);
  let retained;
  await f.context.collectionService.withDiagnosticContext(
    { ref: f.ref, requestId: "retain" },
    async (ctx) => {
      retained = ctx.enrichRecord;
    },
  );
  await assert.rejects(
    () => retained(openJob()),
    (e) =>
      ["collection_stale_epoch", "invalid_operation_lease"].includes(e.code),
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.context.collectionService.get(f.ref)).collectionUsage.usedRequests,
    0,
  );
});

test("cancellation rejects a late application response instead of returning writable enrichment", async (t) => {
  const ready = deferred(),
    release = deferred(),
    aborted = deferred();
  const f = await applicationFixture(t, {
    transport: async (_url, _options, signal) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      ready.resolve();
      await release.promise;
      return {
        status: 200,
        headers: {},
        text: "<form>公开招聘报名，提交申请</form>",
      };
    },
  });
  let returned = false;
  const pending = f.context.collectionService.withDiagnosticContext(
    { ref: f.ref, requestId: "late" },
    async (ctx) => {
      const result = await ctx.enrichRecord(openJob());
      returned = true;
      return result;
    },
  );
  const rejection = assert.rejects(pending, { code: "collection_stale_epoch" });
  await Promise.race([ready.promise, pending]);
  const cancellation = f.context.collectionService.cancel(f.ref);
  await aborted.promise;
  release.resolve();
  await rejection;
  await cancellation;
  assert.equal(returned, false);
  assert.deepEqual(f.calls, [applyUrl]);
  assert.equal(
    (await f.context.collectionService.get(f.ref)).collectionProgress.status,
    "cancelled",
  );
});
