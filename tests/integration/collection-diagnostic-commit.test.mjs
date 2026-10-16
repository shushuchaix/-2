import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";

const record = (overrides = {}) =>
  job({
    siteId: "s",
    identityScope: "s",
    title: "消防工程师",
    description:
      "消防工程师负责消防设施维护、定期检测、隐患排查和设备运行保障，要求本科及以上学历。",
    detailStatus: "complete",
    bodyStatus: "complete",
    retryEligible: false,
    ...overrides,
  });

async function fixture(t) {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  const commit = (overrides = {}) =>
    f.service.commitDiagnosticRecords({
      ref: c.ref,
      token: c.token,
      unitId: "unit",
      observationKey: "body-recheck-1",
      records: [record()],
      issues: [],
      operationLease: c.lease,
      ...overrides,
    });
  return { f, c, commit };
}

test("diagnostic commit rejects another target scope without storing facts", async (t) => {
  const { f, c, commit } = await fixture(t);
  await assert.rejects(commit({ ref: { ...c.ref, scope: f.otherScope } }), {
    code: "collection_scope",
  });
  assert.deepEqual((await f.repository.read()).jobs, {});
  assert.equal(f.networkCalls, 0);
});

for (const tokenField of ["epoch", "expectedRevision"]) {
  test(`diagnostic commit rejects stale ${tokenField}`, async (t) => {
    const { f, c, commit } = await fixture(t);
    await assert.rejects(
      commit({ token: { ...c.token, [tokenField]: c.token[tokenField] + 1 } }),
      { code: "collection_stale_epoch" },
    );
    assert.deepEqual((await f.repository.read()).observations, {});
  });
}

test("diagnostic commit requires the original live collect lease", async (t) => {
  const { f, c, commit } = await fixture(t);
  await assert.rejects(commit({ operationLease: undefined }), {
    code: "invalid_operation_lease",
  });
  await assert.rejects(
    commit({ operationLease: { ...c.lease, token: "forged" } }),
    { code: "invalid_operation_lease" },
  );
  assert.deepEqual((await f.repository.read()).jobs, {});
});

for (const overrides of [
  { siteId: "another-site" },
  { sourceId: "another-source" },
]) {
  test(`diagnostic commit rejects mismatched ${Object.keys(overrides)[0]}`, async (t) => {
    const { f, commit } = await fixture(t);
    await assert.rejects(commit({ records: [record(overrides)] }), {
      code: "collection_diagnostic_source_mismatch",
    });
    assert.deepEqual((await f.repository.read()).jobs, {});
    assert.deepEqual((await f.repository.read()).sourceHealth, {});
  });
}

test("diagnostic commit validates the source record contract before storing", async (t) => {
  const { f, commit } = await fixture(t);
  await assert.rejects(commit({ records: [record({ url: "not-a-url" })] }), {
    code: "collection_diagnostic_invalid",
  });
  assert.deepEqual((await f.repository.read()).jobs, {});
});

test("diagnostic commit appends facts, health and run counts without changing a completed unit", async (t) => {
  const { f, c, commit } = await fixture(t);
  await f.repository.mutateWorkspace(
    (w) => {
      const p = w.runs[c.ref.activityId].collectionProgress;
      Object.assign(p.units.unit, {
        status: "completed",
        cursor: { page: 7 },
        committedPages: 3,
        committedPageKeys: [
          "original-page-1",
          "original-page-2",
          "original-page-3",
        ],
        seenIds: ["previous-id"],
        seenCursorHashes: ["previous-cursor"],
        lastSuccessAt: "2026-10-08T00:00:00.000Z",
        lastAttemptAt: "2026-10-08T00:00:00.000Z",
        refreshRound: 2,
        roundPages: 3,
      });
      p.metrics = { committedPages: 3, newUnique: 2 };
    },
    { operationLease: c.lease },
  );
  const before = await f.repository.read(),
    result = await commit({
      issues: [
        { code: "detail_insufficient", message: "private diagnostic text" },
      ],
    }),
    after = await f.repository.read(),
    root = after.runs[c.ref.activityId],
    child = after.runs[c.token.sliceRunId];
  assert.equal(result.duplicate, false);
  assert.equal(result.sliceRunId, c.token.sliceRunId);
  assert.equal(result.jobIds.length, 1);
  assert.equal(result.observationIds.length, 1);
  assert.deepEqual(
    root.collectionProgress.units,
    before.runs[c.ref.activityId].collectionProgress.units,
  );
  assert.deepEqual(
    root.collectionProgress.ledger,
    before.runs[c.ref.activityId].collectionProgress.ledger,
  );
  assert.deepEqual(
    root.collectionProgress.limits,
    before.runs[c.ref.activityId].collectionProgress.limits,
  );
  assert.equal(root.collectionProgress.metrics.committedPages, 3);
  assert.equal(root.collectionProgress.metrics.newUnique, 3);
  assert.deepEqual(root.collectionProgress.newJobIds, result.newForTarget);
  assert.deepEqual(child.jobIds, result.jobIds);
  assert.deepEqual(child.counts, {
    raw: 1,
    normalized: 1,
    newForTarget: 1,
    notices: 0,
    deduplicated: 1,
  });
  assert.equal(after.sourceHealth["synthetic/s"].capabilities.body, "verified");
  assert.equal(
    after.observations[result.observationIds[0]].runId,
    c.token.sliceRunId,
  );
  assert.equal(
    after.observations[result.observationIds[0]].ownerPackageId,
    c.ref.scope.packageId,
  );
  assert.equal(child.issues[0].code, "detail_insufficient");
  assert.doesNotMatch(JSON.stringify(child.issues), /private diagnostic text/);
  assert.deepEqual(after.evaluations, {});
  assert.equal(f.networkCalls, 0);
});

