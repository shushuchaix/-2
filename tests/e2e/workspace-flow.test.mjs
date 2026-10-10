import { namedTargetInput } from "../helpers/fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { job, profile, target, AT } from "../helpers/fixtures.mjs";
import { resolveJobId } from "../../src/domain/job-resolution.mjs";
test("named version lifecycle, all-version cleanup, old ID application update and full backup restoration stay consistent", async (t) => {
  const f = await apiFixture(t),
    ctx = await f.ctx.ready;
  const p = (
    await f.call("/api/v2/profiles", {
      profile: profile(),
      versionName: "合成基础简历",
    })
  ).data;
  const a = (
    await f.call("/api/v2/targets", {
      ...namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
      versionName: "消防方向",
    })
  ).data;
  const b = (
    await f.call(
      "/api/v2/targets/t1",
      {
        ...namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
        versionName: "机场方向",
      },
      "PUT",
    )
  ).data;
  assert.notEqual(a.revisionId, b.revisionId);
  assert.equal(a.versionName, "消防方向");
  assert.equal(b.versionName, "机场方向");
  const saved = await ctx.jobService.ingestRecords({
      runId: "synthetic-e2e",
      targetRevisionId: a.revisionId,
      records: [job()],
      observedAt: AT,
    }),
    id = saved.jobIds[0],
    oid = saved.observationIds[0];
  assert.equal(
    (await f.call("/api/v2/jobs?targetRevisionId=" + a.revisionId)).data
      .items[0].evaluation,
    null,
  );
  const vpath =
    "/api/v2/targets/t1/revisions/" + encodeURIComponent(b.revisionId);
  assert.equal(
    (await f.call(vpath, { enabled: false }, "PATCH")).data.revisionId,
    b.revisionId,
  );
  assert.equal(
    (await f.call(vpath, undefined, "DELETE")).data.revisionId,
    b.revisionId,
  );
  assert.equal(
    (await f.call(vpath + "/restore", {})).data.revisionId,
    b.revisionId,
  );
  await ctx.repository.mutateWorkspace((w) => {
    w.jobs["copy-e2e"] = { ...structuredClone(w.jobs[id]), jobId: "copy-e2e" };
    w.observations["ob-copy"] = {
      ...structuredClone(w.observations[oid]),
      observationId: "ob-copy",
      jobId: "copy-e2e",
      targetRevisionId: b.revisionId,
      runId: "synthetic-e2e-b",
    };
    w.targetMembers[b.revisionId] = {
      "copy-e2e": {
        ...structuredClone(w.targetMembers[a.revisionId][id]),
        factRefs: [{ observationId: "ob-copy" }],
        currentObservationId: "ob-copy",
      },
    };
  });
  await f.call(
    "/api/v2/applications/" + id,
    { status: "applied", note: "保留人工记录" },
    "PUT",
  );
  const before = await ctx.repository.read(),
    preview = (await f.call("/api/v2/jobs/duplicates/preview", {})).data;
  assert.equal(preview.groups.length, 1);
  assert.deepEqual(
    preview.groups[0].targetRevisionIds.sort(),
    [a.revisionId, b.revisionId].sort(),
  );
  const merged = (
    await f.call("/api/v2/jobs/duplicates/apply", {
      workspaceRevision: preview.workspaceRevision,
      planHash: preview.planHash,
      selectedGroupIds: [preview.groups[0].groupId],
    })
  ).data;
  assert.equal(merged.counts.removedEntities, 1);
  assert.equal(merged.counts.affectedVersions, 2);
  assert.ok(merged.backupId);
  const after = await ctx.repository.read();
  assert.equal(Object.keys(after.jobs).length, 1);
  assert.deepEqual(after.observations, before.observations);
  const main = resolveJobId(after, "copy-e2e");
  assert.equal(main, id);
  assert.ok(after.targetMembers[b.revisionId][main]);
  assert.equal(
    (
      await f.call(
        "/api/v2/applications/copy-e2e",
        { note: "旧编号更新成功" },
        "PUT",
      )
    ).data.jobId,
    main,
  );
  assert.equal(
    (await f.call("/api/v2/jobs/" + main)).data.application.note,
    "旧编号更新成功",
  );
  const archive = (await f.call("/api/v2/workspace/backup", {})).data;
  await f.call("/api/v2/applications/" + main, { note: "备份后的修改" }, "PUT");
  assert.equal(
    (await f.call("/api/v2/workspace/restore", { archive })).response.status,
    200,
  );
  const restored = await ctx.repository.read();
  assert.deepEqual(restored.jobRedirects, archive.workspace.jobRedirects);
  assert.deepEqual(restored.targetMembers, archive.workspace.targetMembers);
  assert.equal(
    (await f.call("/api/v2/jobs/copy-e2e")).data.application.note,
    "旧编号更新成功",
  );
});
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
  const target = await f.call(
    "/api/v2/targets",
    namedTargetInput({
      profileRevisionId: p.data.revisionId,
      roles: ["Java开发"],
      cityMode: "any",
      cities: [],
      jobTypes: ["campus"],
      degreePolicy: "eligibility",
      sourceIds: ["synthetic", "failed"],
    }),
  );
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
