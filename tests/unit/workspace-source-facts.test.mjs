import test from "node:test";
import assert from "node:assert/strict";
import {
  assertWorkspace,
  assertSourceRecord,
  createEmptyWorkspace,
} from "../../src/domain/contracts.mjs";
import { job } from "../helpers/fixtures.mjs";

const workspace = (canonical) => {
  const w = createEmptyWorkspace({ schemaVersion: 2 });
  w.jobs.j = {
    jobId: "j",
    kind: "job",
    ...(canonical === undefined ? {} : { canonical }),
  };
  return w;
};
test("workspace source facts accept complete records, sparse historical stubs and extensions without fabricating fields", () => {
  for (const canonical of [
    undefined,
    {},
    { title: "旧岗位" },
    { cities: [], jobType: "unknown" },
    job({
      city: "旧城市",
      preScore: 40,
      customHistoricalMetadata: { retained: true },
    }),
  ]) {
    const w = workspace(canonical),
      before = structuredClone(w);
    assert.equal(assertWorkspace(w), w);
    assert.deepEqual(w, before);
  }
  assert.doesNotThrow(() =>
    assertWorkspace(workspace(job({ sourceId: "manual", url: null }))),
  );
});
for (const canonical of [
  null,
  [],
  "invalid",
  { cities: "北京" },
  { cities: [42] },
  { evidence: {} },
  { evidence: ["not evidence"] },
  { jobType: "fulltime" },
  { kind: "unknown" },
  { title: 42 },
  { sourceId: [] },
  { company: {} },
  { description: [] },
  { url: "javascript:alert(1)" },
  { url: "https://u:p@example.org/job" },
]) {
  test(`workspace rejects malformed canonical core ${JSON.stringify(canonical)}`, () => {
    assert.throws(
      () => assertWorkspace(workspace(canonical)),
      /Invalid|Missing/,
    );
  });
}
test("a complete stored source record observes the same source boundary as new records", () => {
  const canonical = job({ title: " " });
  assert.throws(() => assertSourceRecord(canonical), /Missing source title/);
  assert.throws(
    () => assertWorkspace(workspace(canonical)),
    /Missing source title/,
  );
});
