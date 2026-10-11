import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";

const mode = process.argv[2];
const controller = new AbortController();
const reason = Object.assign(Error("synthetic cancellation"), {
  code: "synthetic_cancel",
});
const counts = { unhandled: 0, transport: 0, claims: 0, settlements: 0 };
process.on("unhandledRejection", () => counts.unhandled++);
let caught;
const request = createRequestClient({
  scheduler: createScheduler({ minIntervalMs: 0 }),
  dnsLookup: async () => {
    if (mode === "dns") {
      controller.abort(reason);
      throw reason;
    }
    return [{ address: "93.184.216.34", family: 4 }];
  },
  budget: {
    claimRequest: async () => {
      counts.claims++;
      if (mode === "budget") controller.abort(reason);
      if (mode === "timeout")
        await new Promise((resolve) => setTimeout(resolve, 30));
      return "synthetic-reservation";
    },
    settleRequest: async () => counts.settlements++,
  },
  transport: async ({ signal }) => {
    counts.transport++;
    signal.throwIfAborted();
    return { status: 200, headers: {}, text: "ok" };
  },
});
try {
  await request("https://jobs.example.com/list", {
    signal: controller.signal,
    timeoutMs: mode === "timeout" ? 5 : 1000,
    maxRetries: 0,
  });
} catch (error) {
  caught = error;
}
await new Promise((resolve) => setTimeout(resolve, 20));
process.stdout.write(
  JSON.stringify({
    ...counts,
    reasonPreserved: caught === reason,
    errorName: caught?.name,
  }),
);
