import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { profile, target } from "../helpers/fixtures.mjs";
import { VERSION } from "../../src/version.mjs";
test("unversioned UI assets revalidate after an upgrade", async (t) => {
  const f = await apiFixture(t);
  for (const url of ["/", "/js/pages/workbench.js", "/styles/layout.css"]) {
    const response = await fetch(f.origin + url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    await response.text();
  }
});
test("v2 creates real revisions persistent run jobs applications and business backup", async (t) => {
  const f = await apiFixture(t),
    p = await f.call("/api/v2/profiles", {
      profile: profile(),
      text: "合成确认画像",
    });
  assert.equal(p.response.status, 201);
  const tar = await f.call("/api/v2/targets", {
    ...target(),
    profileRevisionId: p.data.revisionId,
  });
  assert.equal(tar.response.status, 201);
  const run = await f.call("/api/v2/runs", {
    targetRevisionId: tar.data.revisionId,
    mode: "rules",
  });
  assert.equal(run.response.status, 202);
  const context = await f.ctx.ready;
  await context.runService.waitForRun(run.data.runId);
  const jobs = await f.call("/api/v2/jobs");
  assert.equal(jobs.data.total, 1);
  const id = jobs.data.items[0].jobId;
  assert.equal(
    (
      await f.call("/api/v2/jobs/" + id + "/application", {
        status: "applied",
        note: "我的备注",
      })
    ).response.status,
    200,
  );
  assert.equal(
    (await f.call("/api/v2/jobs/" + id + "/application", { note: "" })).data
      .note,
    "",
  );
  const backup = await f.call("/api/v2/workspace/backup", {});
  assert.ok(backup.data.manifest.workspaceHash);
  assert.ok(!JSON.stringify(backup.data).includes("apiKey"));
  assert.equal((await f.call("/api/health")).data.version, VERSION);
  assert.equal((await f.call("/api/v2/jobs?page=-1")).response.status, 400);
  assert.equal((await f.call("/api/v2/runs/..%2fsecret")).response.status, 400);
  const blocked = await fetch(f.origin + "/api/v2/imports", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: '{"text":"招聘"}',
  });
  assert.equal(blocked.status, 403);
});
test("v2 reports failed writes and validates imports dates and ids", async (t) => {
  const f = await apiFixture(t);
  assert.equal(
    (
      await f.call("/api/v2/imports", {
        url: "http://127.0.0.1/private",
        text: "招聘",
      })
    ).response.status,
    400,
  );
  const context = await f.ctx.ready,
    original = context.repository.mutateWorkspace;
  context.repository.mutateWorkspace = async () => {
    const e = Error("injected ENOSPC");
    e.code = "ENOSPC";
    throw e;
  };
  assert.equal(
    (await f.call("/api/v2/profiles", { profile: profile() })).response.status,
    500,
  );
  context.repository.mutateWorkspace = original;
  assert.equal(
    (
      await f.call("/api/v2/profiles", {
        profileId: "__proto__",
        profile: profile(),
      })
    ).response.status,
    400,
  );
});
