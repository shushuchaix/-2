import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../../public/js/api.js";

test("a stalled diagnostic reporter cannot hide a connection failure", async () => {
  const api = createApiClient({
    fetchImpl: async () => {
      throw Error("unavailable");
    },
    reportDiagnostic: () => new Promise(() => {}),
  });
  let timer;
  try {
    const result = await Promise.race([
      api.request("/runs").catch((error) => error.code),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("blocked"), 1200);
      }),
    ]);
    assert.equal(result, "network_error");
  } finally {
    clearTimeout(timer);
  }
});

test("connection failure receives a local diagnostic without sending private request data", async () => {
  const reports = [];
  const api = createApiClient({
    fetchImpl: async () => {
      throw Error("private network detail");
    },
    reportDiagnostic: async (event) => {
      reports.push(event);
      return { diagnosticId: "d-00000000-0000-4000-8000-000000000001" };
    },
  });
  await assert.rejects(
    api.request("/jobs/private-id/application?secret=private-query", {
      method: "PUT",
      headers: { Authorization: "private-key" },
      body: { notes: "private resume" },
    }),
    (error) => {
      assert.equal(error.code, "network_error");
      assert.match(error.diagnosticId || "", /^d-/);
      return true;
    },
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0].operation, "renderer.request");
  assert.equal(reports[0].route, "/api/v2/jobs/:id/application");
  assert.equal(reports[0].method, "PUT");
  assert.match(reports[0].requestId, /^q-[a-f0-9-]{36}$/);
  assert.equal(JSON.stringify(reports).includes("private"), false);
});

test("invalid successful JSON reports response format failure with status", async () => {
  const reports = [];
  const api = createApiClient({
    fetchImpl: async () =>
      new Response("private invalid JSON", { status: 200 }),
    reportDiagnostic: async (event) => reports.push(event),
  });
  await assert.rejects(
    api.request("/settings"),
    (error) => error.code === "response_format_error",
  );
  assert.equal(reports[0]?.phase, "parse");
  assert.equal(reports[0]?.httpStatus, 200);
  assert.equal(JSON.stringify(reports).includes("private"), false);
});

test("server failures keep their diagnostic number when the reporting sink fails", async () => {
  const api = createApiClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: "保存失败", diagnosticId: "diag-server" }),
        { status: 500 },
      ),
    reportDiagnostic: async () => {
      throw Error("sink failed");
    },
  });
  await assert.rejects(
    api.request("/settings", { method: "PUT" }),
    (error) => error.diagnosticId === "diag-server" && error.status === 500,
  );
});

test("cancellation and diagnostic reads do not recursively report errors", async () => {
  const reports = [];
  const controller = new AbortController();
  controller.abort();
  const api = createApiClient({
    fetchImpl: async (_, options) => {
      options.signal?.throwIfAborted();
      throw Error("unavailable");
    },
    reportDiagnostic: async (event) => reports.push(event),
  });
  await assert.rejects(api.request("/jobs", { signal: controller.signal }), {
    name: "AbortError",
  });
  await assert.rejects(
    api.request("/diagnostics/logs"),
    (error) => error.code === "network_error",
  );
  assert.equal(reports.length, 0);
});

test("exhausted event reconnection records retry metadata and no event payload", async () => {
  const reports = [];
  let connections = 0;
  const api = createApiClient({
    fetchImpl: async () => {
      connections++;
      return new Response("private malformed event\n", { status: 200 });
    },
    waitForRetry: async () => {},
    reportDiagnostic: async (event) => reports.push(event),
  });
  await assert.rejects(
    api.streamRun("r-synthetic", { onEvent: () => {} }),
    /事件/,
  );
  assert.equal(connections, 5);
  assert.ok(
    reports.some(
      (event) =>
        event.operation === "renderer.stream" &&
        event.outcome === "failed" &&
        event.retryCount === 4,
    ),
  );
  assert.equal(JSON.stringify(reports).includes("private"), false);
});

test("known API routes erase identifiers and unknown or hostile routes erase the whole path", async () => {
  const module = await import("../../public/js/diagnostic-rules.js").catch(
    () => null,
  );
  assert.ok(module, "shared safe route normalizer is available");
  for (const [input, expected] of [
    [
      "/api/v2/jobs/private-job/application?notes=private",
      "/api/v2/jobs/:id/application",
    ],
    ["/api/v2/runs/private-run/events?afterSeq=5", "/api/v2/runs/:id/events"],
    ["/api/tracking/jobs/private-job", "/api/tracking/jobs/:id"],
    ["https://user:private@example.com/api/v2/jobs", "/api/:unknown"],
    ["/api/v2/private/resume", "/api/:unknown"],
  ])
    assert.equal(module.safeApiRoute(input), expected);
});

test("global renderer failures report only safe exception fields and preserve native events", async () => {
  const module = await import("../../public/js/diagnostic-reporting.js").catch(
    () => null,
  );
  assert.ok(module, "renderer failure observer is available");
  const window = new EventTarget(),
    reports = [];
  module.installRendererDiagnostics({
    window,
    reportDiagnostic: async (event) => reports.push(event),
  });
  const event = new Event("unhandledrejection", { cancelable: true });
  event.reason = Object.assign(Error("private rejection text"), {
    stack: "Error: private\n at http://localhost/public/js/main.js:4:2",
  });
  window.dispatchEvent(event);
  await Promise.resolve();
  assert.equal(reports[0]?.operation, "renderer.failure");
  assert.equal(reports[0]?.code, "renderer_rejection");
  assert.equal(event.defaultPrevented, false);
  assert.equal(JSON.stringify(reports).includes("private"), false);
});
