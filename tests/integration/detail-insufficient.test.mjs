import {namedTargetInput} from '../helpers/fixtures.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { job, profile, target, createTempDir } from "../helpers/fixtures.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";

test("source content insufficiency is a warning while storage errors remain errors", async (t) => {
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  await diagnostics.record(
    { operation: "run.detail" },
    Object.assign(Error("private source body"), {
      code: "detail_insufficient",
    }),
  );
  await diagnostics.record(
    { operation: "run.events", level: "warn" },
    Object.assign(Error("private filesystem path"), { code: "EPERM" }),
  );
  const entries = (await diagnostics.list()).entries;
  assert.equal(
    entries.find((e) => e.error.code === "detail_insufficient").level,
    "warn",
  );
  assert.equal(entries.find((e) => e.error.code === "EPERM").level, "error");
  assert.ok(!JSON.stringify(entries).includes("private"));
});

test("insufficient source requirements preserve facts and explain the limitation", async (t) => {
  const provider = fakeProvider({ records: [job({ description: null })] });
  provider.fetchDetail = async () => {
    throw Object.assign(Error("source title only"), {
      code: "detail_insufficient",
      retryable: false,
    });
  };
  const f = await apiFixture(t, { providers: [provider] }),
    app = await f.ctx.ready;
  const p = await app.workspaceService.saveProfile({ profile: profile() });
  const tar = await app.workspaceService.saveTarget(namedTargetInput({
    ...target(),
    profileRevisionId: p.revisionId,
  }));
  const { runId } = await app.runService.startRun({
    targetRevisionId: tar.revisionId,
  });
  const result = await app.runService.waitForRun(runId);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.counts.deduplicated, 1);
  const issue = result.run.issues.find((i) => i.code === "detail_insufficient");
  assert.match(issue.message, /原网站.*完整岗位要求.*保留列表/);
  assert.equal(issue.retryable, false);
  const logs = (await app.diagnostics.list({ runId })).entries;
  const entry = logs.find((e) => e.diagnosticId === issue.diagnosticId);
  assert.equal(entry.level, "warn");
  assert.equal(entry.operation, "run.detail.insufficient");
  assert.equal(entry.error.code, "detail_insufficient");
  const jobs = Object.values((await app.repository.read()).jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].canonical.title, "Java开发工程师");
  assert.equal(jobs[0].canonical.description, null);
});
