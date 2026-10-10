import test from "node:test";
import assert from "node:assert/strict";
import { render, screen, cleanup } from "@testing-library/react";
import { createApiClient } from "../../ui/src/lib/api";
test("React loader and DOM execute behavior before feature tests", (t) => {
  t.after(cleanup);
  render(
    <button
      onClick={() => {
        document.title = "clicked";
      }}
    >
      测试
    </button>,
  );
  screen.getByRole("button", { name: "测试" }).click();
  assert.equal(document.title, "clicked");
});
test("maintenance status uses authenticated root endpoint and diagnostic transport retains exact scope", async () => {
  const calls: { url: string; credentials?: RequestCredentials }[] = [];
  const api = createApiClient({
    fetchImpl: (async (url, options) => {
      calls.push({ url: String(url), credentials: options?.credentials });
      return new Response(JSON.stringify({ maintenance: true, entries: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });
  await api.request("/maintenance");
  await api.request("/diagnostics/logs", {
    scope: { packageId: "A", targetRevisionId: "t1@1" },
  });
  assert.equal(calls[0].url, "/api/maintenance");
  const query = new URLSearchParams(calls[1].url.split("?")[1]);
  assert.equal(query.get("packageId"), "A");
  assert.equal(query.get("targetRevisionId"), "t1@1");
  assert.ok(calls.every((c) => c.credentials === "same-origin"));
});
