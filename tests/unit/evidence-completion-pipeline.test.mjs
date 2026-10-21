import test from "node:test";
import assert from "node:assert/strict";
import { createRecordEnrichment } from "../../src/application/record-enrichment.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";
import {
  sourceIssueCode,
  safeSourceIssues,
} from "../../src/sources/source-status.mjs";
import { readProviderPage } from "../../src/sources/collection-page.mjs";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";
import { cleanMetadata } from "../../src/infrastructure/diagnostics/fields.mjs";
import { jsonResponse } from "../../src/sources/adapters/shared.mjs";
import ncss from "../../src/sources/adapters/ncss.mjs";

const now = Date.parse("2026-10-21T00:00:00Z");
const clock = { now: () => now };
const requestId = "q-12345678-1234-1234-1234-123456789abc";
const body =
  "消防工程师负责机场消防设施检测维护。要求消防工程专业、本科。报名截止：2026年12月31日。";
const record = (fields = {}) => ({
  sourceId: "synthetic",
  siteId: "synthetic-site",
  kind: "job",
  sourceRecordId: "one",
  title: "机场消防工程师",
  url: "https://jobs.example.org/jobs/one",
  applyUrl: "https://jobs.example.org/apply/one",
  description: body,
  bodyStatus: "complete",
  detailStatus: "complete",
  ...fields,
});
const pending = () =>
  record({
    description: "详见岗位表",
    bodyStatus: "incomplete",
    detailStatus: "incomplete",
    attachmentBodyPending: true,
    attachments: [{ url: "https://jobs.example.org/positions.xlsx" }],
  });
const attachment = (confidence = 100, ambiguousMerge = false) => ({
  async enrich({ record }) {
    return {
      ...record,
      attachments: record.attachments.map((a) => ({
        ...a,
        extraction: {
          status: "extracted",
          blocks: [
            {
              text: body,
              confidence,
              ambiguousMerge,
              location: { sheet: "岗位表", row: 2 },
            },
          ],
          tables: [],
        },
      })),
    };
  },
});
const response = {
  status: 200,
  text: "<form><button>提交申请</button></form>",
  requestId,
};

test("one enrichment completes attachment body then verifies its application and final evidence", async () => {
  const input = pending(),
    before = structuredClone(input),
    calls = [],
    events = [];
  const enrich = createRecordEnrichment({
    clock,
    diagnostics: (e) => events.push(e),
    getAttachmentService: () => attachment(),
  });
  const result = await enrich(input, {
    runId: "synthetic-run",
    request: async (url, options) => {
      calls.push(url);
      assert.equal(options.diagnosticContext.endpointKind, "application");
      return response;
    },
  });
  assert.deepEqual(input, before);
  assert.deepEqual(calls, [input.applyUrl]);
  assert.equal(result.attachmentBodyPending, false);
  assert.equal(result.bodyStatus, "complete");
  assert.equal(result.attachmentRows.length, 1);
  assert.equal(result.attachmentRows[0].cells[0].location.row, 2);
  assert.equal(result.applicationVerification.checkedUrl, input.applyUrl);
  assert.equal(result.applicationVerification.checkedInRunId, "synthetic-run");
  assert.equal(result.recruitmentEvidence.applicationStatus, "available");
  assert.equal(result.recruitmentEvidence.openingStatus, "open");
  assert.deepEqual(
    result.recruitmentEvidence,
    assessRecruitmentEvidence({ record: result, now }),
  );
  const event = events.find((e) => e.operation === "collection.application");
  assert.equal(event.requestId, requestId);
  assert.equal(event.outcome, "success");
});

for (const [name, service] of [
  ["missing service", undefined],
  ["low confidence", attachment(80)],
  ["ambiguous cells", attachment(100, true)],
])
  test(
    "an incomplete attachment does not trigger an application request: " + name,
    async () => {
      let calls = 0;
      const enrich = createRecordEnrichment({
        clock,
        getAttachmentService: () => service,
      });
      const result = await enrich(pending(), {
        request: async () => {
          calls++;
          return response;
        },
      });
      assert.equal(calls, 0);
      assert.equal(result.recruitmentEvidence.bodyVerified, false);
      assert.equal(result.recruitmentEvidence.applicationStatus, "unknown");
    },
  );

