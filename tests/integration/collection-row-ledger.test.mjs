import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { collectionFixture } from "../helpers/collection-fixture.mjs";

test("row ledger keeps one identity and only the original browser lease can settle during drain", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  f.repository.metrics({ reset: true });
  const input = {
    ref: c.ref,
    token: c.token,
    operationLease: c.lease,
    reservations: [
      {
        reservationId: "browser-one",
        kind: "browser",
        requestUpperBound: 1,
        bytesUpperBound: 100,
      },
    ],
  };
  await f.ledger.reserveBatch(input);
  assert.equal(
    (await f.ledger.reserveBatch(input)).reservations[0].duplicate,
    true,
  );
  await assert.rejects(
    f.ledger.reserveBatch({
      ...input,
      reservations: [{ ...input.reservations[0], bytesUpperBound: 99 }],
    }),
    { code: "collection_reservation_conflict" },
  );
  const other = await f.operationGate.acquire("collect", { scope: f.scope });
  try {
    await assert.rejects(
      f.ledger.settleBatch({
        ...input,
        operationLease: other,
        settlements: [
          {
            reservationId: "browser-one",
            verifiedUsage: { requests: 1, bytes: 10 },
          },
        ],
      }),
      { code: "invalid_operation_lease" },
    );
  } finally {
    await other.release();
  }
  await f.ledger.settleBatch({
    ...input,
    settlements: [
      {
        reservationId: "browser-one",
        kind: "dns",
        verifiedUsage: { requests: 1, bytes: 10 },
      },
    ],
  });
  const usage = await f.ledger.snapshot(c.ref);
  assert.equal(usage.usedRequests, 1);
  assert.equal(usage.knownPhysicalRequests, 1);
  assert.equal(usage.usedBytes, 10);
  const metrics = f.repository.metrics();
  assert.equal(metrics.maintenanceReads, 0);
  assert.equal(metrics.maintenanceMutations, 0);
  assert.equal(metrics.maintenanceExports, 0);
  await f.service.pause(c.ref);
});

test("independent processes compete for the same last durable request allowance", async (t) => {
  const f = await collectionFixture(t, { limits: { maxRequests: 1 } }),
    c = await f.openCommit();
  const repositoryUrl = new URL(
      "../../src/infrastructure/storage/repository.mjs",
      import.meta.url,
    ).href,
    ledgerUrl = new URL(
      "../../src/application/collection-ledger.mjs",
      import.meta.url,
    ).href,
    guard = new URL("../helpers/network-guard.mjs", import.meta.url).href;
  const source = `const {openWorkspaceRepository}=await import(${JSON.stringify(repositoryUrl)});const{createCollectionLedger}=await import(${JSON.stringify(ledgerUrl)});const input=JSON.parse(process.argv[1]);const repository=await openWorkspaceRepository({dataDir:input.dataDir});try{await createCollectionLedger({repository}).reserve({...input.claim,kind:'list',requestUpperBound:1});process.stdout.write('reserved');}catch(error){process.stdout.write(error.code);}finally{await repository.close();}`;
  const run = (id) =>
    new Promise((resolve, reject) => {
      const claim = {
        ref: c.ref,
        token: c.token,
        operationLease: {
          operationId: c.lease.operationId,
          token: c.lease.token,
        },
        reservationId: id,
      };
      const child = spawn(
        process.execPath,
        [
          "--import",
          guard,
          "--input-type=module",
          "-e",
          source,
          JSON.stringify({ dataDir: f.dataDir, claim }),
        ],
        {
          env: { ...process.env, RJR_DISABLE_LOCAL_CREDENTIALS: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (errors += chunk));
      child.on("error", reject);
      child.on("exit", (code) =>
        code ? reject(Error(errors)) : resolve(output),
      );
    });
  const results = await Promise.all([run("process-a"), run("process-b")]);
  assert.deepEqual(results.sort(), ["reserved", "source_budget_exhausted"]);
  assert.equal((await f.ledger.snapshot(c.ref)).usedRequests, 1);
  await f.service.pause(c.ref);
});
