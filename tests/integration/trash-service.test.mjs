import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { packageFixture } from "../helpers/package-fixture.mjs";
import { createTrashService } from "../../src/application/trash-service.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { apiFixture } from "../helpers/api-fixture.mjs";

async function fixture(t, options = {}) {
  const f = await packageFixture(t);
  f.trash = createTrashService({ repository: f.repository, ...options });
  f.workspaceService = createWorkspaceService({
    repository: f.repository,
    trashService: f.trash,
  });
  return f;
}
const lease = (scope) => ({
  kind: "collect",
  ownerPid: process.pid,
  token: randomUUID(),
  packageIds: [scope.packageId],
  packageId: scope.packageId,
  targetRevisionId: scope.targetRevisionId,
});
test("archive and restore the complete package without changing other versions or enabled state", async (t) => {
  const f = await fixture(t),
    { a, b } = await f.twoTargets();
  await f.workspaceService.updateVersion({
    packageId: a.packageId,
    enabled: false,
  });
  const before = await f.repository.read(),
    peer = structuredClone(before.targets[b.targetId]);
  const archived = await f.trash.archive({ packageId: a.packageId });
  assert.equal(archived.state, "trashed");
  assert.equal(archived.purgeAt, "2026-10-12T00:00:00.000Z");
  await assert.rejects(f.workspaceService.getTargetRevision(a.revisionId), {
    code: "package_archived",
  });
  assert.equal(
    (await f.trash.get(a.packageId)).targets[0].profileSnapshot.text,
    a.profileSnapshot.text,
  );
  await f.trash.restore({
    packageId: a.packageId,
    archiveId: archived.archiveId,
  });
  assert.equal(
    (await f.workspaceService.getTargetRevision(a.revisionId)).enabled,
    false,
  );
  assert.deepEqual((await f.repository.read()).targets[b.targetId], peer);
});
test("duplicate archive does not renew deadline and rearchive uses a fresh instance", async (t) => {
  const f = await fixture(t),
    { a } = await f.twoTargets();
  const first = await f.trash.archive({ packageId: a.packageId }),
    before = await f.repository.read();
  f.clock.advance(1000);
  const second = await f.trash.archive({ packageId: a.packageId });
  assert.equal(second.archiveId, first.archiveId);
  assert.equal(second.purgeAt, first.purgeAt);
  assert.equal((await f.repository.read()).revision, before.revision);
  await f.trash.restore({ packageId: a.packageId, archiveId: first.archiveId });
  const third = await f.trash.archive({ packageId: a.packageId });
  assert.notEqual(third.archiveId, first.archiveId);
  await assert.rejects(
    f.trash.restore({ packageId: a.packageId, archiveId: first.archiveId }),
    { code: "trash_preview_stale" },
  );
});
test("exact 72h boundary refuses restore and body access before any sweep", async (t) => {
  const f = await fixture(t),
    { a } = await f.twoTargets(),
    p = await f.trash.archive({ packageId: a.packageId });
  f.clock.advance(72 * 60 * 60 * 1000 - 1);
  assert.equal((await f.trash.list())[0].canReadBody, true);
  assert.ok((await f.trash.get(a.packageId)).targets.length);
  f.clock.advance(1);
  await assert.rejects(
    f.trash.restore({ packageId: a.packageId, archiveId: p.archiveId }),
    { code: "package_expired" },
  );
  await assert.rejects(f.trash.get(a.packageId), { code: "package_expired" });
  const row = (await f.trash.list())[0];
  assert.equal(row.canReadBody, false);
  assert.equal(row.canRestore, false);
  assert.equal(row.status, "expired");
});
test("empty-all preview ignores list filters and active disabled versions, while expiry-only never empties young trash", async (t) => {
  const f = await fixture(t),
    { sourceProfile, a, b } = await f.twoTargets();
  await f.trash.archive({ packageId: sourceProfile.packageId });
  await f.trash.archive({ packageId: a.packageId });
  await f.workspaceService.updateVersion({
    packageId: b.packageId,
    enabled: false,
  });
  assert.equal(
    (await f.trash.list({ kind: "profile", search: "简历" })).length,
    1,
  );
  const all = await f.trash.preview({ emptyAll: true });
  assert.equal(all.packageCount, 2);
  assert.equal(all.totals.targets, 1);
  assert.ok(!all.candidates.some((p) => p.packageId === b.packageId));
  assert.equal((await f.trash.preview({ expiredOnly: true })).packageCount, 0);
  await assert.rejects(f.trash.preview({ emptyAll: true, expiredOnly: true }), {
    code: "trash_scope_required",
  });
  await assert.rejects(f.trash.preview({ packageIds: [b.packageId] }), {
    code: "package_scope_mismatch",
  });
});
test("preview tokens reject a changed revision, restored instance and edited candidate list", async (t) => {
  const f = await fixture(t),
    { a, b } = await f.twoTargets();
  await f.trash.archive({ packageId: a.packageId });
  const preview = await f.trash.preview({ emptyAll: true });
  await f.repository.withMaintenanceTransaction((tx) =>
    assert.equal(
      f.trash.validatePreview(tx, preview, f.clock.now())[0].packageId,
      a.packageId,
    ),
  );
  await assert.rejects(
    f.repository.withMaintenanceTransaction((tx) =>
      f.trash.validatePreview(
        tx,
        { ...preview, candidates: [] },
        f.clock.now(),
      ),
    ),
    { code: "trash_preview_stale" },
  );
  await f.trash.archive({ packageId: b.packageId });
  await assert.rejects(
    f.repository.withMaintenanceTransaction((tx) =>
      f.trash.validatePreview(tx, preview, f.clock.now()),
    ),
    { code: "trash_preview_stale" },
  );
});
test("archive waits for cancellation and its final write, failure leaves package active, unrelated packages do not block", async (t) => {
  let finish, started, entered;
  const cancellation = new Promise((r) => (finish = r)),
    began = new Promise((r) => (started = r));
  const f = await fixture(t, {
      cancelPackageAndWait: async (id) => {
        entered = id;
        started();
        await cancellation;
        await f.repository.mutateWorkspace(
          (w) => {
            delete w.operationLeases.op;
          },
          { operationMaintenance: true },
        );
      },
    }),
    { a, b } = await f.twoTargets();
  await f.repository.mutateWorkspace((w) => {
    w.operationLeases.op = lease(a);
  });
  await assert.rejects(f.trash.archive({ packageId: a.packageId }), {
    code: "workspace_operation_busy",
  });
  const archive = f.trash.archive({
    packageId: a.packageId,
    cancelActive: true,
  });
  await began;
  assert.equal(entered, a.packageId);
  assert.equal(
    (await f.repository.read()).packages[a.packageId].state,
    "active",
  );
  finish();
  await archive;
  await f.repository.mutateWorkspace((w) => {
    w.operationLeases.peer = lease(a);
  });
  const bp = await f.trash.archive({ packageId: b.packageId });
  assert.equal(bp.state, "trashed");
  const fail = await fixture(t, {
      cancelPackageAndWait: async () => {
        throw Error("synthetic cancellation failure");
      },
    }),
    seed = await fail.twoTargets();
  await fail.repository.mutateWorkspace((w) => {
    w.operationLeases.op = lease(seed.a);
  });
  await assert.rejects(
    fail.trash.archive({ packageId: seed.a.packageId, cancelActive: true }),
    /cancellation/,
  );
  assert.equal(
    (await fail.repository.read()).packages[seed.a.packageId].state,
    "active",
  );
});
test("pending deletion rows contain anonymous task information and never expose names or bodies", async (t) => {
  const f = await fixture(t),
    { a } = await f.twoTargets(),
    p = await f.trash.archive({ packageId: a.packageId });
  await f.repository.withMaintenanceTransaction(async (tx) => {
    const c = structuredClone(tx.control);
    c.deletionLedger[a.packageId] = {
      phase: "purge_pending",
      recordIds: [],
      archiveId: p.archiveId,
      archivedAt: p.archivedAt,
      purgeAt: p.purgeAt,
      operationId: "purge-synthetic",
      counts: { targets: 1 },
      code: "purge_file_failed",
    };
    await tx.commitControl(c);
  });
  const row = (await f.trash.list())[0];
  assert.equal(row.state, "purge_pending");
  assert.equal(row.operationId, "purge-synthetic");
  assert.equal(row.versionName, undefined);
  assert.ok(!JSON.stringify(row).includes(a.profileSnapshot.text));
  await assert.rejects(f.trash.get(a.packageId), {
    code: "package_purge_pending",
  });
});
test("HTTP trash routes archive list inspect preview and restore exact packages", async (t) => {
  const api = await apiFixture(t),
    f = await packageFixture(t, { dataDir: api.dataDir });
  const app = await api.ctx.ready;
  app.trashService = f.trash;
  const { a } = await f.twoTargets();
  const archived = await api.call("/api/v2/trash/archive", {
    packageId: a.packageId,
  });
  assert.equal(archived.response.status, 200);
  const list = await api.call("/api/v2/trash");
  assert.equal(list.data.items[0].packageId, a.packageId);
  const details = await api.call("/api/v2/trash/" + a.packageId);
  assert.equal(details.data.targets[0].revisionId, a.revisionId);
  const preview = await api.call("/api/v2/trash/preview", { emptyAll: true });
  assert.equal(preview.data.packageCount, 1);
  const denied = await api.call("/api/v2/trash/preview", { expiredOnly: true });
  assert.equal(denied.response.status, 400);
  const restored = await api.call("/api/v2/trash/restore", {
    packageId: a.packageId,
    archiveId: archived.data.archiveId,
  });
  assert.equal(restored.response.status, 200);
  assert.equal((await api.call("/api/v2/trash")).data.items.length, 0);
});