test("an expired deadline discovered in the attachment prevents an application request", async () => {
  const service = attachment();
  const enrich = createRecordEnrichment({
    clock,
    getAttachmentService: () => ({
      async enrich(input) {
        const result = await service.enrich(input);
        result.attachments[0].extraction.blocks[0].text = body.replace(
          "2026年12月31日",
          "2026年10月01日",
        );
        return result;
      },
    }),
  });
  let calls = 0;
  const result = await enrich(pending(), {
    request: async () => {
      calls++;
      return response;
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.recruitmentEvidence.openingStatus, "expired");
});

for (const code of [
  "workspace_write_failed",
  "workspace_repository_closed",
  "collection_stale_epoch",
  "invalid_operation_lease",
  "source_budget_exhausted",
  "package_expired",
  "package_purge_pending",
])
  test(
    "application enrichment propagates control failure " + code,
    async () => {
      const failure = Object.assign(Error(code), { code });
      await assert.rejects(
        createRecordEnrichment({ clock })(record(), {
          request: async () => {
            throw failure;
          },
        }),
        (error) => error === failure,
      );
    },
  );

test("application failures keep a correlated safe reason without exposing upstream data", async () => {
  const events = [];
  const failure = Object.assign(
    Error("private-cookie private-resume private-url"),
    {
      code: "ETIMEDOUT",
      requestId,
      raw: "private-cookie",
    },
  );
  const result = await createRecordEnrichment({
    clock,
    diagnostics: (e, error) => {
      events.push(e);
      assert.equal(error, undefined);
    },
  })(record(), {
    runId: "synthetic-run",
    request: async () => {
      throw failure;
    },
  });
  assert.equal(result.recruitmentEvidence.applicationStatus, "unknown");
  const event = events.find((e) => e.operation === "collection.application");
  assert.equal(event.code, "request_timeout");
  assert.equal(event.resultCategory, "timeout");
  assert.equal(event.requestId, requestId);
  assert.equal(event.endpointKind, "application");
  assert.equal(cleanMetadata(event).phase, "transport");
  assert.equal(event.durationMs, 0);
  assert.doesNotMatch(
    JSON.stringify(events),
    /private-cookie|private-resume|private-url/,
  );
});

test("cancelled enrichment performs neither attachment work nor network requests", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    createRecordEnrichment({
      clock,
      getAttachmentService: () => {
        calls++;
        return attachment();
      },
    })(pending(), {
      signal: controller.signal,
      request: async () => {
        calls++;
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
});

test("HTTP and persistent diagnostic metadata preserve the application endpoint category", async () => {
  const events = [];
  const request = createRequestClient({
    scheduler: createScheduler({ minIntervalMs: 0 }),
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    diagnostics: (e) => events.push(e),
    transport: async () => ({ status: 200, text: "ok", headers: {} }),
  });
  await request("https://jobs.example.org/apply", {
    maxRetries: 0,
    diagnosticContext: { endpointKind: "application", sourceId: "synthetic" },
  });
  assert.ok(events.some((e) => e.operation === "network.request"));
  for (const event of events) {
    assert.equal(event.endpointKind, "application");
    assert.equal(cleanMetadata(event).endpointKind, "application");
  }
});

for (const [error, expected] of [
  [{ code: "ECONNRESET" }, "network_error"],
  [{ code: "ENETUNREACH" }, "network_error"],
  [{ name: "TimeoutError" }, "request_timeout"],
  [{ status: 429 }, "rate_limited"],
  [{ status: 401 }, "login_required"],
  [{ status: 403 }, "restricted"],
  [{ status: 504 }, "http_timeout"],
  [{ code: "response_size_exceeded" }, "response_size_exceeded"],
  [{ message: "captcha private-cookie" }, "source_probe_failed"],
])
  test(
    "structured source failure classification: " +
      expected +
      " " +
      JSON.stringify(error),
    () => {
      assert.equal(sourceIssueCode(error), expected);
      const [issue] = safeSourceIssues([error], "synthetic", "site");
      assert.equal(issue.code, expected);
      assert.equal(issue.message, undefined);
    },
  );

test("non-200 JSON and NCSS detail responses retain rate limiting and request correlation", async () => {
  assert.throws(() => jsonResponse({ status: 429, requestId }), {
    code: "rate_limited",
    requestId,
  });
  await assert.rejects(
    ncss.fetchDetail(record(), {
      request: async () => ({ status: 429, requestId }),
    }),
    { code: "rate_limited", requestId },
  );
});

for (const [name, fields, expected] of [
  ["top-level raw", { raw: 7 }, 7],
  ["known empty", { raw: 0 }, 0],
  ["legacy stats", { stats: { raw: 8, accepted: 0 } }, 8],
  ["unknown", {}, undefined],
  ["invalid", { raw: -1 }, undefined],
  ["invalid stats", { stats: { raw: -1, accepted: 0 } }, undefined],
])
  test("page raw count contract: " + name, async () => {
    const source = { records: [], issues: [], done: true, ...fields };
    const before = structuredClone(source);
    const result = await readProviderPage(
      { id: "synthetic", collectPage: async () => source },
      {},
    );
    assert.equal(result.stats?.raw, expected);
    assert.deepEqual(source, before);
    if (fields.stats) assert.equal(result.stats.accepted, 0);
  });
