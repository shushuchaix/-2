import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createBrowserWindowBudget } from "../../electron/collection/window-budget.mjs";

async function fixture(t, limits = {}) {
  const f = await collectionFixture(t, { limits }),
    c = await f.openCommit();
  const commitBaseline = f.repository.metrics().commits;
  return {
    ...f,
    ...c,
    writes: () => f.repository.metrics().commits - commitBaseline,
  };
}
const reservations = () => [
  {
    reservationId: "window-bytes",
    kind: "browser",
    requestUpperBound: 0,
    bytesUpperBound: 1000,
  },
  ...Array.from({ length: 3 }, (_, i) => ({
    reservationId: "window-" + i,
    kind: "browser",
    requestUpperBound: 1,
    bytesUpperBound: 65536,
  })),
];

for (const stop of ["pause", "cancel"])
  test(`a drained ${stop} confirms sent requests and refunds never-issued slots under its original lease`, async (t) => {
    const f = await fixture(t),
      window = await createBrowserWindowBudget({
        ledger: f.ledger,
        ref: f.ref,
        token: f.token,
        operationLease: f.lease,
      });
    const sent = await window.ledger.reserve({
      kind: "browser",
      requestUpperBound: 1,
    });
    await window.ledger.settle({
      reservationId: sent.reservationId,
      verifiedUsage: { requests: 1, bytes: 0 },
    });
    await f.service[stop](f.ref);
    await window.close({ bytes: 400 });
    const used = await f.ledger.snapshot(f.ref);
    assert.equal(used.usedRequests, 1);
    assert.equal(used.knownPhysicalRequests, 1);
    assert.equal(used.unknownRequestUpperBound, 0);
    assert.equal(used.usedBytes, 400);
    await assert.rejects(
      f.ledger.reserve({
        ref: f.ref,
        token: f.token,
        operationLease: f.lease,
        reservationId: "late-send",
        kind: "browser",
        requestUpperBound: 1,
      }),
      { code: "collection_stale_epoch" },
    );
    assert.equal(
      (await f.service.get(f.ref)).collectionProgress.status,
      stop === "pause" ? "paused" : "cancelled",
    );
  });

test("retired window settlement cannot use another lease or a new active slice", async (t) => {
  const f = await fixture(t),
    window = await createBrowserWindowBudget({
      ledger: f.ledger,
      ref: f.ref,
      token: f.token,
      operationLease: f.lease,
    });
  await f.service.pause(f.ref);
  const w = await f.repository.read(),
    slot = Object.values(
      w.runs[f.ref.activityId].collectionProgress.ledger.reservations,
    ).find((r) => r.requestUpperBound === 1);
  const other = await f.operationGate.acquire("collect", {
    scope: f.ref.scope,
  });
  t.after(() => other.release().catch(() => {}));
  await assert.rejects(
    f.ledger.settleBatch({
      ref: f.ref,
      token: f.token,
      operationLease: other,
      draining: true,
      settlements: [
        {
          reservationId: slot.reservationId,
          verifiedUsage: { requests: 0, bytes: 0 },
        },
      ],
    }),
    { code: "invalid_operation_lease" },
  );
  await f.repository.mutateWorkspace(
    (w) => {
      const p = w.runs[f.ref.activityId].collectionProgress;
      p.epoch++;
      p.status = "collecting";
      p.activeSliceRunId = f.token.sliceRunId;
    },
    { operationLease: f.lease },
  );
  await assert.rejects(window.close({ bytes: 0 }), {
    code: "collection_stale_epoch",
  });
  assert.equal((await f.ledger.snapshot(f.ref)).unknownRequestUpperBound, 60);
});

test("a window can use fewer than sixty remaining requests without raising the original quota", async (t) => {
  const f = await fixture(t, { maxRequests: 2 });
  const window = await createBrowserWindowBudget({
    ledger: f.ledger,
    ref: f.ref,
    token: f.token,
    operationLease: f.lease,
  });
  await window.ledger.reserve({ kind: "browser", requestUpperBound: 1 });
  await window.ledger.reserve({
    kind: "dns",
    requestUpperBound: 1,
    bytesUpperBound: 65536,
  });
  await assert.rejects(
    window.ledger.reserve({ kind: "browser", requestUpperBound: 1 }),
    { code: "source_budget_exhausted" },
  );
  await window.close({ bytes: 0 });
  assert.equal((await f.ledger.snapshot(f.ref)).maxRequests, 2);
});

test("owned window admits resources and DNS from durable slots without per-resource writes", async (t) => {
  const f = await fixture(t);
  const window = await createBrowserWindowBudget({
    ledger: f.ledger,
    ref: f.ref,
    token: f.token,
    operationLease: f.lease,
  });
  assert.equal(f.writes(), 1);
  const http = await window.ledger.reserve({
    kind: "resource",
    requestUpperBound: 1,
  });
  await window.ledger.settle({
    reservationId: http.reservationId,
    verifiedUsage: { requests: 1, bytes: 0 },
  });
  await window.ledger.reserve({
    kind: "dns",
    requestUpperBound: 1,
    bytesUpperBound: 65536,
  });
  assert.equal(f.writes(), 1);
  assert.equal((await f.ledger.snapshot(f.ref)).usedRequests, 60);
  await window.close({ bytes: 400 });
  await window.close({ bytes: 900 });
  assert.equal(f.writes(), 2);
  const used = await f.ledger.snapshot(f.ref);
  assert.equal(used.usedRequests, 2);
  assert.equal(used.knownPhysicalRequests, 1);
  assert.equal(used.unknownRequestUpperBound, 1);
  assert.equal(used.usedBytes, 65936);
  assert.equal(used.byKind.resource, 1);
  assert.equal(used.byKind.dns, 1);
  await assert.rejects(
    window.ledger.reserve({ kind: "browser", requestUpperBound: 1 }),
    { code: "collection_cancelled" },
  );
});

