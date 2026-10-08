import { namedTargetInput } from "../helpers/fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { profile, target, job } from "../helpers/fixtures.mjs";
test("bulk saved-job rescore and bounded settings are available", async (t) => {
  const f = await apiFixture(t),
    context = await f.ctx.ready,
    p = await context.workspaceService.saveProfile({ profile: profile() }),
    tar = await context.workspaceService.saveTarget(
      namedTargetInput({
        ...target(),
        profileRevisionId: p.revisionId,
      }),
    ),
    ingested = await context.jobService.ingestRecords({
      runId: "manual",
      targetRevisionId: tar.revisionId,
      records: [job()],
    });
  const res = await f.call("/api/v2/jobs/evaluations", {
    jobIds: ingested.jobIds,
    profileRevisionId: p.revisionId,
    targetRevisionId: tar.revisionId,
    mode: "rules",
  });
  assert.equal(res.response.status, 200);
  assert.equal(res.data.evaluations.length, 1);
  const invalid = await f.call(
    "/api/v2/settings",
    { budgets: { maxModelRequests: 21 } },
    "PUT",
  );
  assert.equal(invalid.response.status, 400);
  const valid = await f.call(
    "/api/v2/settings",
    { budgets: { maxModelRequests: 10 } },
    "PUT",
  );
  assert.equal(valid.data.budgets.maxModelRequests, 10);
});

test("target creation API accepts a verified currency budget", async (t) => {
  const f = await apiFixture(t),
    context = await f.ctx.ready,
    p = await context.workspaceService.saveProfile({ profile: profile() });
  await context.saveSettings({
    model: { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
    budgets: { maxCostCny: 10 },
  });
  const response = await f.call(
    "/api/v2/targets",
    namedTargetInput({
      ...target(),
      profileRevisionId: p.revisionId,
      budgets: { maxCostCny: 10 },
    }),
  );
  assert.equal(response.response.status, 201);
  assert.equal(response.data.budgets.maxCostCny, 10);
});
