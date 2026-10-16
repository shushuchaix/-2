import test from "node:test";
import assert from "node:assert/strict";
import { dedupeJobs, jobKey } from "../../src/util/text.mjs";
import { job } from "../helpers/fixtures.mjs";
test("legacy dedupe preserves level city and query identity conflicts", () => {
  const base = {
    company: "合成公司",
    title: "Java开发工程师I",
    city: "北京",
    url: "https://jobs.example.com/a",
  };
  for (const other of [
    { ...base, title: "Java开发工程师II", url: "https://jobs.example.com/b" },
    { ...base, city: "上海", url: "https://jobs.example.com/c" },
    { ...base, url: "https://jobs.example.com/a?pid=2" },
  ])
    assert.equal(dedupeJobs([structuredClone(base), other]).length, 2);
  assert.notEqual(
    jobKey({ ...base, url: base.url + "?pid=2" }),
    jobKey({ ...base, url: base.url + "?pid=3" }),
  );
});
test("strong identity preserves title city conflicts while fuzzy only links", async () => {
  const { relateJobs, canonicalizeSourceUrl, resolveJobIdentity } =
    await import("../../src/domain/identity.mjs");
  assert.equal(
    relateJobs(job(), job({ title: "新标题", cities: ["上海"] })).relation,
    "distinct",
  );
  assert.equal(
    relateJobs(job({ sourceRecordId: "1" }), job({ sourceRecordId: "2" }))
      .relation,
    "distinct",
  );
  assert.equal(
    relateJobs(
      job({ sourceRecordId: null }),
      job({
        sourceId: "other",
        sourceRecordId: null,
        url: "https://other.example.com/2",
      }),
    ).relation,
    "possible",
  );
  assert.equal(
    relateJobs(
      job({ sourceRecordId: null, company: null }),
      job({
        sourceRecordId: null,
        company: null,
        url: "https://other.example.com/2",
      }),
    ).relation,
    "distinct",
  );
  assert.equal(
    canonicalizeSourceUrl("https://x.example/a?signature=s&pid=2&utm_source=a"),
    "https://x.example/a?pid=2&signature=s",
  );
  assert.equal(
    canonicalizeSourceUrl("https://x.example/a#/jobs/2"),
    "https://x.example/a#/jobs/2",
  );
  assert.notEqual(
    resolveJobIdentity(job({ sourceRecordId: "1", identityScope: "school-a" }))
      .key,
    resolveJobIdentity(job({ sourceRecordId: "1", identityScope: "school-b" }))
      .key,
  );
});
