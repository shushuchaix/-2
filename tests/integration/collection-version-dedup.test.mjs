import test from "node:test";
import assert from "node:assert/strict";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
test("same mirror accumulates evidence within a version and later incomplete detail cannot erase accepted facts", async (t) => {
  const f = await packageBusinessFixture(t),
    { a, b } = await f.twoTargets(),
    scope = { packageId: a.packageId, targetRevisionId: a.revisionId },
    other = { packageId: b.packageId, targetRevisionId: b.revisionId };
  const official = job({
    detailStatus: "complete",
    deadlineAt: "2029-01-01",
    sourceEvidence: [
      {
        evidenceId: "official-degree",
        field: "degree",
        sourceUrl: "https://jobs.example.com/1",
        sourceExcerpt: "本科",
        status: "verified",
      },
    ],
  });
  const [id] = await f.ingest(scope, [official]),
    [otherId] = await f.ingest(other, [official]);
  const before = JSON.stringify((await f.repository.read()).jobs[otherId]);
  const mirror = {
    ...official,
    sourceId: "wechat",
    sourceRecordId: "article:1:position",
    sourceRecordIdKind: "generated",
    urlKind: "notice_detail",
    url: "https://mp.weixin.qq.com/s/abc",
    description: null,
    degree: null,
    cities: [],
    detailStatus: "pending",
    sourceEvidence: [
      {
        evidenceId: "social-company",
        field: "company",
        sourceUrl: "https://mp.weixin.qq.com/s/abc",
        sourceExcerpt: official.company,
        status: "verified",
      },
    ],
    verifiedJobLocator: {
      url: official.url,
      kind: "job_detail",
      title: official.title,
      company: official.company,
      verified: true,
    },
  };
  const ids = await f.ingest(scope, [mirror]);
  assert.deepEqual(ids, [id]);
  assert.notEqual(id, otherId);
  const detail = await f.jobs.getJob(id, scope);
  assert.equal(detail.fact.record.degree, "本科");
  assert.equal(detail.fact.record.description, official.description);
  assert.equal(detail.fact.record.sourceEvidence.length, 2);
  assert.equal(detail.job.sourceRefs.length, 2);
  assert.equal(
    JSON.stringify((await f.repository.read()).jobs[otherId]),
    before,
  );
});
