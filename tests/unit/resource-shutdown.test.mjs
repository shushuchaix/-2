import test from "node:test";
import assert from "node:assert/strict";
import { createResourceShutdown } from "../../src/infrastructure/lifecycle/resource-shutdown.mjs";

test("shutdown drains later resources after rejection and reports only resource IDs", async () => {
  const stops = [],
    failures = [];
  const shutdown = createResourceShutdown({
    resources: () => [
      {
        id: "refresh",
        stop: async () => {
          stops.push("refresh");
          throw Error("private-path");
        },
      },
      {
        id: "browser",
        stop: async () => {
          stops.push("browser");
        },
      },
      {
        id: "server",
        stop: async () => {
          stops.push("server");
        },
      },
    ],
    onError: async (id) => {
      failures.push(id);
      throw Error("observer failed");
    },
  });
  const result = await shutdown.close();
  assert.deepEqual(stops, ["refresh", "browser", "server"]);
  assert.deepEqual(failures, ["refresh"]);
  assert.deepEqual(result, { failedResources: ["refresh"] });
  assert.equal(shutdown.complete, true);
});

test("concurrent and repeated shutdown calls share one drain and completion state", async () => {
  let calls = 0,
    release;
  const shutdown = createResourceShutdown({
    resources: () => [
      {
        id: "worker",
        stop: async () => {
          calls++;
          await new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    ],
  });
  const first = shutdown.close(),
    second = shutdown.close();
  assert.equal(first, second);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(shutdown.complete, false);
  release();
  await Promise.all([first, second]);
  await shutdown.close();
  assert.equal(calls, 1);
  assert.equal(shutdown.complete, true);
});
