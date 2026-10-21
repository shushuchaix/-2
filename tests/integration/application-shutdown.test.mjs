import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";

test("application shutdown closes worker and owned resources after an OCR close failure", async (t) => {
  const stops = [];
  const f = await apiFixture(t, {
    dependencies: {
      ocr: {
        close: async () => {
          stops.push("ocr");
          throw Error("private-path");
        },
      },
      anonymousWorker: {
        stop: async () => {
          stops.push("worker");
        },
      },
      stopOwnedResources: async () => {
        stops.push("owned");
      },
    },
  });
  const app = await f.ctx.ready;
  const result = await app.close();
  assert.deepEqual(stops, ["ocr", "worker", "owned"]);
  assert.deepEqual(result.failedResources, ["ocr"]);
  await app.close();
  assert.equal(stops.length, 3);
  const logs = await app.diagnostics.list();
  assert.ok(
    logs.entries.some(
      (entry) =>
        entry.operation === "application.shutdown" &&
        entry.shutdownResource === "ocr" &&
        entry.outcome === "failed",
    ),
  );
  assert.equal(JSON.stringify(logs).includes("private-path"), false);
});
