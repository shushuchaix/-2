import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createRunEventHub } from "../../src/application/run-events.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { registerTestResource } from "../helpers/fixtures.mjs";

test("empty event polls read one head, another connection is visible, and revoked scopes close the subscription", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit(),
    seen = [],
    closed = [];
  const hub = createRunEventHub({
    repository: f.repository,
    maxBuffered: 2,
    pollIntervalMs: 15,
  });
  const other = await openWorkspaceRepository({
    dataDir: f.dataDir,
    clock: f.clock,
  });
  registerTestResource(t, () => other.close());
  const unsubscribe = await hub.subscribe(c.token.sliceRunId, {
    scope: f.scope,
    onEvent: (event) => seen.push(event),
    onClose: (error) => closed.push(error),
  });
  t.after(unsubscribe);
  await delay(20);
  assert.equal(seen[0].type, "snapshot");
  f.repository.metrics({ reset: true });
  await delay(60);
  const metrics = f.repository.metrics();
  assert.equal(metrics.maintenanceReads, 0);
  assert.equal(metrics.maintenanceExports, 0);
  assert.ok(metrics.decodedRows < 30);
  assert.ok(metrics.decodedBytes < 20000);
  await createRunEventHub({ repository: other, maxBuffered: 2 }).publish(
    c.token.sliceRunId,
    "stage",
    { stage: "cross-connection" },
    f.scope,
  );
  await delay(60);
  assert.equal(seen.at(-1).seq, 1);
  assert.equal(seen.at(-1).payload.stage, "cross-connection");
  await f.service.pause(c.ref);
  await c.lease.release();
  await f.trash.archive({ packageId: f.scope.packageId });
  await delay(60);
  assert.equal(closed.length, 1);
  unsubscribe();
  await f.service.stop();
});
