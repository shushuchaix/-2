import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createConditionalCache } from "../../src/infrastructure/http/conditional-cache.mjs";
import { createAttachmentService } from "../../src/attachments/service.mjs";
import { createDocConverter } from "../../src/attachments/doc-converter.mjs";
import { makeDocx } from "../helpers/resume-files.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";

const url = "https://jobs.example.org/synthetic-recruitment.doc";
const doc = Buffer.concat([
  Buffer.from("d0cf11e0a1b11ae1", "hex"),
  Buffer.alloc(504),
]);
const docx = makeDocx({
  "word/document.xml":
    '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>合成招聘共同条件</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>消防工程師 本科</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
});

async function fixture(t, limits = {}) {
  const f = await collectionFixture(t, {
    limits: { maxRequests: 3, maxAttachments: 1, maxBytes: 4096, ...limits },
  });
  const { ref, token, lease } = await f.openCommit();
  const cache = createConditionalCache({ repository: f.repository });
  const calls = [];
  const context = {
    ref,
    token,
    operationLease: lease,
    attachment: { url },
  };
  const service = (converter) =>
    createAttachmentService({
      ledger: f.ledger,
      cache,
      cleanup: { cleanupAttempt: async () => {} },
      clock: f.clock,
      converter,
      request: async (_url, options) => {
        const reservationId = randomUUID();
        await f.ledger.reserve({
          ref,
          token,
          operationLease: lease,
          reservationId,
          kind: "attachment",
          requestUpperBound: 1,
          bytesUpperBound: doc.length,
        });
        calls.push(options);
        const conditional = Boolean(options.headers?.["If-None-Match"]);
        await f.ledger.settle({
          ref,
          operationLease: lease,
          reservationId,
          verifiedUsage: { requests: 1, bytes: conditional ? 0 : doc.length },
        });
        return conditional
          ? { status: 304, headers: {} }
          : { status: 200, headers: { etag: '"synthetic-doc"' }, bytes: doc };
      },
    });
  const priorSlice = async () => {
    const entry = await cache.get({
      scope: ref.scope,
      resourceKey: "attachment:" + url,
    });
    await cache.put({
      ...entry,
      scope: ref.scope,
      resourceKey: "attachment:" + url,
      operationLease: lease,
      parsedEvidence: {
        ...entry.parsedEvidence,
        sliceRunId: "synthetic-prior-slice",
      },
    });
  };
  return { ...f, ref, context, cache, calls, service, priorSlice };
}

for (const slice of ["same", "prior"]) {
  test(`DOC converter becoming available retries pending ${slice} slice evidence`, async (t) => {
    const f = await fixture(t);
    const pending = await f.service(createDocConverter({})).extract(f.context);
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.issues, [{ code: "doc_converter_unavailable" }]);
    if (slice === "prior") await f.priorSlice();
    let conversions = 0;
    const available = f.service({
      convert: async () => {
        conversions++;
        return docx;
      },
    });
    const result = await available.extract(f.context);
    assert.equal(result.status, "extracted");
    assert.equal(conversions, 1);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].headers, {});
    assert.ok(result.blocks.some((block) => block.text === "合成招聘共同条件"));
    const degree = result.fields.find((field) => field.value === "本科");
    assert.equal(degree.status, "extracted");
    assert.deepEqual(degree.evidence.location, { table: 1, row: 1, col: 1 });
    const usage = await f.ledger.snapshot(f.ref);
    assert.equal(usage.usedRequests, 2);
    assert.equal(usage.usedAttachments, 1);
    assert.equal(usage.usedBytes, doc.length * 2);
    assert.equal(usage.usedDetails, 0);
    assert.equal(usage.usedModelRequests, 0);
  });
}

test("successful DOC same slice extraction still bypasses transport and conversion", async (t) => {
  const f = await fixture(t);
  let conversions = 0;
  const available = f.service({
    convert: async () => {
      conversions++;
      return docx;
    },
  });
  const first = await available.extract(f.context);
  const repeated = await available.extract(f.context);
  assert.equal(repeated.status, first.status);
  assert.deepEqual(repeated.blocks, first.blocks);
  assert.deepEqual(repeated.tables, first.tables);
  assert.deepEqual(repeated.fields, first.fields);
  assert.equal(f.calls.length, 1);
  assert.equal(conversions, 1);
  const usage = await f.ledger.snapshot(f.ref);
  assert.equal(usage.usedRequests, 1);
  assert.equal(usage.usedAttachments, 1);
  assert.equal(usage.usedBytes, doc.length);
});

