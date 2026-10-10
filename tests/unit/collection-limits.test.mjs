import test from "node:test";
import assert from "node:assert/strict";
import {
  collectionLimitsFor,
  validateCollectionLimits,
} from "../../public/js/validation-rules.js";

test("new_activity_defaults_and_explicit_legacy_limits", () => {
  const standard = collectionLimitsFor("standard"),
    broad = collectionLimitsFor("broad");
  assert.deepEqual(
    [
      standard.maxSites,
      standard.maxRequests,
      standard.maxPagesPerQuery,
      standard.maxDetails,
      standard.maxQueryGroups,
    ],
    [24, 400, 4, 100, 6],
  );
  assert.deepEqual(
    [
      broad.maxSites,
      broad.maxRequests,
      broad.maxPagesPerQuery,
      broad.maxDetails,
      broad.maxQueryGroups,
    ],
    [50, 1000, 10, 300, 12],
  );
  assert.equal(
    collectionLimitsFor("broad", { maxRequests: 120, maxDetails: 20 })
      .maxRequests,
    120,
  );
  assert.equal(
    collectionLimitsFor("standard", { maxRequests: 1500 }).maxRequests,
    1500,
  );
  assert.equal(
    collectionLimitsFor("standard", { maxRequests: 0 }).maxRequests,
    0,
  );
});
test("collection_limits_enforce_all_resource_and_money_boundaries", () => {
  assert.equal(
    validateCollectionLimits({
      maxRequests: 2000,
      maxPagesPerQuery: 20,
      maxDetails: 600,
      maxSites: 50,
      maxCostCny: 10,
    }).maxRequests,
    2000,
  );
  for (const input of [
    { maxRequests: 2001 },
    { maxSites: 51 },
    { maxPagesPerQuery: 21 },
    { maxDetails: 601 },
    { maxCostCny: 10.01 },
    { maxCostCny: 1.001 },
    { maxRequests: "400" },
    { maxQueryGroups: 13 },
    { maxAttachments: 41 },
    { maxAttachmentBytes: 20971521 },
  ])
    assert.throws(() => validateCollectionLimits(input));
  assert.equal(
    collectionLimitsFor("standard").maxTotalAttachmentBytes,
    209715200,
  );
  assert.equal(collectionLimitsFor("standard").maxPageRequests, 60);
});
