import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job, createTempDir } from "../helpers/fixtures.mjs";
import { verifyBundledOcr } from "../../tools/lib/bundled-resources.mjs";
import { createActivityBudgets } from "../../src/application/collection-ledger.mjs";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";
import { createDnsLookup } from "../../src/infrastructure/http/dns.mjs";

test("successful DNS-over-HTTPS attempts settle known request and byte usage", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit(),
    budgets = await createActivityBudgets({
      ledger: f.ledger,
      ref: c.ref,
      token: c.token,
      operationLease: c.lease,
    });
  let bytes = 0;
  const lookup = createDnsLookup({
    mode: "doh",
    budget: budgets.sources,
    transport: async ({ url }) => {
      const text = JSON.stringify({
        Status: 0,
        Answer:
          url.searchParams.get("type") === "A"
            ? [{ type: 1, data: "93.184.216.34", TTL: 30 }]
            : [],
      });
      bytes += Buffer.byteLength(text);
      return { status: 200, text };
    },
  });
  await lookup("jobs.example.org");
  const usage = await f.ledger.snapshot(c.ref);
  assert.equal(usage.knownPhysicalRequests, 2);
  assert.equal(usage.usedBytes, bytes);
  assert.equal(usage.unknownRequestUpperBound, 0);
});

test("ordinary HTTP text responses reserve and settle cumulative bytes before transport", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit(),
    budgets = await createActivityBudgets({
      ledger: f.ledger,
      ref: c.ref,
      token: c.token,
      operationLease: c.lease,
    });
  let during;
  const request = createRequestClient({
    budget: budgets.sources,
    scheduler: createScheduler({ minIntervalMs: 0 }),
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => {
      during = await f.ledger.snapshot(c.ref);
      return { status: 200, headers: {}, text: "public synthetic text" };
    },
  });
  await request("https://jobs.example.org/position", {
    maxBytes: 1000,
    maxRetries: 0,
  });
  assert.equal(during.usedBytes, 1000);
  assert.equal(
    (await f.ledger.snapshot(c.ref)).usedBytes,
    Buffer.byteLength("public synthetic text"),
  );
});
test("end to end restart preserves budget and immutable evidence without cross package writes", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  const record = job({
    bodyStatus: "complete",
    sourceEvidence: [
      {
        field: "degree",
        quote: "本科",
        page: 2,
        cell: "B3",
        sourceUrl: "https://example.com/jobs",
      },
    ],
  });
  const page = {
    pageKey: "e2e-page",
    cursorHash: "hash",
    records: [record],
    issues: [],
    nextCursor: { page: 2 },
    done: false,
  };
  await c.commit(page);
  await c.commit(page);
  const reservation = await f.ledger.reserve({
    ref: c.ref,
    token: c.token,
    operationLease: c.lease,
    reservationId: "model-uncertain",
    kind: "model",
    costUpperBoundCny: 0.7,
    requestUpperBound: 0,
  });
  await f.ledger.settle({
    ref: c.ref,
    operationLease: c.lease,
    reservationId: reservation.reservationId,
  });
  const before = await f.ledger.snapshot(c.ref);
  await c.lease.release();
  await f.reopen();
  const after = await f.ledger.snapshot(c.ref);
  assert.equal(after.usedRequests, before.usedRequests);
  assert.equal(after.unresolvedCostCny, 0.7);
  assert.equal(
    (await f.service.get(c.ref)).collectionProgress.status,
    "paused",
  );
  const w = await f.repository.read();
  assert.equal(Object.keys(w.jobs).length, 1);
  assert.equal(
    Object.values(w.jobs).filter(
      (j) => j.ownerPackageId === f.otherScope.packageId,
    ).length,
    0,
  );
  assert.ok(
    Object.values(w.observations).some((o) => JSON.stringify(o).includes("B3")),
  );
});
test("bundled OCR manifest verifies hashes and rejects tampered runtime files", async (t) => {
  const dir = await createTempDir(t),
    bytes = Buffer.from("synthetic WASM"),
    rel = "node_modules/tesseract.js-core/core.wasm";
  await fs.mkdir(path.join(dir, "app", path.dirname(rel)), { recursive: true });
  await fs.mkdir(path.join(dir, "ocr"), { recursive: true });
  await fs.writeFile(path.join(dir, "app", rel), bytes);
  await fs.writeFile(
    path.join(dir, "ocr/manifest.json"),
    JSON.stringify({
      version: 1,
      files: [
        {
          root: "app",
          path: rel,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
      ],
    }),
  );
  assert.equal(
    (
      await verifyBundledOcr({
        appRoot: path.join(dir, "app"),
        resourceDir: path.join(dir, "ocr"),
      })
    ).verified,
    true,
  );
  await fs.writeFile(path.join(dir, "app", rel), "tampered");
  await assert.rejects(
    verifyBundledOcr({
      appRoot: path.join(dir, "app"),
      resourceDir: path.join(dir, "ocr"),
    }),
    /hash|size/,
  );
});
