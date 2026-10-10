import test from "node:test";
import assert from "node:assert/strict";
import { toCsv, toMarkdown, toJson } from "../../src/export.mjs";

const result = (job) => ({
  createdAt: "2026-10-10T00:00:00.000Z",
  durationMs: 1000,
  jobs: [{ title: "合成消防岗位", publishTime: "2026-10-10", ...job }],
});
function publishedCsvCell(value) {
  // These fixtures contain no commas or quotes in any field.
  const [header, row] = toCsv(value)
    .replace(/^\uFEFF/, "")
    .split("\r\n");
  const index = header.split(",").indexOf("发布时间");
  assert.ok(index >= 0);
  return row.split(",")[index];
}

for (const [label, source] of [
  ["legacy Nowcoder job", { source: "nowcoder" }],
  ["normalized Nowcoder campaign", { sourceId: "nowcoder" }],
  ["legacy Shixiseng job", { source: "shixiseng" }],
  ["normalized Shixiseng job", { sourceId: "shixiseng" }],
  ["legacy Bocha web lead", { source: "web", extra: { engine: "bocha" } }],
  [
    "normalized Bocha search lead",
    { sourceId: "searchapi", source: "web", extra: { engine: "bocha" } },
  ],
]) {
  test(`${label} cannot export its unproven old time as publication`, () => {
    const value = result(source);
    assert.equal(publishedCsvCell(value), "");
    assert.equal(toMarkdown(value).includes("｜发布："), false);
  });
}

test("Bocha exports an explicit original publication date", () => {
  const value = result({
    source: "web",
    extra: { engine: "bocha", datePublished: "2026-10-10T01:02:03+08:00" },
  });
  assert.equal(publishedCsvCell(value), "2026-10-10");
  assert.ok(toMarkdown(value).includes("｜发布：2026-10-10"));
});

test("Bocha publication evidence takes precedence over a conflicting old crawl date", () => {
  const value = result({
    sourceId: "searchapi",
    source: "web",
    extra: {
      engine: "bocha",
      datePublished: "2020年1月2日",
      dateLastCrawled: "2026-10-10T01:02:03Z",
    },
  });
  assert.equal(publishedCsvCell(value), "2020-01-02");
  assert.ok(toMarkdown(value).includes("｜发布：2020-01-02"));
  assert.equal(toMarkdown(value).includes("｜发布：2026-10-10"), false);
});

test("Bocha cannot invent a publication date from unknown, incomplete or impossible metadata", () => {
  for (const datePublished of [
    "待核验",
    "10-09",
    "2026-02-31",
    1791590400000,
  ]) {
    const value = result({
      source: "web",
      extra: { engine: "bocha", datePublished },
    });
    assert.equal(publishedCsvCell(value), "");
    assert.equal(toMarkdown(value).includes("｜发布："), false);
  }
});

test("publication dates from other sources keep their existing output", () => {
  for (const source of [
    { source: "zhaopin" },
    { sourceId: "jiuyeqiao" },
    { source: "web", extra: { engine: "tavily" } },
    { sourceId: "searchapi", source: "web", extra: { engine: "serper" } },
    { source: "manual", extra: { engine: "bocha" } },
  ]) {
    const value = result(source);
    assert.equal(publishedCsvCell(value), "2026-10-10");
    assert.ok(toMarkdown(value).includes("｜发布：2026-10-10"));
  }
});

test("date display filtering does not mutate the source snapshot or JSON facts", () => {
  const value = result({
    source: "nowcoder",
    extra: { refreshTime: 1791590400000 },
  });
  const original = structuredClone(value);
  toCsv(value);
  toMarkdown(value);
  assert.deepEqual(value, original);
  const snapshot = JSON.parse(toJson(value));
  assert.equal(snapshot.jobs[0].publishTime, "2026-10-10");
  assert.equal(snapshot.jobs[0].extra.refreshTime, 1791590400000);
  assert.deepEqual(snapshot, original);
});