test("diagnostic run and source health never persist unknown upstream codes or fields", async (t) => {
  const { f, c, commit } = await fixture(t);
  await commit({
    records: [],
    issues: [
      {
        code: "private-token-material",
        message: "private text",
        url: "https://private.invalid/",
        headers: { authorization: "private" },
        sourceId: "another",
        siteId: "another",
        retryable: true,
      },
    ],
  });
  const w = await f.repository.read();
  assert.deepEqual(w.runs[c.token.sliceRunId].issues, [
    {
      code: "source_probe_failed",
      sourceId: "synthetic",
      siteId: "s",
      retryable: true,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(w.sourceHealth),
    /private-token-material|private text|private\.invalid|authorization/,
  );
});

test("diagnostic observation key replay returns original job IDs without counting or refreshing health", async (t) => {
  const { f, c, commit } = await fixture(t),
    first = await commit(),
    before = await f.repository.read();
  f.clock.advance(1000);
  const repeated = await commit(),
    after = await f.repository.read();
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.jobIds, first.jobIds);
  assert.deepEqual(repeated.observationIds, first.observationIds);
  assert.deepEqual(repeated.newForTarget, first.newForTarget);
  assert.deepEqual(after.runs, before.runs);
  assert.deepEqual(after.sourceHealth, before.sourceHealth);
  assert.deepEqual(after.observations, before.observations);
  await assert.rejects(
    commit({ token: { ...c.token, epoch: c.token.epoch + 1 } }),
    { code: "collection_stale_epoch" },
  );
});

test("diagnostic observation keys survive reopening and a new guarded slice", async (t) => {
  const { f, c, commit } = await fixture(t),
    first = await commit();
  await c.lease.release();
  await f.reopen();
  const before = await f.repository.read();
  await f.service.withDiagnosticContext(
    { ref: c.ref, requestId: "replay-after-reopen" },
    async (ctx) => {
      const repeated = await f.service.commitDiagnosticRecords({
        ref: c.ref,
        token: ctx.token,
        unitId: "unit",
        observationKey: "body-recheck-1",
        records: [record()],
        operationLease: ctx.operationLease,
      });
      assert.equal(repeated.duplicate, true);
      assert.deepEqual(repeated.jobIds, first.jobIds);
      assert.equal(repeated.sliceRunId, first.sliceRunId);
      assert.equal(
        (await f.repository.read()).runs[ctx.token.sliceRunId].counts.raw,
        0,
      );
    },
  );
  const after = await f.repository.read();
  assert.deepEqual(after.observations, before.observations);
  assert.deepEqual(after.sourceHealth, before.sourceHealth);
  assert.deepEqual(
    after.runs[c.ref.activityId].collectionProgress.units,
    before.runs[c.ref.activityId].collectionProgress.units,
  );
  assert.deepEqual(
    after.runs[c.token.sliceRunId].counts,
    before.runs[c.token.sliceRunId].counts,
  );
});

test("a failed diagnostic transaction stores neither facts nor its idempotency key", async (t) => {
  const { f, c, commit } = await fixture(t),
    before = await f.repository.read();
  f.armFailure("workspace_commit");
  await assert.rejects(commit(), /synthetic storage failure/);
  const failed = await f.repository.read();
  assert.deepEqual(failed.jobs, before.jobs);
  assert.deepEqual(failed.observations, before.observations);
  assert.deepEqual(failed.sourceHealth, before.sourceHealth);
  assert.deepEqual(
    failed.runs[c.ref.activityId],
    before.runs[c.ref.activityId],
  );
  assert.deepEqual(
    failed.runs[c.token.sliceRunId],
    before.runs[c.token.sliceRunId],
  );
  assert.equal((await commit()).duplicate, false);
});
