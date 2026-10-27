import test from "node:test";
import assert from "node:assert/strict";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { createModelBudget } from "../../src/llm/budget.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";

function records(count, overrides = () => ({})) {
  return Array.from({ length: count }, (_, index) => job({
    sourceRecordId: "evaluation-batch-" + index,
    url: "https://jobs.example.com/evaluation-batch/" + index,
    title: "合成消防岗位 " + index,
    ...overrides(index),
  }));
}

// Observe actual putRow calls inside the formal fence/SQLite transaction. This
// keeps the real guard, rollback, durable commit and projection code in place.
function observeEvaluationCommits(t, repository, onCommitted) {
  const batches = [], originalFence = repository.withWriteFence;
  t.mock.method(repository, "withWriteFence", async (action, options) => {
    const committed = [];
    const result = await originalFence(async (fence) => {
      const observedFence = Object.create(fence, {
        transaction: { value(selection, transact) {
          const writes = [];
          const receipt = fence.transaction(selection, (tx) => {
            const observedTx = Object.create(tx, {
              putRow: { value(row) {
                const result = tx.putRow(row);
                if (row.collection === "evaluations") writes.push(structuredClone(row.value));
                return result;
              } },
            });
            return transact(observedTx);
          });
          if (writes.length) committed.push(writes);
          return receipt;
        } },
      });
      return action(observedFence);
    }, options);
    for (const saved of committed) {
      batches.push(saved);
      await onCommitted?.(saved, batches);
    }
    return result;
  });
  return batches;
}

async function fixture(t, inputRecords) {
  const f = await packageBusinessFixture(t), { a, b } = await f.twoTargets();
  const ids = await f.ingest(a, inputRecords);
  return { ...f, a, b, ids };
}

async function savedEvaluations(f) {
  return (await f.repository.queryRows({
    collection: "evaluations", ownerPackageId: f.a.packageId, limit: 100,
  }, { scope: f.a })).rows.map(row => row.value);
}

test("formal rules evaluation commits twenty small facts at a time and reuses immutable cached identities", async (t) => {
  const f = await fixture(t, records(41));
  const batches = observeEvaluationCommits(t, f.repository);
  const service = createEvaluationService({ repository: f.repository });
  const result = await service.evaluate({ scope: f.a, jobIds: f.ids, mode: "rules" });
  assert.deepEqual(batches.map(batch => batch.length), [20, 20, 1]);
  assert.deepEqual(batches.flat().map(e => e.jobId), f.ids);
  assert.equal(result.evaluations.length, 41);
  assert.equal(result.usage.requests, 0);
  assert.ok(result.evaluations.every(e => e.status === "rules" && e.recommendation === "insufficient"));
  assert.ok(result.evaluations.every(e => e.targetRevisionId === f.a.targetRevisionId && e.profileRevisionId === f.a.profileSnapshot.revisionId));
  const basis = await f.repository.readView({ select: [{
    collection: "jobFactBasis", ownerPackageId: f.a.packageId,
    ids: result.evaluations.map(e => e.observationId),
  }] }, { scope: f.a });
  for (const e of result.evaluations) assert.equal(basis.rows.jobFactBasis[e.observationId].factContentHash, e.factContentHash);
  const again = await createEvaluationService({ repository: f.repository }).evaluate({ scope: f.a, jobIds: f.ids, mode: "rules" });
  assert.deepEqual(again.evaluations.map(e => e.evaluationId), result.evaluations.map(e => e.evaluationId));
  assert.deepEqual(batches.map(batch => batch.length), [20, 20, 1]);
  assert.equal((await savedEvaluations(f)).length, 41);
  assert.equal((await f.repository.queryRows({ collection: "evaluations", ownerPackageId: f.b.packageId, limit: 1 }, { scope: f.b })).rows.length, 0);
});

