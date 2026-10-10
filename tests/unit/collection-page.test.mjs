import test from "node:test";
import assert from "node:assert/strict";
import { readProviderPage } from "../../src/sources/collection-page.mjs";
import { createLegacyProvider } from "../../src/sources/adapters/legacy.mjs";
test("legacy_is_one_non_resumable_unit_and_never_invents_a_cursor", async () => {
  let calls = 0;
  const provider = createLegacyProvider("university", {
    collector: async () => {
      calls++;
      return { jobs: [], errors: [] };
    },
  });
  const page = await readProviderPage(provider, {
    unitId: "u",
    site: { siteId: "s" },
    query: { pageLimit: 3 },
    cursor: null,
    context: {},
  });
  assert.equal(provider.capabilities.resumablePages, false);
  assert.equal(page.done, true);
  assert.equal(page.nextCursor, null);
  assert.equal(calls, 1);
});
test("page_keys_are_stable_and_cycles_or_unbounded_cursors_are_rejected", async () => {
  const provider = {
    id: "fake",
    parserVersion: "v1",
    capabilities: { resumablePages: true },
    collectPage: async () => ({
      records: [],
      issues: [],
      nextCursor: { page: 2 },
      done: false,
    }),
  };
  const input = { unitId: "u", cursor: { page: 1 } };
  const a = await readProviderPage(provider, input),
    b = await readProviderPage(provider, input);
  assert.equal(a.pageKey, b.pageKey);
  await assert.rejects(
    readProviderPage(provider, { unitId: "u", cursor: { page: 2 } }),
    { code: "pagination_cycle" },
  );
  await assert.rejects(
    readProviderPage(provider, {
      unitId: "u",
      cursor: { page: 1 },
      seenCursorHashes: [a.nextCursorHash],
    }),
    { code: "pagination_cycle" },
  );
  await assert.rejects(
    readProviderPage(provider, {
      unitId: "u",
      cursor: { huge: "x".repeat(20000) },
    }),
    { code: "collection_cursor_invalid" },
  );
});
