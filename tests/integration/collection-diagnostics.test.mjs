import test from "node:test";
import assert from "node:assert/strict";
import { cleanMetadata } from "../../src/infrastructure/diagnostics/fields.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
import { safeApiRoute } from "../../public/js/diagnostic-rules.js";
test("collection diagnostic counts retain physical resource totals and discard private material", () => {
  const secret = "PRIVATE_SENTINEL";
  const result = cleanMetadata({
    counts: { physicalRequests: 12, bodyVerified: 4, validNewUnique: 2 },
    engine: "browser",
    cursor: secret,
    headers: { Cookie: secret },
    stderr: secret,
    body: secret,
    path: secret,
    activityId: "c-12345678-1234-1234-1234-123456789abc",
    unitId: secret,
  });
  assert.equal(result.counts.physicalRequests, 12);
  assert.equal(result.engine, "browser");
  assert.equal(JSON.stringify(result).includes(secret), false);
});
test("collection diagnostics export retains white list counts and no cursor or worker stderr", async (t) => {
  const log = createDiagnosticsLog({ dataDir: await createTempDir(t) }),
    secret = "PRIVATE_SENTINEL";
  await log.record(
    {
      operation: "collection.page",
      counts: { physicalRequests: 12, bodyVerified: 4, validNewUnique: 2 },
      cursor: secret,
      stderr: secret,
      body: secret,
    },
    Error(secret),
  );
  const text = await log.exportText({});
  assert.equal(text.includes(secret), false);
  assert.match(text, /physicalRequests/);
  assert.match(text, /12/);
  assert.equal(
    safeApiRoute("/api/v2/collections/" + secret + "/resume?token=" + secret),
    "/api/v2/collections/:id/resume",
  );
});
