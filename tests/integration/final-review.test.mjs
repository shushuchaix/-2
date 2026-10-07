import {namedTargetInput} from '../helpers/fixtures.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tempRepository } from "../helpers/repository.mjs";
import { job, profile, target } from "../helpers/fixtures.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { migrateV1 } from "../../src/infrastructure/storage/migrate-v1.mjs";
import {
  createBackup,
  restoreBackup,
} from "../../src/infrastructure/storage/backup.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
import { createExportService } from "../../src/application/export-service.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { buildCollectionPlan } from "../../src/sources/planning.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import { loadRun } from "../../src/pipeline.mjs";

async function legacy(t, ambiguous = false) {
  const repository = await tempRepository(t);
  const a = job({ id: "old-1", sourceRecordId: null, score: 70 });
  const records = ambiguous
    ? [a, { ...a, cities: ["上海"], url: "https://jobs.example.com/2" }]
    : [a];
  await fs.mkdir(path.join(repository.dataDir, "runs"));
  await fs.writeFile(
    path.join(repository.dataDir, "runs", "old-run.json"),
    JSON.stringify({ runId: "old-run", jobs: records, apiKey: "PRIVATE-KEY" }),
  );
  await fs.writeFile(
    path.join(repository.dataDir, "job-index.json"),
    JSON.stringify({
      version: 1,
      jobs: { "old-1": { ...a, status: "applied", note: "旧记录待确认" } },
    }),
  );
  await migrateV1({ dataDir: repository.dataDir, repository });
  return { repository, jobs: createJobService({ repository }), a };
}

test("review 1: migrated URL and later authority ID retain one job and its application", async (t) => {
  const { repository, jobs, a } = await legacy(t);
  const oldId = (await jobs.queryJobs()).items[0].jobId;
  await jobs.ingestRecords({ runId: "fresh", records: [a] });
  assert.equal((await jobs.queryJobs()).total, 1);
  await jobs.ingestRecords({
    runId: "fresh-2",
    records: [{ ...a, sourceRecordId: "authority-1" }],
  });
  assert.equal((await jobs.queryJobs()).total, 1);
  assert.equal((await jobs.getJob(oldId)).application.note, "旧记录待确认");
  await jobs.ingestRecords({
    runId: "different",
    records: [{ ...a, sourceRecordId: "authority-2" }],
  });
  assert.equal(
    Object.keys((await repository.read()).jobs).length,
    2,
    "different authority IDs remain separate",
  );
});

test("review 2: ambiguous migrated application is visible editable and exportable without assigning candidates", async (t) => {
  const { repository } = await legacy(t, true);
  const f = await apiFixture(t, { dataDir: repository.dataDir });
  const listed = await f.call("/api/v2/applications/unresolved?status=applied");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.data.items.length, 1);
  const detail = await f.call("/api/v2/applications/legacy%3Aold-1");
  assert.equal(detail.data.application.note, "旧记录待确认");
  assert.equal(detail.data.candidateJobs.length, 2);
  const edit = await f.call(
    "/api/v2/applications/legacy%3Aold-1",
    { note: "已电话确认，待关联" },
    "PUT",
  );
  assert.equal(edit.response.status, 200);
  const ctx = await f.ctx.ready;
  for (const format of ["json", "csv", "markdown"]) {
    const exported = await ctx.exportService.export({
      format,
      filters: { status: "applied" },
    });
    assert.match(exported.body, /已电话确认，待关联/);
    assert.match(exported.body, /待确认/);
  }
  const w = await repository.read();
  assert.equal(Object.keys(w.jobs).length, 2);
  assert.ok(
    Object.values(w.jobs).every(
      (j) =>
        !Object.hasOwn(j.canonical, "note") &&
        !Object.hasOwn(j.canonical, "status"),
    ),
    "ambiguous human state is not copied into candidate facts",
  );
  assert.equal(
    Object.values(w.applications).filter((a) => a.status === "applied").length,
    1,
  );
});

test("review 3: business backup restores migrated history into an empty directory", async (t) => {
  const { repository } = await legacy(t);
  const archive = await createBackup({ repository });
  const destination = await tempRepository(t);
  await restoreBackup({ repository: destination, archivePath: archive.path });
  const run = await loadRun("old-run", {
    context: { repository: destination },
  });
  assert.equal(run.jobs.length, 1);
  assert.equal(run.jobs[0].title, job().title);
  assert.equal(JSON.stringify(run).includes("PRIVATE-KEY"), false);
  assert.equal(
    (await fs.readFile(archive.path, "utf8")).includes("PRIVATE-KEY"),
    false,
  );
});

