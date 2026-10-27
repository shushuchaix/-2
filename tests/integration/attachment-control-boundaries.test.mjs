import test from "node:test";
import assert from "node:assert/strict";
import { createAttachmentService } from "../../src/attachments/service.mjs";
import { createRecordEnrichment } from "../../src/application/record-enrichment.mjs";

const now = Date.parse("2026-10-21T00:00:00Z"), clock = { now: () => now };
const ref = { scope: { packageId: "synthetic-package", targetRevisionId: "synthetic-r1" }, activityId: "synthetic-root" };
const record = () => ({ sourceId: "synthetic", siteId: "synthetic-site", kind: "job", sourceRecordId: "one",
  title: "机场消防工程师", url: "https://jobs.example.org/jobs/one", applyUrl: "https://jobs.example.org/apply/one",
  description: "消防工程师负责机场消防设施检测维护。要求消防工程专业、本科。报名截止：2026年12月31日。",
  bodyStatus: "complete", detailStatus: "complete", attachments: [
    { url: "https://jobs.example.org/first.doc" }, { url: "https://jobs.example.org/second.doc" } ] });
function fixture(mode, failure) {
  const calls = { reserves: 0, attachments: 0, applications: 0, cleaned: 0, conversions: 0 };
  const request = async url => {
    if (url.includes("/apply/")) { calls.applications++; return { status: 200, text: "<form><button>提交申请</button></form>" }; }
    calls.attachments++;
    if (mode === "request") throw failure;
    return { status: 200, bytes: Buffer.from("d0cf11e0a1b11ae1", "hex") };
  };
  const attachmentService = createAttachmentService({ clock, request,
    ledger: { reserve: async () => { calls.reserves++; if (mode === "ledger") throw failure; return { reservationId: "synthetic-" + calls.reserves }; }, settle: async () => {} },
    cleanup: { cleanupAttempt: async () => { calls.cleaned++; } },
    ...(mode === "converter" ? { converter: { convert: async () => { calls.conversions++; throw failure; } } } : {}),
  });
  const context = { ref, token: { sliceRunId: "synthetic-slice" }, operationLease: {}, request, runId: "synthetic-run" };
  return { calls, attachmentService, run: () => createRecordEnrichment({ clock, getAttachmentService: () => attachmentService })(record(), context), context };
}
for (const mode of ["ledger", "request", "converter"]) {
  for (const error of [Object.assign(Error("synthetic no disk space"), { code: "ENOSPC", runFatal: true }),
    Object.assign(Error("synthetic storage constraint"), { code: "sqlite_constraint", runFatal: true }),
    Object.assign(Error("synthetic lease revoked"), { code: "invalid_operation_lease" }),
    Object.assign(Error("synthetic fatal budget-code storage error"), { code: "source_budget_exhausted", runFatal: true }),
    Object.assign(Error("synthetic abort"), { name: "AbortError" })]) {
    test(`real attachment ${mode} control ${error.code || error.name} escapes enrichment and prevents later transport`, async () => {
      const f = fixture(mode, error);
      await assert.rejects(f.run(), actual => actual === error);
      assert.equal(f.calls.reserves, 1); assert.equal(f.calls.attachments, mode === "ledger" ? 0 : 1);
      assert.equal(f.calls.conversions, Number(mode === "converter"));
      assert.equal(f.calls.applications, 0); assert.equal(f.calls.cleaned, 1);
    });
  }
}
test("ordinary attachment network failures stay pending and the same valid application path is actually checked", async () => {
  const f = fixture("request", Object.assign(Error("synthetic network failure"), { code: "ECONNRESET" }));
  const result = await f.run();
  assert.equal(f.calls.reserves, 2); assert.equal(f.calls.attachments, 2); assert.equal(f.calls.applications, 1);
  assert.equal(result.attachments.every(attachment => attachment.textStatus === "pending"), true);
  assert.equal(result.applicationVerification.formVerified, true);
  assert.equal(result.recruitmentEvidence.applicationStatus, "available");
});
test("ordinary attachment budget result marks the remaining attachments pending without another extraction", async () => {
  const f = fixture("ledger", Object.assign(Error("synthetic attachment budget stop"), { code: "source_budget_exhausted", budgetKind: "attachments" }));
  const result = await f.attachmentService.enrich({ record: record(), ...f.context });
  assert.equal(f.calls.reserves, 1); assert.equal(f.calls.attachments, 0);
  assert.equal(result.attachmentBudgetExhausted, true);
  assert.equal(result.attachments.length, 2);
  assert.equal(result.attachments.every(attachment => attachment.textStatus === "pending" && attachment.issues.some(issue => issue.code === "source_budget_exhausted")), true);
});
test("an aborted attachment context takes precedence over a coincident ordinary budget result", async () => {
  const controller = new AbortController(), aborted = Object.assign(Error("synthetic cancellation"), { name: "AbortError" });
  let reserves = 0, requests = 0;
  const service = createAttachmentService({ clock,
    ledger: { reserve: async () => { reserves++; controller.abort(aborted); throw Object.assign(Error("synthetic budget"), { code: "source_budget_exhausted" }); } },
    cleanup: { cleanupAttempt: async () => {} } });
  await assert.rejects(createRecordEnrichment({ clock, getAttachmentService: () => service })(record(), {
    ref, token: { sliceRunId: "synthetic-slice" }, operationLease: {}, signal: controller.signal,
    request: async () => { requests++; assert.fail("cancelled attachment must not request an application"); },
  }), error => error === aborted);
  assert.equal(reserves, 1); assert.equal(requests, 0);
});
