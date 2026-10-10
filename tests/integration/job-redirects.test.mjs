import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import {
  job,
  profile,
  target,
  namedTargetInput,
  AT,
} from "../helpers/fixtures.mjs";
import { snapshotToLegacy, loadRun } from "../../src/pipeline.mjs";
import {packageBusinessFixture} from '../helpers/package-business-fixture.mjs';
async function fixture(t) {
  const f = await apiFixture(t),
    ctx = await f.ctx.ready,
    p = await ctx.workspaceService.saveProfile({ profile: profile() }),
    tar = await ctx.workspaceService.saveTarget(
      namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
    );
  const {
    jobIds: [id],
    observationIds: [oid],
  } = await ctx.jobService.ingestRecords({
    runId: "history",
    targetRevisionId: tar.revisionId,
    records: [job()],
    observedAt: AT,
  });
  await ctx.repository.mutateWorkspace((w) => {
    w.jobs.old = { ...structuredClone(w.jobs[id]), jobId: "old" };
    w.identityAliases["source-alias"] = ["old", id];
    w.applications.legacy = {
      jobId: "legacy",
      status: "applied",
      note: "保留合成旧备注",
      events: [{ type: "migration" }],
      legacyJobIds: ["old", id],
    };
    w.runs.history = {
      runId: "history",
      status: "completed",
      targetSnapshot: tar,
      lastSeq: 0,
      events: [],
      startedAt: AT,
      finishedAt: AT,
      counts: {},
    };
    w.observations[oid].jobId = "old";
    w.targetMembers[tar.revisionId].old = structuredClone(
      w.targetMembers[tar.revisionId][id],
    );
    w.evaluations.original = {
      evaluationId: "original",
      jobId: "old",
      runId: "history",
      status: "legacy",
      score: 70,
    };
  });
  const preview = await ctx.jobCleanupService.preview();
  await ctx.jobCleanupService.apply({
    ...preview,
    selectedGroupIds: preview.groups
      .filter((g) => !g.protected)
      .map((g) => g.groupId),
  });
  const w = await ctx.repository.read(),
    keptId = Object.keys(w.jobs)[0];
  return {
    f,
    ctx,
    p,
    tar,
    id,
    keptId,
    before: structuredClone(w.applications.legacy),
  };
}
test("legacy manual association becomes single without losing original events or identifiers", async (t) => {
  const { ctx, keptId, before } = await fixture(t);
  const application = await ctx.jobService.getApplication("legacy");
  assert.equal(application.association.status, "single");
  assert.deepEqual(application.association.jobIds, [keptId]);
  assert.equal(application.unresolved, false);
  assert.equal((await ctx.jobService.listUnresolvedApplications()).total, 0);
  assert.equal(
    (await ctx.jobService.queryJobs()).items[0].application.note,
    before.note,
  );
  const updated = await ctx.jobService.updateApplication("source-alias", {
    status: "interviewing",
  });
  assert.equal(updated.jobId, keptId);
  const w = await ctx.repository.read();
  assert.equal(w.applications.legacy.status, "interviewing");
  assert.deepEqual(w.applications.legacy.legacyJobIds, before.legacyJobIds);
  assert.deepEqual(w.applications.legacy.events[0], before.events[0]);
  assert.equal(Object.keys(w.applications).length, 1);
});
test("old IDs work through HTTP detail, scoring, links, alias ingestion and exports", async (t) => {
  const { f, ctx, p, tar, keptId } = await fixture(t);
  const detail = await f.call(
    "/api/v2/jobs/old?targetRevisionId=" + tar.revisionId,
  );
  assert.equal(detail.data.jobId, keptId);
  const single = await f.call("/api/v2/jobs/old/evaluations", {
    profileRevisionId: p.revisionId,
    targetRevisionId: tar.revisionId,
  });
  assert.equal(single.response.status, 200);
  assert.equal(single.data.evaluations[0].jobId, keptId);
  const batch = await f.call("/api/v2/jobs/evaluations", {
    jobIds: ["old", keptId],
    profileRevisionId: p.revisionId,
    targetRevisionId: tar.revisionId,
  });
  assert.equal(batch.data.evaluations.length, 1);
  const reingested = await ctx.jobService.ingestRecords({
    runId: "again",
    targetRevisionId: tar.revisionId,
    records: [job({ id: "source-alias" })],
  });
  assert.equal(reingested.jobIds[0], keptId);
  assert.equal(Object.keys((await ctx.repository.read()).jobs).length, 1);
  const {
    jobIds: [other],
  } = await ctx.jobService.ingestRecords({
    runId: "other",
    records: [job({ sourceRecordId: "other", title: "另一项招聘" })],
  });
  assert.equal(
    (await f.call("/api/v2/jobs/old/links", { jobId: other })).response.status,
    200,
  );
  assert.equal(
    (await f.call("/api/v2/jobs/old/links", { jobId: other }, "DELETE"))
      .response.status,
    200,
  );
  const exported = JSON.parse(
    (
      await ctx.exportService.export({
        format: "json",
        filters: { pageSize: 1 },
      })
    ).body,
  );
  assert.equal(exported.filter((r) => r.jobId === keptId).length, 1);
  assert.equal(
    exported.some((r) => r.unresolved),
    false,
  );
  const summary = await f.call("/api/tracking/summary");
  assert.equal(summary.data.byStatus.applied, 1);
  const rows = await f.call("/api/tracking/jobs");
  assert.equal(
    rows.data.jobs.find((r) => r.jobId === keptId).note,
    "保留合成旧备注",
  );
  await ctx.repository.mutateWorkspace((w) => {
    w.identityAliases.ambiguous = [keptId, other];
  });
  assert.equal(
    (await f.call("/api/tracking/jobs/ambiguous", { status: "seen" })).response
      .status,
    409,
  );
});
test("SSE replay and legacy snapshots keep original run facts with current manual status", async (t) => {
  const { ctx, f, keptId, p } = await fixture(t);
  await ctx.repository.mutateWorkspace((w) => {
    w.jobs[keptId].canonical.description = "后续的新正文";
  });
  const event = await ctx.eventHub.getSnapshot("history");
  assert.equal(event.payload.jobs[0].canonical.description, job().description);
  assert.ok(event.payload.jobs[0]);
  const snap = {
    run: (await ctx.repository.read()).runs.history,
    profileRevision: p,
    jobs: [
      {
        ...(await ctx.repository.read()).jobs[keptId],
        jobId: "old",
        canonical: job(),
      },
    ],
    evaluations: [
      {
        evaluationId: "original",
        jobId: "old",
        score: 70,
        recommendation: "consider",
      },
    ],
  };
  const legacy = snapshotToLegacy(snap, {
    cfg: f.cfg,
    workspace: await ctx.repository.read(),
    registry: ctx.registry,
  });
  assert.equal(legacy.jobs[0].description, job().description);
  assert.equal(legacy.jobs[0].score, 70);
  assert.equal(legacy.jobs[0].tracking.status, "applied");
  assert.equal(snap.jobs[0].jobId, "old");
});
test("standalone store preserves scoped aliases and refuses peer writes or unscoped summaries", async (t) => {
  const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets(),[keptId]=await f.ingest(a,[job()]),[peerId]=await f.ingest(b,[job()]);
  await f.jobs.updateJobApplication(keptId,{status:'applied',note:'保留合成旧备注'},a);await f.repository.mutateWorkspace(w=>{w.identityAliases.old=[keptId];});
  const scope={packageId:a.packageId,targetRevisionId:a.targetRevisionId},peer={packageId:b.packageId,targetRevisionId:b.targetRevisionId};
  const script = `import assert from 'node:assert/strict';const store=await import('./src/store.mjs'),scope=${JSON.stringify(scope)},peer=${JSON.stringify(peer)};let index=await store.loadIndex({scope});assert.equal(Object.keys(index.jobs).length,1);assert.equal(Object.values(index.jobs)[0].note,'保留合成旧备注');await assert.rejects(()=>store.loadIndex(),{code:'version_scope_required'});await assert.rejects(()=>store.setStatus('old','applied',undefined,{scope:peer}));await store.setStatus('old','interviewing',undefined,{scope});index=await store.loadIndex({scope});Object.values(index.jobs)[0].note='独立入口修改';await store.saveIndex(index,{scope});const input=${JSON.stringify(job({ id: "source-alias" }))};const diff=await store.upsert([input,input],{runId:'standalone',scope});assert.equal(diff.stats.ongoing,1);assert.equal(diff.stats.added,0);const annotated=await store.annotate([{id:'old'}],diff,{scope});assert.equal(annotated.jobs[0].tracking.status,'interviewing');assert.equal((await store.summary({scope})).byStatus.interviewing,1);`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.resolve("tests/helpers/network-guard.mjs")).href,
      "--input-type=module",
      "-e",
      script,
    ],
    { env: { ...process.env, RJR_DATA_DIR: f.repository.dataDir } },
  );
  let stderr = "";
  child.stderr.on("data", (v) => (stderr += v));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  const w = await f.repository.read();
  assert.equal(Object.keys(w.jobs).length, 2);
  const application=Object.values(w.applications).find(a=>a.jobId===keptId);
  assert.equal(application.note, "独立入口修改");
  assert.equal(application.status, "interviewing");
  assert.equal((await f.jobs.getJob(peerId,b)).application.status,'new');
  assert.equal(w.jobs[keptId].jobId, keptId);
});
test("archived v1 run projects current status while its saved result remains unchanged", async (t) => {
  const { ctx } = await fixture(t),
    snapshot = {
      run: { runId: "legacyhistory", legacy: true },
      legacyResult: {
        runId: "legacyhistory",
        jobs: [
          {
            ...job(),
            id: "old",
            jobId: "old",
            tracking: { status: "new", note: "" },
          },
        ],
      },
    };
  const snapshotRef = await ctx.repository.writeRunSnapshot(
    "legacyhistory",
    snapshot,
  );
  await ctx.repository.mutateWorkspace((w) => {
    w.runs.legacyhistory = {
      runId: "legacyhistory",
      legacy: true,
      status: "completed",
      snapshotRef,
    };
  });
  const result = await loadRun("legacyhistory", { context: ctx });
  assert.equal(result.jobs[0].tracking.status, "applied");
  assert.equal(result.jobs[0].description, job().description);
  assert.equal(result.jobs[0].jobId, "old");
  assert.deepEqual(
    await ctx.repository.readRunSnapshot("legacyhistory"),
    snapshot,
  );
});
