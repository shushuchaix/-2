import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
test("legacy NDJSON response history export and tracking retain their shapes", async (t) => {
  const f = await apiFixture(t);
  const result = await f.call("/api/analyze", {
    resumeText:
      "合成学生 本科 软件工程 2027届毕业 Java开发 北京 求职意向 项目经历 Java服务和SQL数据库",
    options: { useLlm: false, cities: [] },
  });
  assert.equal(result.response.status, 200);
  const events = result.text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "done");
  for (const type of ["profile", "queries", "result", "saved", "quota"])
    assert.ok(
      events.some((e) => e.type === type),
      type + " " + JSON.stringify(events),
    );
  const run = events.find((e) => e.type === "result").result;
  assert.ok(run.resumeProfile);
  assert.ok(run.funnel);
  assert.ok(Array.isArray(run.jobs));
  const history = await f.call("/api/runs");
  assert.equal(history.data.runs[0].runId, run.runId);
  assert.equal((await f.call("/api/runs/" + run.runId)).data.runId, run.runId);
  assert.equal(
    (await f.call("/api/runs/" + run.runId + "/export?format=csv")).response
      .status,
    200,
  );
  const jobs = await f.call("/api/tracking/jobs");
  assert.ok(jobs.data.jobs.length);
  const saved = await f.call(
    "/api/tracking/jobs/" + encodeURIComponent(jobs.data.jobs[0].id),
    { status: "applied", note: "" },
  );
  assert.equal(saved.data.job.note, "");
  assert.equal(
    (await f.call("/api/runs/" + run.runId, undefined, "DELETE")).data.ok,
    true,
  );
  assert.equal((await f.call("/api/runs")).data.runs.length, 0);
  assert.equal((await f.call("/api/v2/jobs")).data.total, 1);
});
test("legacy analyze refuses initial write failure before opening success stream", async (t) => {
  const f = await apiFixture(t),
    context = await f.ctx.ready;
  context.repository.mutateWorkspace = async () => {
    const error = Error("ENOSPC injected");
    error.code = "ENOSPC";
    throw error;
  };
  const result = await f.call("/api/analyze", {
    resumeText:
      "合成学生 本科 软件工程 2027届毕业 Java开发 北京 项目经历和求职意向说明",
    options: { useLlm: false },
  });
  assert.equal(result.response.status, 500);
  assert.equal(context.gate.active, 0);
});
