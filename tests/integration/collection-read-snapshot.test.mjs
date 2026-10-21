import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";

for (const method of ["get", "list"])
  test(`activity ${method} projects bounded progress and usage from one SQL snapshot`, async (t) => {
    const f = await collectionFixture(t),
      c = await f.openCommit();
    await f.ledger.reserve({
      ref: c.ref,
      token: c.token,
      operationLease: c.lease,
      reservationId: "observed-request",
      kind: "browser",
      requestUpperBound: 1,
    });
    f.repository.metrics({ reset: true });
    const result =
      method === "get"
        ? await f.service.get(c.ref)
        : (await f.service.list({ scope: f.scope }))[0];
    const metrics = f.repository.metrics();
    assert.equal(metrics.maintenanceReads, 0);
    assert.equal(metrics.maintenanceMutations, 0);
    assert.equal(metrics.maintenanceExports, 0);
    assert.ok(metrics.decodedRows < 30);
    assert.equal(result.runId, c.ref.activityId);
    assert.equal(result.collectionUsage.usedRequests, 1);
    assert.equal(result.collectionUsage.knownPhysicalRequests, 0);
    assert.equal(result.collectionProgress.ledger.revision, 1);
    assert.equal(result.collectionProgress.ledger.reservations, undefined);
    assert.equal(result.collectionUsage.reservedRequests, 1);
  });
