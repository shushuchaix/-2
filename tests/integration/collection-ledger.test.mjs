import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { createCollectionRoot } from "../../src/domain/collection.mjs";
import {
  createCollectionLedger,
  createActivityBudgets,
} from "../../src/application/collection-ledger.mjs";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { createAttachmentService } from "../../src/attachments/service.mjs";

const modelConfig = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
};

test("attachment manifest and exhausted credits remain durable after reopening", async (t) => {
  const f = await fixture(t, { maxAttachments: 2 });
  const serviceFor = (ledger) =>
    createAttachmentService({
      ledger,
      cleanup: { cleanupAttempt: async () => {} },
      request: async () => ({ status: 404 }),
    });
  const input = {
    ref: f.ref,
    token: f.token,
    operationLease: f.lease,
    record: {
      attachments: Array.from({ length: 3 }, (_, i) => ({
        url: `https://jobs.example.org/${i}.pdf`,
      })),
    },
  };
  const result = await serviceFor(f.ledger).enrich(input);
  await f.repository.mutateWorkspace(
    (w) => {
      const p = w.runs[f.ref.activityId].collectionProgress;
      p.pendingBodies ||= {};
      p.pendingBodies["synthetic-attachment"] = {
        unitId: "synthetic",
        record: result,
      };
    },
    { operationLease: f.lease },
  );
  assert.equal((await f.ledger.snapshot(f.ref)).usedAttachments, 2);
  await f.reopen();
  const ledger = createCollectionLedger({
    repository: f.repository,
    operationGate: f.operationGate,
  });
  const restored = (await f.repository.read()).runs[f.ref.activityId]
    .collectionProgress.pendingBodies["synthetic-attachment"].record;
  assert.equal(restored.attachments.length, 3);
  assert.equal(restored.attachments[2].textStatus, "pending");
  let requests = 0;
  const resumed = createAttachmentService({
    ledger,
    cleanup: { cleanupAttempt: async () => {} },
    request: async () => {
      requests++;
      return { status: 404 };
    },
  });
  const third = await resumed.enrich({
    ...input,
    record: { attachments: [restored.attachments[2]] },
  });
  assert.equal(third.attachmentBudgetExhausted, true);
  assert.equal(requests, 0);
  assert.equal((await ledger.snapshot(f.ref)).usedAttachments, 2);
});
test("physical_attachment_bytes_repeat_and_retry_are_reserved_before_transport", async (t) => {
  const f = await fixture(t, {
    maxAttachmentBytes: 100,
    maxTotalAttachmentBytes: 150,
  });
  const budgets = await createActivityBudgets({
    ...f,
    operationLease: f.lease,
    modelConfig,
  });
  const first = await budgets.sources.claimRequest("attachment", {
    bytesUpperBound: 100,
  });
  await budgets.sources.settleRequest(first, { bytes: 60 });
  await assert.rejects(
    budgets.sources.claimRequest("retry", { bytesUpperBound: 100 }),
    (e) =>
      e.code === "source_budget_exhausted" && e.budgetKind === "attachments",
  );
  assert.equal((await f.ledger.snapshot(f.ref)).usedBytes, 60);
});
async function fixture(t, limits = {}) {
  const f = await packageBusinessFixture(t),
    { a } = await f.twoTargets();
  const scope = { packageId: a.packageId, targetRevisionId: a.revisionId };
  const ref = { scope, activityId: "root-budget" };
  await f.repository.mutateWorkspace((w) => {
    w.runs[ref.activityId] = createCollectionRoot({
      runId: ref.activityId,
      scope,
      targetSnapshot: a,
      profileSnapshot: a.profileSnapshot,
      plan: { units: [] },
      limits: { maxRequests: 400, maxDetails: 100, maxCostCny: 10, ...limits },
      now: f.clock.now(),
    });
  });
  const lease = await f.operationGate.acquire("collect", { scope });
  t.after(() => lease.release().catch(() => {}));
  const token = { epoch: 0, expectedRevision: 0, sliceRunId: "slice-budget" };
  await f.repository.mutateWorkspace(
    (w) => {
      const root = w.runs[ref.activityId];
      root.collectionProgress.status = "collecting";
      root.collectionProgress.activeSliceRunId = token.sliceRunId;
      w.runs[token.sliceRunId] = {
        runId: token.sliceRunId,
        recordId: randomUUID(),
        ownerPackageId: scope.packageId,
        collectionRole: "collection_slice",
        collectionActivityId: ref.activityId,
        status: "running",
        targetSnapshot: structuredClone(a),
        events: [],
        counts: {},
        usage: {},
        issues: [],
      };
    },
    { operationLease: lease },
  );
  const ledger = createCollectionLedger({
    repository: f.repository,
    operationGate: f.operationGate,
  });
  return {
    ...f,
    a,
    ref,
    token,
    lease,
    ledger,
    reserve: (input) =>
      ledger.reserve({
        ref,
        token,
        operationLease: lease,
        reservationId: randomUUID(),
        requestUpperBound: 0,
        costUpperBoundCny: 0,
        bytesUpperBound: 0,
        ...input,
      }),
  };
}
test("reservation_is_durable_idempotent_and_page_revision_does_not_change", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.reserve({ reservationId: id, kind: "model", costUpperBoundCny: 0.7 });
  assert.equal((await f.ledger.snapshot(f.ref)).reservedCostCny, 0.7);
  assert.equal(
    (
      await f.reserve({
        reservationId: id,
        kind: "model",
        costUpperBoundCny: 0.7,
      })
    ).duplicate,
    true,
  );
  assert.equal(
    (await f.repository.read()).runs[f.ref.activityId].collectionProgress
      .revision,
    0,
  );
  await f.reopen();
  const ledger = createCollectionLedger({
    repository: f.repository,
    operationGate: f.operationGate,
  });
  assert.equal((await ledger.snapshot(f.ref)).reservedCostCny, 0.7);
  assert.equal(
    (await f.repository.read()).runs[f.ref.activityId].collectionProgress.ledger
      .reservations[id].status,
    "reserved",
  );
});
test("concurrent_claims_cannot_overdraw_last_network_or_money_allowance", async (t) => {
  const f = await fixture(t);
  await f.reserve({ kind: "worker", requestUpperBound: 399 });
  const results = await Promise.allSettled([
    f.reserve({ kind: "list", requestUpperBound: 1 }),
    f.reserve({ kind: "list", requestUpperBound: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.ledger.snapshot(f.ref)).usedRequests, 400);
  await f.reserve({ kind: "model", costUpperBoundCny: 9 });
  await assert.rejects(f.reserve({ kind: "model", costUpperBoundCny: 1.01 }), {
    code: "model_budget_exhausted",
  });
});
test("failed_persistent_reservation_prevents_physical_http_request", async (t) => {
  const f = await fixture(t),
    budgets = await createActivityBudgets({
      ledger: f.ledger,
      ref: f.ref,
      token: f.token,
      operationLease: f.lease,
      modelConfig,
    });
  let calls = 0;
  const request = createRequestClient({
    budget: budgets.sources,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => {
      calls++;
      return { status: 200, headers: {}, text: "synthetic" };
    },
  });
  f.armFailure("workspace_commit");
  await assert.rejects(request("https://example.com/jobs", { maxRetries: 0 }));
  assert.equal(calls, 0);
  assert.equal((await f.ledger.snapshot(f.ref)).usedRequests, 0);
});
test("persisted_model_usage_and_unknown_failures_keep_root_ten_yuan_cap", async (t) => {
  const f = await fixture(t),
    budgets = await createActivityBudgets({
      ledger: f.ledger,
      ref: f.ref,
      token: f.token,
      operationLease: f.lease,
      modelConfig,
    });
  let calls = 0;
  const client = new DeepSeek(
    { deepseek: { ...modelConfig, apiKey: "synthetic-key" } },
    {
      budget: budgets.model,
      retryDelayMs: 0,
      transport: async () => {
        calls++;
        const durable = await f.ledger.snapshot(f.ref);
        assert.equal(durable.reservedCostCny, 2.129152);
        return Response.json({
          choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        });
      },
    },
  );
  assert.equal(
    (
      await client._request([{ role: "user", content: "synthetic" }], {
        retries: 0,
      })
    ).content,
    "answer",
  );
  assert.equal((await f.ledger.snapshot(f.ref)).modelSpendCny, 0.0006);
  const id = await budgets.model.claimRequest(modelConfig);
  await budgets.model.settleRequest(id, undefined);
  assert.equal((await f.ledger.snapshot(f.ref)).unresolvedCostCny, 2.129152);
  assert.equal(calls, 1);
  await f.reopen();
  const reopened = createCollectionLedger({
    repository: f.repository,
    operationGate: f.operationGate,
  });
  const resumed = await createActivityBudgets({
    ledger: reopened,
    ref: f.ref,
    token: f.token,
    operationLease: f.lease,
    modelConfig,
  });
  assert.equal(resumed.model.snapshot().maxCostCny, 10);
  assert.equal(resumed.model.snapshot().costUpperBoundCny, 2.129752);
});
test("limits_adjustment_requires_pause_and_never_resets_usage", async (t) => {
  const f = await fixture(t, { maxRequests: 2 });
  await f.reserve({ kind: "list", requestUpperBound: 2 });
  await assert.rejects(
    f.ledger.adjustLimits({
      ref: f.ref,
      limits: { maxRequests: 3 },
      expectedRevision: 0,
      operationLease: f.lease,
    }),
    { code: "collection_pause_required" },
  );
  await f.repository.mutateWorkspace(
    (w) => {
      const p = w.runs[f.ref.activityId].collectionProgress;
      p.status = "paused";
      p.activeSliceRunId = null;
    },
    { operationLease: f.lease },
  );
  await f.ledger.adjustLimits({
    ref: f.ref,
    limits: { maxRequests: 3 },
    expectedRevision: 0,
    operationLease: f.lease,
  });
  assert.equal((await f.ledger.snapshot(f.ref)).usedRequests, 2);
  assert.equal((await f.ledger.snapshot(f.ref)).maxRequests, 3);
});
test("model_usage_above_actual_reserved_output_stays_uncertain", async (t) => {
  const f = await fixture(t),
    b = await createActivityBudgets({
      ledger: f.ledger,
      ref: f.ref,
      token: f.token,
      operationLease: f.lease,
      modelConfig,
    });
  const id = await b.model.claimRequest({ ...modelConfig, maxOutputTokens: 1 });
  await b.model.settleRequest(id, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
  const view = await f.ledger.snapshot(f.ref);
  assert.equal(view.modelSpendCny, 0);
  assert.equal(view.unresolvedCostCny, 2.09716);
});
test("concurrent_adapters_share_the_secondary_model_attempt_limit", async (t) => {
  const f = await fixture(t),
    opts = {
      ledger: f.ledger,
      ref: f.ref,
      token: f.token,
      operationLease: f.lease,
      modelConfig,
      maxModelRequests: 1,
    };
  const a = await createActivityBudgets(opts),
    b = await createActivityBudgets(opts);
  const outcomes = await Promise.allSettled([
    a.model.claimRequest(modelConfig),
    b.model.claimRequest(modelConfig),
  ]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
});
