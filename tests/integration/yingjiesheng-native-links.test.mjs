import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import yingjiesheng from "../../src/sources/adapters/yingjiesheng.mjs";
import { readProviderPage } from "../../src/sources/collection-page.mjs";

const entry = "https://www.yingjiesheng.com/deadline/";
async function page(html) {
  return readProviderPage(yingjiesheng, {
    unitId: "synthetic-yingjiesheng-deadline",
    site: { siteId: "yingjiesheng", origin: "https://www.yingjiesheng.com" },
    query: { pageLimit: 1 },
    request: async (url) => {
      if (url !== entry) throw Error("unexpected fixture request");
      return { status: 200, text: html, headers: {} };
    },
  });
}

const fixture = () =>
  fs.readFile(
    new URL(
      "../fixtures/yingjiesheng/deadline-native-links.html",
      import.meta.url,
    ),
    "utf8",
  );

test("deadline navigation and non-native articles do not become campaigns", async () => {
  const result = await page(await fixture());
  assert.deepEqual(
    result.records.map((record) => record.url),
    [
      "https://www.yingjiesheng.com/job-000-001-001.html",
      "https://www.yingjiesheng.com/job-000-001-002.html",
    ],
  );
  assert.ok(
    result.records.every((record) => record.kind === "company_campaign"),
  );
  assert.ok(result.records.every((record) => record.description === null));
  assert.ok(result.records.every((record) => record.applyUrl === null));
});

test("native article identity deduplicates query and fragment variants", async () => {
  const result = await page(await fixture());
  assert.deepEqual(
    result.records.map((record) => record.sourceRecordId),
    ["000-001-001", "000-001-002"],
  );
  assert.ok(
    result.records.every((record) => record.sourceRecordIdKind === "authority"),
  );
  assert.ok(
    result.records.every((record) => record.urlKind === "notice_detail"),
  );
});

test("calendar dates do not provide a deadline for an undated article row", async () => {
  const result = await page(await fixture());
  assert.equal(result.records[0].deadlineAt, "2026-12-30T00:00:00.000Z");
  assert.equal(result.records[1].deadlineAt, null);
});

test("a calendar-only table remains a missing recruitment list", async () => {
  await assert.rejects(
    page(
      '<table><tr><td><a href="/deadline/fulltime/2026/10-12.html">2026-10-12</a></td></tr></table>',
    ),
    { code: "parse_error" },
  );
});