test("window combines DNS and HTTP into the same 60-request ceiling", async (t) => {
  const f = await fixture(t);
  const window = await createBrowserWindowBudget({
    ledger: f.ledger,
    ref: f.ref,
    token: f.token,
    operationLease: f.lease,
  });
  for (let i = 0; i < 60; i++)
    await window.ledger.reserve({
      kind: i % 2 ? "resource" : "dns",
      requestUpperBound: 1,
      bytesUpperBound: i % 2 ? 0 : 65536,
    });
  await assert.rejects(
    window.ledger.reserve({ kind: "resource", requestUpperBound: 1 }),
    { code: "source_budget_exhausted" },
  );
  assert.equal(f.writes(), 1);
  await window.close({ bytes: 0 });
  const used = await f.ledger.snapshot(f.ref);
  assert.equal(used.usedRequests, 60);
  assert.equal(used.unknownRequestUpperBound, 60);
});

test("one durable browser batch precedes transport and one settlement preserves known, unknown and unused slots", async (t) => {
  const f = await fixture(t),
    args = { ref: f.ref, token: f.token, operationLease: f.lease };
  await f.ledger.reserveBatch({ ...args, reservations: reservations() });
  assert.equal(f.writes(), 1);
  assert.equal((await f.ledger.snapshot(f.ref)).unknownRequestUpperBound, 3);
  const disk = await f.repository.read();
  assert.equal(
    Object.keys(
      disk.runs[f.ref.activityId].collectionProgress.ledger.reservations,
    ).length,
    4,
  );
  await f.ledger.settleBatch({
    ...args,
    settlements: [
      {
        reservationId: "window-bytes",
        verifiedUsage: { requests: 0, bytes: 400 },
      },
      {
        reservationId: "window-0",
        kind: "dns",
        verifiedUsage: { requests: 1, bytes: 80 },
      },
      { reservationId: "window-1", kind: "resource" },
      { reservationId: "window-2", verifiedUsage: { requests: 0, bytes: 0 } },
    ],
  });
  assert.equal(f.writes(), 2);
  const used = await f.ledger.snapshot(f.ref);
  assert.equal(used.usedRequests, 2);
  assert.equal(used.knownPhysicalRequests, 1);
  assert.equal(used.unknownRequestUpperBound, 1);
  assert.equal(used.usedBytes, 66016);
  assert.equal(used.byKind.dns, 1);
  assert.equal(used.byKind.resource, 1);
  assert.equal(used.usedDetails, 0);
  assert.equal(used.costUpperBoundCny, 0);
});

test("a browser batch that exceeds the original quota commits no partial reservations", async (t) => {
  const f = await fixture(t, { maxRequests: 2 }),
    before = await f.ledger.snapshot(f.ref);
  await assert.rejects(
    f.ledger.reserveBatch({
      ref: f.ref,
      token: f.token,
      operationLease: f.lease,
      reservations: reservations(),
    }),
    { code: "source_budget_exhausted" },
  );
  assert.deepEqual(await f.ledger.snapshot(f.ref), before);
});

test("browser batch settlement rejects changed epochs and cannot rewrite model or detail credits", async (t) => {
  const f = await fixture(t),
    args = { ref: f.ref, token: f.token, operationLease: f.lease };
  await f.ledger.reserveBatch({ ...args, reservations: reservations() });
  const before = await f.ledger.snapshot(f.ref);
  await assert.rejects(
    f.ledger.settleBatch({
      ...args,
      token: { ...f.token, epoch: 9 },
      settlements: [
        { reservationId: "window-0", verifiedUsage: { requests: 0, bytes: 0 } },
      ],
    }),
    { code: "collection_stale_epoch" },
  );
  await assert.rejects(
    f.ledger.settleBatch({
      ...args,
      settlements: [
        {
          reservationId: "window-0",
          kind: "model",
          verifiedUsage: { requests: 0, bytes: 0 },
        },
      ],
    }),
    { code: "collection_reservation_invalid" },
  );
  await assert.rejects(
    f.ledger.reserveBatch({
      ...args,
      reservations: [
        { reservationId: "model-slot", kind: "model", requestUpperBound: 1 },
      ],
    }),
    { code: "collection_reservation_invalid" },
  );
  await assert.rejects(
    f.ledger.settleBatch({
      ...args,
      settlements: [
        { reservationId: "window-0", verifiedUsage: { requests: 0, bytes: 0 } },
        { reservationId: "missing" },
      ],
    }),
    { code: "collection_reservation_invalid" },
  );
  assert.deepEqual(await f.ledger.snapshot(f.ref), before);
});

test("duplicate IDs and unbounded browser batches are rejected without writes", async (t) => {
  const f = await fixture(t),
    args = { ref: f.ref, token: f.token, operationLease: f.lease };
  for (const list of [
    [],
    [reservations()[0], reservations()[0]],
    Array.from({ length: 65 }, (_, i) => ({
      reservationId: "slot-" + i,
      kind: "browser",
      requestUpperBound: 1,
    })),
  ])
    await assert.rejects(
      f.ledger.reserveBatch({ ...args, reservations: list }),
      { code: "collection_reservation_invalid" },
    );
  assert.equal(f.writes(), 0);
});