test("review 4: restoring an unfinished run in its former process interrupts it instead of reviving a ghost", async (t) => {
  let arrived, release;
  const reached = new Promise((r) => (arrived = r)),
    blocked = new Promise((r) => (release = r));
  const f = await apiFixture(t, {
    providers: [
      fakeProvider({
        hold: async () => {
          arrived();
          await blocked;
        },
      }),
    ],
  });
  const ctx = await f.ctx.ready;
  const p = await ctx.workspaceService.saveProfile({ profile: profile() });
  const tar = await ctx.workspaceService.saveTarget(namedTargetInput({
    ...target(),
    profileRevisionId: p.revisionId,
  }));
  const started = await ctx.runService.startRun({
    targetRevisionId: tar.revisionId,
    mode: "rules",
  });
  await reached;
  const archive = await ctx.backup();
  release();
  await ctx.runService.waitForRun(started.runId);
  await ctx.restore(archive);
  const restored = await ctx.runService.getRun(started.runId);
  assert.equal(restored.status, "interrupted");
  assert.ok(!restored.ownerPid);
  assert.ok(restored.issues.some((i) => i.code === "restored_unfinished_run"));
  assert.equal(
    (await ctx.backup()).workspace.runs[started.runId].status,
    "interrupted",
  );
  await ctx.restore(await ctx.backup());
});

test("review 5: rescoring legacy evaluations returns an unknown prior qualification and preserves manual state", async (t) => {
  const { repository, jobs } = await legacy(t);
  const workspace = createWorkspaceService({ repository });
  const p = await workspace.saveProfile({ profile: profile() });
  const tar = await workspace.saveTarget(namedTargetInput({
    ...target(),
    profileRevisionId: p.revisionId,
  }));
  const jobId = (await jobs.queryJobs()).items[0].jobId;
  const result = await createEvaluationService({ repository }).rescore({
    jobIds: [jobId],
    profileRevisionId: p.revisionId,
    targetRevisionId: tar.revisionId,
    mode: "rules",
  });
  assert.equal(result.comparison[0].before.qualification, "unknown");
  assert.equal((await jobs.getJob(jobId)).application.status, "applied");
});

test("review 6: builtin collisions and malformed custom sites fail before committing any catalog mutation", async (t) => {
  const repository = await tempRepository(t);
  const builtin = loadSiteCatalog().find(
    (s) => s.providerId === "university-91job",
  );
  const service = createSourceService({
    repository,
    registry: createSourceRegistry([fakeProvider({ id: builtin.providerId })]),
  });
  const before = await repository.read();
  for (const input of [
    builtin,
    { ...builtin, siteId: "custom-bad", category: null },
  ]) {
    await assert.rejects(service.addSite(input), (e) => e.status === 400);
    assert.deepEqual(await repository.read(), before);
  }
});

test("review 7: expired transient backoff retries proven sites while unverified candidates stay excluded", () => {
  const base = {
    siteId: "site",
    providerId: "synthetic",
    category: "job_board",
    status: "ready",
  };
  const input = {
    targetSnapshot: target(),
    profileRevision: { profile: profile() },
  };
  assert.equal(
    buildCollectionPlan({
      ...input,
      catalog: [base],
      health: {
        "synthetic/site": {
          status: "unavailable",
          backoffUntil: "2000-01-01T00:00:00Z",
        },
      },
    }).sites.length,
    1,
  );
  assert.equal(
    buildCollectionPlan({
      ...input,
      catalog: [base],
      health: {
        "synthetic/site": {
          status: "unavailable",
          backoffUntil: "2099-01-01T00:00:00Z",
        },
      },
    }).sites.length,
    0,
  );
  assert.equal(
    buildCollectionPlan({
      ...input,
      catalog: [{ ...base, status: "candidate" }],
      health: {
        "synthetic/site": {
          status: "unavailable",
          backoffUntil: "2000-01-01T00:00:00Z",
        },
      },
    }).sites.length,
    0,
  );
});

