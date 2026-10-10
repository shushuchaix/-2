import test from "node:test";
import assert from "node:assert/strict";
test("missing results and a single 404 never confirm closed", async () => {
  const { deriveLifecycle } = await import("../../src/domain/lifecycle.mjs");
  assert.equal(
    deriveLifecycle({
      previous: { lifecycle: "observed" },
      observations: [],
      coverage: [],
    }).state,
    "observed",
  );
  assert.equal(
    deriveLifecycle({
      previous: { lifecycle: "observed" },
      detailEvidence: [{ status: 404, url: "https://x.example/1" }],
    }).state,
    "inaccessible",
  );
  assert.equal(
    deriveLifecycle({
      detailEvidence: [
        { closed: true, reason: "原站已结束招聘", url: "https://x.example/1" },
      ],
    }).state,
    "closed",
  );
});
test("absence requires repeated same target source query success and deadline is separate", async () => {
  const { deriveLifecycle } = await import("../../src/domain/lifecycle.mjs");
  const previous = {
    lifecycle: "observed",
    canonical: { deadlineAt: "2026-10-01T00:00:00Z" },
    absenceCounts: { "t1|s1|site1|q1": 1 },
  };
  const coverage = [
    {
      status: "complete",
      targetId: "t2",
      sourceId: "s1",
      siteId: "site1",
      scopeKey: "t2|s1|site1|q1",
      previouslyObserved: false,
    },
  ];
  assert.equal(
    deriveLifecycle({ previous, coverage, now: "2026-10-05T00:00:00Z" }).state,
    "observed",
  );
  assert.equal(
    deriveLifecycle({ previous, coverage, now: "2026-10-05T00:00:00Z" })
      .deadlinePassed,
    true,
  );
  assert.equal(
    deriveLifecycle({
      previous,
      coverage: [
        {
          ...coverage[0],
          scopeKey: "t1|s1|site1|q1",
          previouslyObserved: true,
        },
      ],
    }).state,
    "notRecentlySeen",
  );
});
