import {namedTargetInput} from '../helpers/fixtures.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { profile, target } from "../helpers/fixtures.mjs";

test("profile text checks cannot be bypassed through HTTP or direct services", async (t) => {
  const f = await apiFixture(t),
    ctx = await f.ctx.ready;
  const result = await f.call("/api/v2/profiles", {
    text: "太短",
    profile: profile(),
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.fieldErrors.text);
  await assert.rejects(
    ctx.workspaceService.saveProfile({ text: "太短", profile: profile() }),
    (e) => e.status === 400 && !!e.fieldErrors.text,
  );
  assert.equal((await ctx.workspaceService.listProfiles()).length, 0);
});

test("invalid profile facts return field errors without creating a revision", async (t) => {
  const f = await apiFixture(t);
  const before = (await f.call("/api/v2/profiles")).data;
  const result = await f.call("/api/v2/profiles", {
    profile: { ...profile(), graduationYear: 2026.5 },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.fieldErrors["profile.graduationYear"]);
  assert.deepEqual((await f.call("/api/v2/profiles")).data, before);
});
test("invalid import note is rejected before ingesting any record", async (t) => {
  const f = await apiFixture(t);
  const result = await f.call("/api/v2/imports", {
    text: "合成招聘公告",
    note: "长".repeat(20001),
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.fieldErrors.note);
  assert.equal((await f.call("/api/v2/jobs")).data.total, 0);
});
test("settings and source config validate types and retain existing values", async (t) => {
  const f = await apiFixture(t);
  const before = (await f.call("/api/v2/settings")).data;
  const bad = await f.call("/api/v2/settings", {
    model: { baseUrl: "" },
    budgets: { maxModelRequests: "" },
  });
  assert.equal(bad.response.status, 400);
  assert.ok(bad.data.fieldErrors["model.baseUrl"]);
  assert.ok(bad.data.fieldErrors["budgets.maxModelRequests"]);
  assert.deepEqual((await f.call("/api/v2/settings")).data, before);
  const source = await f.call("/api/v2/sources/synthetic/settings", {
    enabled: "false",
  });
  assert.equal(source.response.status, 400);
  assert.ok(source.data.fieldErrors.enabled);
});
test("direct services reject impossible dates and empty job types before writes", async (t) => {
  const f = await apiFixture(t),
    ctx = await f.ctx.ready;
  const p = await ctx.workspaceService.saveProfile({ profile: profile() });
  await assert.rejects(
    ctx.workspaceService.saveTarget(namedTargetInput({
      ...target(),
      profileRevisionId: p.revisionId,
      jobTypes: [],
    })),
    (e) => e.status === 400 && !!e.fieldErrors.jobTypes,
  );
  const imported = await ctx.importService.import({ text: "合成招聘公告" });
  await assert.rejects(
    ctx.jobService.updateApplication(imported.jobIds[0], {
      appliedAt: "2026-02-30",
    }),
    (e) => e.status === 400 && !!e.fieldErrors.appliedAt,
  );
  assert.equal(
    (await ctx.jobService.getApplication(imported.jobIds[0])).application
      .appliedAt,
    null,
  );
});
test("query validation exposes field keys and compatible API keys are accepted", async (t) => {
  const f = await apiFixture(t);
  const bad = await f.call("/api/v2/jobs?recommendation=typo&since=2026-02-30");
  assert.equal(bad.response.status, 400);
  assert.ok(bad.data.fieldErrors.recommendation);
  assert.ok(bad.data.fieldErrors.since);
  f.cfg.deepseek.allowUserKey = true;
  const p = await f.call("/api/v2/profiles", { profile: profile() });
  const tar = await f.call("/api/v2/targets", namedTargetInput({
    ...target(),
    profileRevisionId: p.data.revisionId,
  }));
  const run = await f.call("/api/v2/runs", {
    targetRevisionId: tar.data.revisionId,
    mode: "rules",
    userApiKey: "vendor-compatible-123456789",
  });
  assert.equal(run.response.status, 202);
  await (await f.ctx.ready).runService.waitForRun(run.data.runId);
});

test("unknown source or site references cannot be saved", async (t) => {
  const f = await apiFixture(t);
  const p = await f.call("/api/v2/profiles", { profile: profile() });
  for (const patch of [
    { sourceIds: ["not-existing"] },
    { siteIds: ["not-existing"] },
  ]) {
    const result = await f.call("/api/v2/targets", namedTargetInput({
      ...target(),
      profileRevisionId: p.data.revisionId,
      ...patch,
    }));
    assert.equal(result.response.status, 400);
    assert.ok(result.data.fieldErrors[Object.keys(patch)[0]]);
  }
  assert.equal((await f.call("/api/v2/targets")).data.targets.length, 0);
});
test("default rules mode ignores unused Key", async (t) => {
  const f = await apiFixture(t);
  const p = await f.call("/api/v2/profiles", { profile: profile() });
  const tar = await f.call("/api/v2/targets", namedTargetInput({
    ...target(),
    profileRevisionId: p.data.revisionId,
  }));
  const run = await f.call("/api/v2/runs", {
    targetRevisionId: tar.data.revisionId,
    userApiKey: "bad unused key",
  });
  assert.equal(run.response.status, 202);
  await (await f.ctx.ready).runService.waitForRun(run.data.runId);
});

test("invalid backup leaves no archive", async (t) => {
  const f = await apiFixture(t),
    ctx = await f.ctx.ready;
  const archives = () =>
    fs.readdir(path.join(f.dataDir, "backups")).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
  const before = await archives();
  const bad = await f.call("/api/v2/workspace/restore", {
    archive: { jobs: [] },
  });
  assert.equal(bad.response.status, 400);
  assert.ok(bad.data.fieldErrors.file);
  assert.deepEqual(await archives(), before);
});
test("structured project descriptions have the same limit as plain text", async (t) => {
  const f = await apiFixture(t),
    ctx = await f.ctx.ready;
  await assert.rejects(
    ctx.workspaceService.saveProfile({
      profile: {
        projects: [{ name: "sample", description: "长".repeat(20001) }],
      },
    }),
    (e) => e.status === 400 && !!e.fieldErrors["profile.projects"],
  );
  assert.equal((await ctx.workspaceService.listProfiles()).length, 0);
});