test("model requests and their formal commits retain five-record batches", async (t) => {
  const f = await fixture(t, records(11)), requestSizes = [];
  const batches = observeEvaluationCommits(t, f.repository);
  const client = {
    available: true, model: "synthetic-model", baseUrl: "https://model.example.invalid",
    budget: createModelBudget(),
    async chatJson(_system, user) {
      const input = JSON.parse(user).records;
      requestSizes.push(input.length);
      return { results: input.map(r => ({ jobId: r.jobId, score: 75, reasons: [], gaps: [], evidence: [{ excerpt: "负责Java开发" }] })) };
    },
  };
  const result = await createEvaluationService({ repository: f.repository }).evaluate({
    scope: f.a, jobIds: f.ids, mode: "ai", modelClient: client,
  });
  assert.deepEqual(requestSizes, [5, 5, 1]);
  assert.deepEqual(batches.map(batch => batch.length), [5, 5, 1]);
  assert.ok(result.evaluations.every(e => e.status === "ai"));
  // Advice does not supply the independent body/open/application evidence.
  assert.ok(result.evaluations.every(e => e.recommendation === "insufficient"));
});

for (const [mode, expectedBatches, status] of [
  ["ai", [5, 5, 1], "rule_fallback"],
  ["auto", [11], "rules"],
]) {
  test(`${mode} without a model retains its explicit fallback branch`, async (t) => {
    const f = await fixture(t, records(11));
    const batches = observeEvaluationCommits(t, f.repository);
    const result = await createEvaluationService({ repository: f.repository }).evaluate({ scope: f.a, jobIds: f.ids, mode });
    assert.deepEqual(batches.map(batch => batch.length), expectedBatches);
    assert.ok(result.evaluations.every(e => e.status === status));
    assert.equal(result.usage.requests, 0);
    assert.equal(result.issues.some(issue => issue.code === "missing_model_key"), mode === "ai");
  });
}

test("an oversized current fact is persisted alone without truncating or rejecting its evaluation", async (t) => {
  const f = await fixture(t, records(22, index => index === 0 ? {
    description: "负责Java开发，要求本科，2027届毕业。" + "甲".repeat(400000),
  } : {}));
  const batches = observeEvaluationCommits(t, f.repository);
  const result = await createEvaluationService({ repository: f.repository }).evaluate({ scope: f.a, jobIds: f.ids, mode: "rules" });
  assert.deepEqual(batches.map(batch => batch.length), [1, 20, 1]);
  assert.deepEqual(result.evaluations.map(e => e.jobId), f.ids);
  assert.equal((await savedEvaluations(f)).length, 22);
  const first = await f.jobs.getJob(f.ids[0], f.a);
  assert.equal(first.fact.record.description.endsWith("甲".repeat(400000)), true);
  assert.equal(first.evaluation.factContentHash, result.evaluations[0].factContentHash);
});

test("cancellation after a durable rules batch preserves that batch and retries only remaining facts", async (t) => {
  const f = await fixture(t, records(23)), controller = new AbortController();
  const batches = observeEvaluationCommits(t, f.repository, (_saved, all) => {
    if (all.length === 1) controller.abort(new DOMException("Synthetic cancellation", "AbortError"));
  });
  const service = createEvaluationService({ repository: f.repository });
  await assert.rejects(service.evaluate({ scope: f.a, jobIds: f.ids, mode: "rules", signal: controller.signal }), { name: "AbortError" });
  const first = await savedEvaluations(f);
  assert.equal(first.length, 20);
  assert.deepEqual(batches.map(batch => batch.length), [20]);
  const previous = new Map(first.map(e => [e.jobId, e.evaluationId]));
  const retry = await service.evaluate({ scope: f.a, jobIds: f.ids, mode: "rules" });
  assert.deepEqual(batches.map(batch => batch.length), [20, 3]);
  assert.equal((await savedEvaluations(f)).length, 23);
  for (const e of retry.evaluations) if (previous.has(e.jobId)) assert.equal(e.evaluationId, previous.get(e.jobId));
});

test("a stale collection epoch rolls back the entire enlarged rules batch", async (t) => {
  const f = await collectionFixture(t);
  const ids = await f.ingest(f.target, records(21)), commit = await f.openCommit();
  const batches = observeEvaluationCommits(t, f.repository);
  const guard = { ref: commit.ref, token: { ...commit.token, epoch: commit.token.epoch + 1 } };
  await assert.rejects(createEvaluationService({ repository: f.repository, operationGate: f.operationGate }).evaluate({
    scope: f.scope, jobIds: ids, mode: "rules", operationLease: commit.lease, collectionGuard: guard,
  }), { code: "collection_stale_epoch" });
  assert.deepEqual(batches, []);
  assert.equal((await f.repository.queryRows({ collection: "evaluations", ownerPackageId: f.scope.packageId, limit: 100 }, { scope: f.scope })).rows.length, 0);
});
