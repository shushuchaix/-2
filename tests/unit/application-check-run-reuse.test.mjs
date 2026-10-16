import test from "node:test";
import assert from "node:assert/strict";
import { createRecordEnrichment } from "../../src/application/record-enrichment.mjs";

const now = Date.parse("2026-10-12T04:00:00.000Z");
const applyUrl = "https://jobs.example.org/talent/detail/id/37.html";
const makeRecord = (verification) => ({
  kind: "job",
  title: "机场勤务员",
  sourceId: "synthetic",
  description:
    "岗位职责：机场勤务保障。岗位要求：大专及以上。报名截止：2026年10月15日12:00。",
  bodyStatus: "complete",
  detailStatus: "complete",
  applyUrl,
  applicationVerification: verification,
});
const checked = (extra = {}) => ({
  status: 200,
  formVerified: false,
  challenge: true,
  checkedAt: new Date(now).toISOString(),
  checkedInRunId: "synthetic-run",
  checkedUrl: applyUrl,
  ...extra,
});

async function perform(verification, runId = "synthetic-run") {
  const calls = [];
  const enrich = createRecordEnrichment({ clock: { now: () => now } });
  const record = await enrich(makeRecord(verification), {
    runId,
    signal: new AbortController().signal,
    request: async (url) => {
      calls.push(url);
      return { status: 200, text: "<form>提交申请</form>" };
    },
  });
  return { record, calls };
}
for (const verification of [
  checked(),
  checked({ challenge: false }),
  checked({ status: "login_required", challenge: false }),
]) {
  test(
    "same run and URL reuse an already completed application check " +
      verification.status +
      "/" +
      verification.challenge,
    async () => {
      const result = await perform(verification);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(result.record.applicationVerification, verification);
    },
  );
}
for (const [name, verification, runId] of [
  ["different run", checked(), "new-run"],
  ["missing caller run", checked(), null],
  ["missing marker", checked({ checkedInRunId: undefined }), "synthetic-run"],
  [
    "wrong application URL",
    checked({ checkedUrl: applyUrl.replace("37", "58") }),
    "synthetic-run",
  ],
  [
    "future timestamp",
    checked({ checkedAt: new Date(now + 1).toISOString() }),
    "synthetic-run",
  ],
  [
    "stale timestamp",
    checked({ checkedAt: new Date(now - 72 * 3600000 - 1).toISOString() }),
    "synthetic-run",
  ],
  ["unfinished response", checked({ status: "unknown" }), "synthetic-run"],
])
  test("a new check remains required for " + name, async () => {
    const result = await perform(verification, runId);
    assert.deepEqual(result.calls, [applyUrl]);
    assert.equal(result.record.applicationVerification.formVerified, true);
  });
