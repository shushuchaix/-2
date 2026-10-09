import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { createApplicationContext } from "../../src/application/context.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
test("page_commit_is_atomic_replay_safe_and_empty_page_advances", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  const page = {
    pageKey: "page-1",
    cursorHash: "hash-1",
    nextCursor: { page: 2 },
    records: [job()],
    issues: [],
    done: false,
  };
  f.armFailure("workspace_commit");
  await assert.rejects(c.commit(page), /storage|write/i);
  assert.equal(
    (await f.service.get(c.ref)).collectionProgress.units.unit.committedPages,
    0,
  );
  assert.equal(Object.keys((await f.repository.read()).jobs).length, 0);
  const saved = await c.commit(page);
  assert.equal(saved.revision, 1);
  assert.equal((await c.commit(page)).duplicate, true);
  const empty = {
    pageKey: "page-2",
    cursorHash: "hash-2",
    nextCursor: null,
    records: [],
    issues: [],
    done: true,
  };
  await c.commit(empty, { ...c.token, expectedRevision: saved.revision });
  const w = await f.repository.read();
  assert.equal(Object.keys(w.jobs).length, 1);
  assert.equal(Object.keys(w.observations).length, 1);
  assert.equal(
    (await f.service.get(c.ref)).collectionProgress.units.unit.committedPages,
    2,
  );
  assert.equal(Object.values(w.jobs)[0].ownerPackageId, f.scope.packageId);
  await assert.rejects(f.service.get({ ...c.ref, scope: f.otherScope }), {
    code: "collection_scope",
  });
});
test("application_old_run_entry_starts_an_activity_and_history_counts_the_slice_once", async (t) => {
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({ records: [job()], hasMore: false }),
  });
  const f = await collectionFixture(t);
  const context = await createApplicationContext({
    cfg: {
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-flash",
        apiKey: "",
      },
      limits: { persist: false, perIpCooldownMs: 0 },
    },
    dataDir: f.dataDir,
    dependencies: {
      repository: f.repository,
      registry: createSourceRegistry([provider]),
      catalog: [
        {
          siteId: "s",
          providerId: "synthetic",
          category: "job_board",
          name: "synthetic",
          status: "ready",
          verifiedAt: new Date(f.clock.now()).toISOString(),
          probeEvidence: [{ hasRequirements: true }],
          origin: "https://jobs.example.org",
        },
      ],
      requestFactory: () => async () => {
        throw Error("No network in integration");
      },
    },
  });
  t.after(() => context.close().catch(() => {}));
  const result = await context.runService.startRun({
    scope: f.scope,
    mode: "rules",
  });
  assert.ok(result.activityId);
  const run = await context.runService.waitForRun(result.runId, f.scope);
  assert.equal(run.run.collectionRole, "collection_slice");
  assert.equal(run.jobs.length, 1);
  const history = await context.runService.listRuns(f.scope);
  assert.equal(history.length, 1);
  assert.equal(history[0].runId, result.runId);
  await assert.rejects(
    context.runService.cancelRun(result.activityId, f.scope),
    { code: "collection_control_required" },
  );
  await context.close();
});
test("repeated_continue_joins_one_slice_and_failed_pages_preserve_the_cursor", async (t) => {
  let release, started;
  const ready = new Promise((r) => (started = r));
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      started();
      await new Promise((resolve, reject) => {
        release = resolve;
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), {
          once: true,
        });
      });
      return { records: [job()], hasMore: false };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  const first = await f.service.start({
    scope: f.scope,
    options: { mode: "rules" },
  });
  await ready;
  const ref = { scope: f.scope, activityId: first.activityId };
  const [a, b] = await Promise.all([
    f.service.resume({ ref, requestId: "repeat" }),
    f.service.resume({ ref, requestId: "repeat" }),
  ]);
  assert.equal(a.sliceRunId, b.sliceRunId);
  assert.equal(a.sliceRunId, first.sliceRunId);
  release();
  await f.service.wait(ref);
  assert.equal(
    (await f.service.get(ref)).collectionProgress.status,
    "completed",
  );
  assert.equal(
    Object.values((await f.repository.read()).runs).filter(
      (r) => r.collectionRole === "collection_slice",
    ).length,
    1,
  );
});
