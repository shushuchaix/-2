import test from "node:test";
import assert from "node:assert/strict";
import { buildCollectionPlan } from "../../src/sources/planning.mjs";
const now = Date.parse("2026-10-09T00:00:00Z");
const target = {
  roles: ["消防"],
  sourceIds: [],
  siteIds: [],
  cities: [],
  cityMode: "any",
  budgets: {},
};
const catalog = Array.from({ length: 30 }, (_, i) => ({
  siteId: "site-" + String(i + 1).padStart(2, "0"),
  providerId: "p",
  name: "合成",
  category: "employer",
  status: "ready",
  verifiedAt: "2026-10-08T00:00:00Z",
  probeEvidence: [{ hasRequirements: true }],
  origin: "https://jobs.example.org",
}));
test("rotation_prioritizes_unchecked_sites_and_preserves_limits_above_old_defaults", () => {
  const first = buildCollectionPlan({
    target,
    catalog,
    ownedState: { sourceStates: {} },
    mode: "standard",
    now,
  });
  assert.equal(new Set(first.units.map((u) => u.siteId)).size, 24);
  const sourceStates = Object.fromEntries(
    [...new Set(first.units.map((u) => u.siteId))].map((id) => [
      "p/" + id,
      { lastAttemptAt: new Date(now).toISOString() },
    ]),
  );
  const second = buildCollectionPlan({
    target,
    catalog,
    ownedState: { sourceStates },
    mode: "standard",
    now: now + 86400001,
  });
  assert.equal(second.units[0].siteId, "site-25");
  assert.equal(first.limits.maxRequests, 400);
  const explicit = buildCollectionPlan({
    target: { ...target, budgets: { maxRequests: 1500, maxPagesPerQuery: 15 } },
    catalog,
    ownedState: {},
    now,
  });
  assert.equal(explicit.limits.maxRequests, 1500);
  assert.equal(explicit.units[0].query.pageLimit, 15);
});
test("disabled_unprobed_stale_and_backoff_sources_are_excluded_and_cursors_are_owned", () => {
  const list = [
    ...catalog,
    { ...catalog[0], siteId: "candidate", status: "candidate" },
    { ...catalog[0], siteId: "unprobed", verifiedAt: null, probeEvidence: [] },
    { ...catalog[0], siteId: "stale", verifiedAt: "2025-01-01" },
  ];
  const plan = buildCollectionPlan({
    target,
    catalog: list,
    ownedState: {
      sourceStates: {
        "p/site-01": {
          cursor: { page: 3 },
          lastAttemptAt: "2026-10-09T00:00:00Z",
        },
      },
    },
    sourceOverrides: { p: { enabled: false } },
    now,
  });
  assert.equal(plan.units.length, 0);
  const another = buildCollectionPlan({
    target,
    catalog: list,
    ownedState: {},
    now,
  });
  assert.ok(
    another.units.every(
      (u) => !["candidate", "unprobed", "stale"].includes(u.siteId),
    ),
  );
  assert.equal(another.units[0].cursor, null);
});