test("review 8: selected target uses its own evaluation revision and retains unevaluated facts", async (t) => {
  const repository = await tempRepository(t),
    jobs = createJobService({ repository });
  await repository.mutateWorkspace((w) => {
    w.runs.a = { targetSnapshot: target() };
  });
  const { jobIds } = await jobs.ingestRecords({
    runId: "a",
    records: [job(), job({ sourceRecordId: "2" })],
  });
  await jobs.saveEvaluations([
    {
      evaluationId: "ea",
      jobId: jobIds[0],
      targetRevisionId: "t1@1",
      score: 41,
      createdAt: "2026-01-01",
    },
    {
      evaluationId: "eb",
      jobId: jobIds[0],
      targetRevisionId: "t2@1",
      score: 99,
      createdAt: "2026-02-01",
    },
  ]);
  const data = await jobs.queryJobs({
    targetId: "t1",
    targetRevisionId: "t1@1",
  });
  assert.equal(data.total, 2);
  assert.equal(
    data.items.find((i) => i.jobId === jobIds[0]).evaluation.score,
    41,
  );
  assert.equal(data.items.find((i) => i.jobId === jobIds[1]).evaluation, null);
  assert.equal(
    (await jobs.queryJobs({ targetId: "t1" })).items.find(
      (i) => i.jobId === jobIds[0],
    ).evaluation.score,
    41,
  );
});

test("review 10: export takes one snapshot so concurrent filter changes cannot cause endless pagination", async (t) => {
  const repository = await tempRepository(t),
    jobs = createJobService({ repository });
  await jobs.ingestRecords({
    runId: "fixture",
    records: Array.from({ length: 201 }, (_, i) =>
      job({ sourceRecordId: String(i) }),
    ),
  });
  const original = await repository.read();
  let reads = 0;
  const changing = {
    ...repository,
    read: async () => {
      reads++;
      if (reads > 4) throw Error("pagination made no progress");
      const copy = structuredClone(original);
      if (reads > 1)
        copy.applications[Object.keys(copy.jobs).at(-1)] = {
          status: "ignored",
        };
      return copy;
    },
  };
  const result = await createExportService({ repository: changing }).export({
    format: "json",
    filters: { status: "new" },
  });
  assert.equal(JSON.parse(result.body).length, 201);
  assert.equal(reads, 1);
});

test("review 11a: failed probes preserve the last successful time and capability", async (t) => {
  const repository = await tempRepository(t);
  const site = loadSiteCatalog().find(
    (s) => s.providerId === "university-91job",
  );
  let status = "ready",
    time = Date.parse("2026-01-01T00:00:00Z");
  const provider = fakeProvider({ id: site.providerId });
  provider.probe = async () => ({
    status,
    sampleCount: status === "ready" ? 1 : 0,
  });
  const service = createSourceService({
    repository,
    registry: createSourceRegistry([provider]),
    clock: { now: () => time },
    requestFactory: () => async () => {
      throw Error("Unexpected network");
    },
  });
  await service.probe(provider.id, site.siteId);
  status = "unavailable";
  time += 600000;
  await service.probe(provider.id, site.siteId);
  const health = (await repository.read()).sourceHealth[
    provider.id + "/" + site.siteId
  ];
  assert.equal(health.lastSuccessAt, "2026-01-01T00:00:00.000Z");
  assert.equal(health.lastAttemptAt, "2026-01-01T00:10:00.000Z");
});

test("review 11b: ordinary collection records source health without requiring a separate probe", async (t) => {
  const f = await apiFixture(t, {
      providers: [
        fakeProvider({
          records: [job({ description: job().description.repeat(3) })],
        }),
      ],
    }),
    ctx = await f.ctx.ready;
  const p = await ctx.workspaceService.saveProfile({ profile: profile() });
  const tar = await ctx.workspaceService.saveTarget(namedTargetInput({
    ...target(),
    profileRevisionId: p.revisionId,
  }));
  const { runId } = await ctx.runService.startRun({
    targetRevisionId: tar.revisionId,
    mode: "rules",
  });
  await ctx.runService.waitForRun(runId);
  const health = (await ctx.repository.read()).sourceHealth[
    "synthetic/synthetic-1"
  ];
  assert.equal(health?.status, "ready");
  assert.ok(health.lastSuccessAt);
  assert.ok(health.lastAttemptAt);
});
