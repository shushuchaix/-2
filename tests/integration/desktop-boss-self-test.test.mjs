import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { runBossSelfTest } from "../../electron/self-test-boss.mjs";

test("packaged Boss contracts exercise isolated persisted pages, risk and cancelled late results without transport", async (t) => {
  const f = await packageBusinessFixture(t);
  const { a, b } = await f.twoTargets();
  await fs.writeFile(path.join(f.dataDir, ".rjr-self-test"), "synthetic");
  const result = await runBossSelfTest({
    context: f,
    targets: [a, b],
    dataDir: f.dataDir,
  });
  assert.equal(result.failed, 0, JSON.stringify(result.results));
  assert.ok(result.passed >= 10);
  assert.deepEqual(result.summary.pagesByVersion, [2, 2]);
  assert.deepEqual(result.summary.jobsByVersion, [2, 2]);
  assert.deepEqual(result.summary.methods, ["GET", "POST"]);
  assert.equal(result.summary.cancelledStatus, "cancelled");
  assert.equal(result.summary.cancelledJobCount, 0);
  assert.equal(result.summary.crossScopeCode, "collection_session_scope");
  assert.equal(result.summary.riskCode, "boss_risk_blocked");
  assert.equal(result.summary.revokedCode, "collection_session_scope");
  const w = await f.repository.read();
  const roots = Object.values(w.runs).filter(
    (r) => r.collectionRole === "collection_root",
  );
  assert.equal(roots.length, 4);
  assert.equal(
    Object.values(w.jobs).filter((j) => j.ownerPackageId === a.packageId)
      .length,
    2,
  );
  assert.equal(
    Object.values(w.jobs).filter((j) => j.ownerPackageId === b.packageId)
      .length,
    2,
  );
  assert.doesNotMatch(
    JSON.stringify(w),
    /synthetic-private-read-ref|synthetic-private-lid|securityId/,
  );
});

test("packaged Boss diagnostic refuses a daily workspace before any mutation", async (t) => {
  const f = await packageBusinessFixture(t);
  const { a, b } = await f.twoTargets();
  const before = await f.repository.read();
  await assert.rejects(
    runBossSelfTest({ context: f, targets: [a, b], dataDir: f.dataDir }),
    /unsafe_self_test_directory/,
  );
  assert.deepEqual(await f.repository.read(), before);
});
