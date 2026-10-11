import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { contentHash } from "../../src/infrastructure/storage/repository.mjs";
import { collectionLimitsFor } from "../../public/js/validation-rules.js";

test("an authorized 300MiB extension uses normal activity guards and preserves its original ledger", async (t) => {
  const f = await collectionFixture(t, {
    limits: {
      maxRequests: 391,
      maxDetails: 87,
      maxCostCny: 6.13,
      maxAttachments: 10,
      maxTotalAttachmentBytes: 104857600,
    },
  });
  const prepared = await f.service.prepare({
    scope: f.scope,
    options: { mode: "rules", requestId: "extension-prepare" },
  });
  const ref = { scope: f.scope, activityId: prepared.activityId };
  await f.service.withDiagnosticContext(
    { ref, requestId: "existing-uncertain-use" },
    async (ctx) => {
      await f.ledger.reserve({
        ref,
        token: ctx.token,
        operationLease: ctx.operationLease,
        reservationId: "original-uncertain",
        kind: "request",
        requestUpperBound: 1,
        bytesUpperBound: 128,
      });
      await ctx.budget.claimDetail("original-detail");
    },
  );
  const before = await f.service.get(ref),
    ledgerHash = contentHash(before.collectionProgress.ledger);
  assert.equal(
    before.collectionProgress.limits.maxTotalAttachmentBytes,
    104857600,
  );
  assert.equal(
    collectionLimitsFor("standard").maxTotalAttachmentBytes,
    209715200,
  );
  const limits = {
    maxRequests: 691,
    maxDetails: 187,
    maxTotalAttachmentBytes: 314572800,
  };
  await f.service.adjustLimits({
    ref,
    limits,
    expectedRevision: before.collectionProgress.revision,
  });
  const after = await f.service.get(ref);
  assert.equal(
    after.collectionProgress.limits.maxTotalAttachmentBytes,
    314572800,
  );
  assert.equal(after.collectionProgress.limits.maxRequests, 691);
  assert.equal(after.collectionProgress.limits.maxDetails, 187);
  assert.equal(after.collectionProgress.limits.maxCostCny, 6.13);
  assert.equal(after.collectionProgress.limits.maxAttachments, 10);
  assert.equal(after.collectionProgress.status, "paused");
  assert.equal(contentHash(after.collectionProgress.ledger), ledgerHash);
  assert.equal(after.collectionUsage.usedRequests, 1);
  assert.equal(after.collectionUsage.unknownRequestUpperBound, 1);
  assert.equal(after.collectionUsage.usedBytes, 128);
  assert.equal(after.collectionUsage.usedDetails, 1);
  assert.equal(after.collectionUsage.costUpperBoundCny, 0);
  const revision = after.collectionProgress.revision;
  await assert.rejects(
    () =>
      f.service.adjustLimits({
        ref,
        limits: { maxTotalAttachmentBytes: 314572801 },
        expectedRevision: revision,
      }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    () =>
      f.service.adjustLimits({
        ref,
        limits,
        expectedRevision: before.collectionProgress.revision,
      }),
    { code: "collection_progress_conflict" },
  );
  await assert.rejects(
    () =>
      f.service.adjustLimits({
        ref: { ...ref, scope: f.otherScope },
        limits,
        expectedRevision: revision,
      }),
    { code: "collection_scope" },
  );
  const rejected = await f.service.get(ref);
  assert.equal(rejected.collectionProgress.revision, revision);
  assert.equal(contentHash(rejected.collectionProgress.ledger), ledgerHash);
  assert.equal(
    Object.values((await f.repository.read()).operationLeases).filter(
      (lease) => lease.status === "active",
    ).length,
    0,
  );
  assert.equal(f.networkCalls, 0);
});
