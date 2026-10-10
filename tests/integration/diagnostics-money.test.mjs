import test from "node:test";
import assert from "node:assert/strict";
import { createTempDir } from "../helpers/fixtures.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { cleanMetadata } from "../../src/infrastructure/diagnostics/fields.mjs";

const priceVersion = "deepseek-v4.1-flash-cny-2026-10-07";
test("money diagnostics survive restart with counters and the verified pricing literals", async (t) => {
  const dataDir = await createTempDir(t);
  const log = createDiagnosticsLog({ dataDir });
  await log.record({
    operation: "run.finished",
    usage: {
      model: {
        requests: 31,
        maxRequests: 1000,
        maxCostCny: 10,
        costUpperBoundCny: 0.257631,
        reservedCostCny: 0.032,
        uncertainCostCny: 0.08,
        pricedRequests: 29,
        uncertainRequests: 2,
        costMode: "cny_upper_bound",
        pricingVersion: priceVersion,
        prompt: "private-resume",
        response: "private-response",
        baseUrl: "https://private-endpoint.test/private-key",
        apiKey: "private-key",
        localPath: "C:/private-profile",
      },
    },
  });
  const reopened = createDiagnosticsLog({ dataDir });
  const result = await reopened.list();
  assert.deepEqual(result.entries[0].usage.model, {
    requests: 31,
    maxRequests: 1000,
    maxCostCny: 10,
    costUpperBoundCny: 0.257631,
    reservedCostCny: 0.032,
    uncertainCostCny: 0.08,
    pricedRequests: 29,
    uncertainRequests: 2,
    costMode: "cny_upper_bound",
    pricingVersion: priceVersion,
  });
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  assert.doesNotMatch(await reopened.exportText(), /private-/);
});

test("money diagnostics drop nonnumeric amounts and unknown pricing strings", () => {
  const result = cleanMetadata({
    usage: {
      model: {
        requests: 1,
        maxCostCny: "private-price",
        costUpperBoundCny: Infinity,
        reservedCostCny: -1,
        uncertainCostCny: NaN,
        pricedRequests: 1.1,
        uncertainRequests: -1,
        costMode: "private-prompt",
        pricingVersion: "private-key",
        promptTokens: 32,
      },
    },
  });
  assert.deepEqual(result.usage.model, { requests: 1, promptTokens: 32 });
});

test("zero money values survive diagnostic sanitization", () => {
  assert.deepEqual(
    cleanMetadata({
      usage: {
        model: {
          maxCostCny: 0,
          costUpperBoundCny: 0,
          reservedCostCny: 0,
          uncertainCostCny: 0,
          pricedRequests: 0,
          uncertainRequests: 0,
          costMode: "cny_upper_bound",
          pricingVersion: priceVersion,
        },
      },
    }).usage.model,
    {
      maxCostCny: 0,
      costUpperBoundCny: 0,
      reservedCostCny: 0,
      uncertainCostCny: 0,
      pricedRequests: 0,
      uncertainRequests: 0,
      costMode: "cny_upper_bound",
      pricingVersion: priceVersion,
    },
  );
});
