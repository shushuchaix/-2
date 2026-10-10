import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";

const listText =
  "消防工程师招聘信息摘要，负责消防设施维护和检测，具体任职要求、工作地点与报名方式需要核对详情页面。";
const detailText =
  "消防工程师负责消防设施维护、定期检测、隐患排查和设备运行保障，要求本科及以上学历，岗位具体职责以该详情页面为准。";

test("a long unverified list summary still obtains detail evidence before ingestion", async (t) => {
  let details = 0;
  const provider = createPagedProvider({
    id: "synthetic",
    name: "synthetic",
    capabilities: { detail: true },
    listPage: async () => ({
      records: [job({ title: "消防工程师", description: listText })],
      hasMore: false,
    }),
    detail: async (record) => {
      details++;
      return { ...record, description: detailText, detailStatus: "complete" };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  const started = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  assert.equal(details, 1);
  const fields = Object.values((await f.repository.read()).observations)[0]
    .fields;
  assert.equal(fields.description, detailText);
  assert.equal(
    assessRecruitmentEvidence({ record: fields }).bodyVerified,
    true,
  );
  assert.equal(
    Object.keys((await f.service.get(ref)).collectionProgress.pendingBodies)
      .length,
    0,
  );
});

test("an API list with verified body evidence avoids redundant detail credits", async (t) => {
  let details = 0;
  const provider = createPagedProvider({
    id: "synthetic",
    name: "synthetic",
    capabilities: { detail: true },
    listPage: async () => ({
      records: [
        job({
          title: "消防工程师",
          description: detailText,
          sourceEvidence: [
            {
              field: "description",
              sourceExcerpt: detailText,
              status: "verified",
              confidence: 100,
            },
          ],
        }),
      ],
      hasMore: false,
    }),
    detail: async (record) => {
      details++;
      return { ...record, detailStatus: "complete" };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  const started = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  assert.equal(details, 0);
  assert.equal((await f.ledger.snapshot(ref)).usedDetails, 0);
  const fields = Object.values((await f.repository.read()).observations)[0]
    .fields;
  assert.equal(
    assessRecruitmentEvidence({ record: fields }).bodyVerified,
    true,
  );
});