test("successful DOC prior slice extraction still reuses conditional response evidence", async (t) => {
  const f = await fixture(t);
  let conversions = 0;
  const available = f.service({
    convert: async () => {
      conversions++;
      return docx;
    },
  });
  await available.extract(f.context);
  await f.priorSlice();
  const repeated = await available.extract(f.context);
  assert.equal(repeated.status, "extracted");
  assert.equal(repeated.cacheReused, true);
  assert.equal(f.calls[1].headers["If-None-Match"], '"synthetic-doc"');
  assert.equal(f.calls.length, 2);
  assert.equal(conversions, 1);
  const usage = await f.ledger.snapshot(f.ref);
  assert.equal(usage.usedRequests, 2);
  assert.equal(usage.usedAttachments, 1);
  assert.equal(usage.usedBytes, doc.length);
});

test("200 then 304 preserves attachment evidence time across the 72 hour boundary", async (t) => {
  const f = await fixture(t),
    service = f.service({ convert: async () => docx }),
    first = await service.extract(f.context),
    originalAt = first.observedAt;
  f.clock.advance(71 * 3600000);
  await f.priorSlice();
  const reused = await service.extract(f.context);
  assert.equal(reused.cacheReused, true);
  assert.equal(reused.observedAt, originalAt);
  const evidence = await f.cache.get({
    scope: f.ref.scope,
    resourceKey: "attachment:" + url,
  });
  assert.equal(evidence.evidenceCheckedAt, originalAt);
  assert.equal(evidence.checkedAt, new Date(f.clock.now()).toISOString());
  const record = {
    description: "合成岗位完整要求",
    detailStatus: "complete",
    applyUrl: "https://jobs.example.org/apply",
    applicationVerification: {
      status: 200,
      formVerified: true,
      checkedAt: reused.observedAt,
    },
  };
  assert.equal(
    assessRecruitmentEvidence({ record, now: f.clock.now() }).applicationStatus,
    "available",
  );
  f.clock.advance(3600000 + 1);
  await f.priorSlice();
  const expired = await service.extract(f.context);
  assert.equal(expired.observedAt, originalAt);
  assert.equal(
    assessRecruitmentEvidence({ record, now: f.clock.now() }).applicationStatus,
    "unknown",
  );
  assert.equal(f.calls.length, 3);
  const usage = await f.ledger.snapshot(f.ref);
  assert.equal(usage.knownPhysicalRequests, 3);
  assert.equal(usage.usedAttachments, 1);
});

test("retrying pending DOC cannot bypass the original request allowance", async (t) => {
  const f = await fixture(t, { maxRequests: 1 });
  await f.service(createDocConverter({})).extract(f.context);
  await assert.rejects(
    f.service({ convert: async () => docx }).extract(f.context),
    { code: "source_budget_exhausted", budgetKind: "requests" },
  );
  assert.equal(f.calls.length, 1);
  const usage = await f.ledger.snapshot(f.ref);
  assert.equal(usage.usedRequests, 1);
  assert.equal(usage.usedAttachments, 1);
  assert.equal(usage.usedBytes, doc.length);
});

for (const slice of ["same", "prior"]) {
  test(`still unavailable DOC converter preserves pending ${slice} slice reuse`, async (t) => {
    const f = await fixture(t);
    await f.service(createDocConverter({})).extract(f.context);
    if (slice === "prior") await f.priorSlice();
    const repeated = await f.service(createDocConverter({})).extract(f.context);
    assert.equal(repeated.status, "pending");
    assert.deepEqual(repeated.issues, [{ code: "doc_converter_unavailable" }]);
    assert.equal(f.calls.length, slice === "same" ? 1 : 2);
    const usage = await f.ledger.snapshot(f.ref);
    assert.equal(usage.usedRequests, slice === "same" ? 1 : 2);
    assert.equal(usage.usedAttachments, 1);
    assert.equal(usage.usedBytes, doc.length);
  });
}

test("DOC conversion capability only probes an explicit existing file", async (t) => {
  const f = await fixture(t);
  const executable = path.join(f.dataDir, "synthetic-converter.exe");
  await fs.writeFile(executable, "synthetic, never execute");
  const configured = createDocConverter({ executable });
  assert.equal(typeof configured.canAttemptConversion, "function");
  assert.equal(await configured.canAttemptConversion(), true);
  assert.equal(await createDocConverter({}).canAttemptConversion(), false);
  assert.equal(
    await createDocConverter({
      executable: "relative.exe",
    }).canAttemptConversion(),
    false,
  );
  assert.equal(
    await createDocConverter({
      executable: executable + ".missing",
    }).canAttemptConversion(),
    false,
  );
  assert.equal(
    await createDocConverter({ executable: f.dataDir }).canAttemptConversion(),
    false,
  );
});
