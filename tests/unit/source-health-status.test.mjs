import test from "node:test";
import assert from "node:assert/strict";
import { recordSourceHealth } from "../../src/application/source-health.mjs";
import { hasRecentSourceProof } from "../../src/sources/source-quality.mjs";

test("budget blocked source attempts do not mark a site inaccessible or set network backoff", () => {
  const workspace = { sourceHealth: {} };
  const health = recordSourceHealth(
    workspace,
    {
      sourceId: "synthetic",
      siteId: "synthetic-1",
      status: "unavailable",
      issues: [
        { code: "source_budget_exhausted", message: "synthetic private query" },
      ],
    },
    Date.parse("2026-10-11T00:00:00Z"),
  );
  assert.equal(health.status, "budget_exhausted");
  assert.equal(health.backoffUntil, null);
  assert.deepEqual(health.issues, [
    {
      code: "source_budget_exhausted",
      sourceId: "synthetic",
      siteId: "synthetic-1",
    },
  ]);
  assert.equal(JSON.stringify(health).includes("private"), false);
});

test("source health keeps safe diagnostic references and clears stale errors on a successful attempt", () => {
  const workspace = { sourceHealth: {} };
  const diagnosticId = "d-12345678-1234-1234-1234-123456789abc";
  const first = recordSourceHealth(
    workspace,
    {
      sourceId: "synthetic",
      siteId: "synthetic-1",
      status: "unavailable",
      issues: [
        {
          code: "request_timeout",
          diagnosticId,
          retryable: true,
          message: "secret",
          raw: "secret",
        },
        { code: "synthetic-private-canary", diagnosticId: "secret" },
      ],
    },
    1000,
  );
  assert.equal(first.issues[0].diagnosticId, diagnosticId);
  assert.equal(first.issues[1].code, "source_probe_failed");
  assert.equal(JSON.stringify(first).includes("secret"), false);
  const success = recordSourceHealth(
    workspace,
    {
      sourceId: "synthetic",
      siteId: "synthetic-1",
      status: "ready",
      capabilities: { body: "verified" },
    },
    2000,
  );
  assert.deepEqual(success.issues, []);
  const blocked = recordSourceHealth(
    workspace,
    {
      sourceId: "synthetic",
      siteId: "synthetic-1",
      status: "unavailable",
      issues: [{ code: "budget_exhausted" }],
    },
    3000,
  );
  assert.equal(blocked.lastSuccessAt, success.checkedAt);
  assert.equal(blocked.capabilities.body, "verified");
});

test("a real network failure accompanying budget exhaustion remains a network failure", () => {
  const health = recordSourceHealth(
    { sourceHealth: {} },
    {
      sourceId: "synthetic",
      siteId: "synthetic-1",
      status: "unavailable",
      issues: [
        { code: "request_timeout" },
        { code: "source_budget_exhausted" },
      ],
    },
    1000,
  );
  assert.equal(health.status, "unavailable");
  assert.ok(health.backoffUntil);
});
test("a transient failed attempt keeps separate historical capability proof for scheduling", () => {
  const w = { sourceHealth: {} },
    sourceId = "synthetic",
    siteId = "site",
    now = Date.parse("2026-10-11T00:00:00Z");
  recordSourceHealth(
    w,
    {
      sourceId,
      siteId,
      status: "ready",
      capabilities: { list: "verified", body: "verified" },
    },
    now - 1000,
  );
  const health = recordSourceHealth(
    w,
    {
      sourceId,
      siteId,
      status: "unavailable",
      issues: [{ code: "source_budget_exhausted" }],
      capabilities: { list: "unverified", body: "unverified" },
    },
    now,
  );
  assert.equal(health.capabilities.body, "unverified");
  assert.equal(health.lastSuccessCapabilities.body, "verified");
  assert.equal(
    hasRecentSourceProof(
      { providerId: sourceId, siteId, status: "candidate" },
      health,
      now,
    ),
    true,
  );
});
