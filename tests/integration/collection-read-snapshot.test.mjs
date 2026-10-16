import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";

for (const method of ["get", "list"])
  test(`activity ${method} projects progress and usage from one locked snapshot`, async (t) => {
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
    const read = f.repository.read;
    let reads = 0;
    f.repository.read = async () => {
      reads++;
      return read();
    };
    const result =
      method === "get"
        ? await f.service.get(c.ref)
        : (await f.service.list({ scope: f.scope }))[0];
    assert.equal(reads, 1);
    assert.equal(result.runId, c.ref.activityId);
    assert.equal(result.collectionUsage.usedRequests, 1);
    assert.equal(result.collectionUsage.knownPhysicalRequests, 0);
    assert.equal(
      result.collectionProgress.ledger.reservations["observed-request"].status,
      "reserved",
    );
  });
