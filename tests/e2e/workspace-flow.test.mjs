import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
test("personal workflow survives restart and exports human records in Markdown", async (t) => {
  const providers = [
    fakeProvider(),
    fakeProvider({ id: "failed", fail: true }),
  ];
  let f = await apiFixture(t, { providers });
  const preview = await f.call("/api/v2/profiles/import-preview", {
    resumeText:
      "合成学生 本科 软件工程 2027届毕业 Java SQL开发 北京 项目经历和求职意向说明",
  });
  assert.equal(preview.response.status, 200);
  const p = await f.call("/api/v2/profiles", {
    text: preview.data.text,
    profile: {
      ...preview.data.profile,
      education: "本科",
      skills: ["Java", "SQL"],
    },
    overrides: { major: "软件工程" },
  });
  const target = await f.call("/api/v2/targets", {
    profileRevisionId: p.data.revisionId,
    roles: ["Java开发"],
    cityMode: "any",
    cities: [],
    jobTypes: ["campus"],
    degreePolicy: "eligibility",
    sourceIds: ["synthetic", "failed"],
  });
  const started = await f.call("/api/v2/runs", {
      targetRevisionId: target.data.revisionId,
      mode: "rules",
    }),
    context = await f.ctx.ready,
    result = await context.runService.waitForRun(started.data.runId);
  assert.equal(
    result.run.status,
    "partial",
    JSON.stringify({
      issues: result.run.issues,
      coverage: result.run.coverage,
      counts: result.run.counts,
      ...(result.run.status === "failed"
        ? {
            diagnostics: (
              await context.diagnostics.list({ runId: started.data.runId })
            ).entries,
          }
        : {}),
    }),
  );
  const jobs = await f.call("/api/v2/jobs");
  assert.equal(jobs.data.total, 1);
  const id = jobs.data.items[0].jobId;
  assert.equal(
    (
      await f.call(
        "/api/v2/applications/" + id,
        {
          status: "applied",
          note: "跟进合成记录",
          resumeRevisionId: p.data.revisionId,
          appliedAt: "2026-10-05",
          followUpAt: "2026-10-08",
        },
        "PUT",
      )
    ).response.status,
    200,
  );
  const events = await f.call(
    "/api/v2/runs/" +
      started.data.runId +
      "/events?afterSeq=" +
      result.run.lastSeq,
  );
  assert.equal(events.response.status, 200);
  assert.equal(JSON.parse(events.text.trim()).type, "snapshot");
  f.ctx.server.closeAllConnections();
  await new Promise((r) => f.ctx.server.close(r));
  f = await apiFixture(t, { dataDir: f.dataDir, providers });
  const detail = await f.call("/api/v2/jobs/" + id);
  assert.equal(detail.data.application.note, "跟进合成记录");
  assert.equal(detail.data.application.resumeRevisionId, p.data.revisionId);
  const exported = await f.call("/api/v2/exports?format=md");
  assert.equal(exported.response.status, 200);
  assert.ok(exported.text.includes("已投递"));
  assert.ok(exported.text.includes("跟进合成记录"));
  assert.ok(exported.text.includes(p.data.revisionId));
  const archive = await f.call("/api/v2/workspace/backup");
  assert.ok(!JSON.stringify(archive.data).includes("apiKey"));
  const bad = structuredClone(archive.data);
  bad.workspace.jobs = {};
  assert.notEqual(
    (await f.call("/api/v2/workspace/restore", { archive: bad })).response
      .status,
    200,
  );
  assert.equal(
    (await f.call("/api/v2/jobs/" + id)).data.application.note,
    "跟进合成记录",
  );
});
