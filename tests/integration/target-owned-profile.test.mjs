import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { packageFixture } from "../helpers/package-fixture.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { namedTargetInput } from "../helpers/fixtures.mjs";
const targetInput = (input) => ({
  ...namedTargetInput(input),
  roles: input.roles || ["消防"],
  versionName: input.versionName || "合成目标",
});

async function fixture(t) {
  const f = await packageFixture(t);
  f.workspaceService = createWorkspaceService({ repository: f.repository });
  return f;
}
const profileInput = (extra = {}) => ({
  text: "合成测试简历：本科消防工程专业，拥有机场安全检查与消防项目经验。",
  profile: { major: "消防工程", cities: ["北京"] },
  overrides: { major: "安全工程" },
  importMetadata: { type: "pdf", pageCount: 1, parser: "synthetic" },
  versionName: "合成简历",
  ...extra,
});
async function targets(f) {
  const sourceProfile = await f.workspaceService.saveProfile(profileInput());
  const a = await f.workspaceService.saveTarget(
    targetInput({
      versionName: "消防方向",
      profileRevisionId: sourceProfile.revisionId,
      roles: ["消防"],
    }),
  );
  const b = await f.workspaceService.saveTarget(
    targetInput({
      versionName: "机场方向",
      profileRevisionId: sourceProfile.revisionId,
      roles: ["机场"],
    }),
  );
  return { sourceProfile, a, b };
}
test("target resume copies raw text, structured profile, overrides and import metadata independently", async (t) => {
  const f = await fixture(t),
    { sourceProfile, a, b } = await targets(f);
  const wa = await f.workspaceService.getTargetRevision(a.revisionId),
    wb = await f.workspaceService.getTargetRevision(b.revisionId);
  assert.notEqual(wa.profileSnapshot.recordId, wb.profileSnapshot.recordId);
  assert.equal(wa.profileSnapshot.ownerPackageId, a.packageId);
  assert.equal(
    wa.profileSnapshot.provenance.profileRevisionId,
    sourceProfile.revisionId,
  );
  assert.equal(wa.profileSnapshot.profile.major, "安全工程");
  assert.deepEqual(
    wa.profileSnapshot.importMetadata,
    sourceProfile.importMetadata,
  );
  await f.repository.mutateWorkspace((w) => {
    delete w.profiles[sourceProfile.profileId];
    delete w.versionMetadata[sourceProfile.revisionId];
    delete w.packages[sourceProfile.packageId];
  });
  assert.equal(
    (await f.workspaceService.getTargetRevision(a.revisionId)).profileSnapshot
      .text,
    sourceProfile.text,
  );
  assert.equal(
    (await f.workspaceService.getTargetRevision(a.revisionId)).availability
      .canCollect,
    true,
  );
});
test("same normalized name is occupied by active trashed and pending packages while cross-kind names are allowed", async (t) => {
  const f = await fixture(t),
    p = await f.workspaceService.saveProfile(
      profileInput({ versionName: "ＡＢＣ 求职" }),
    );
  await assert.rejects(
    f.workspaceService.saveProfile(
      profileInput({ versionName: "  abc   求职  " }),
    ),
    { code: "version_name_conflict" },
  );
  const a = await f.workspaceService.saveTarget(
    targetInput({
      versionName: "ＡＢＣ 求职",
      profileRevisionId: p.revisionId,
    }),
  );
  await f.repository.mutateWorkspace((w) => {
    Object.assign(w.packages[a.packageId], {
      state: "trashed",
      archiveId: randomUUID(),
      archivedAt: "2026-10-09T00:00:00.000Z",
      purgeAt: "2026-10-12T00:00:00.000Z",
    });
    w.versionMetadata[a.revisionId].archivedAt = "2026-10-09T00:00:00.000Z";
  });
  await assert.rejects(
    f.workspaceService.saveTarget(
      targetInput({ versionName: "abc 求职", profileRevisionId: p.revisionId }),
    ),
    { code: "version_name_conflict" },
  );
  await f.repository.withMaintenanceTransaction(async (tx) => {
    const c = structuredClone(tx.control),
      pkg = tx.workspace.packages[a.packageId];
    c.deletionLedger[a.packageId] = {
      phase: "purge_pending",
      recordIds: [],
      archiveId: pkg.archiveId,
      archivedAt: pkg.archivedAt,
      purgeAt: pkg.purgeAt,
    };
    await tx.commitControl(c);
    await tx.commitWorkspace(tx.workspace);
  });
  await assert.rejects(
    f.workspaceService.saveTarget(
      targetInput({ versionName: "abc 求职", profileRevisionId: p.revisionId }),
    ),
    { code: "version_name_conflict" },
  );
});
test("submission retry after failed main write reuses package identity and reserved revision", async (t) => {
  const f = await fixture(t),
    input = profileInput({ submissionId: "synthetic-profile-submit" });
  f.armFailure("workspace_commit");
  await assert.rejects(f.workspaceService.saveProfile(input));
  const prepared = await f.control.read();
  const p = await f.workspaceService.saveProfile(input);
  const retry = await f.workspaceService.saveProfile(input);
  assert.equal(retry.packageId, p.packageId);
  assert.equal(retry.revisionId, p.revisionId);
  assert.ok(
    Object.values(prepared.identityIndex.package).includes(p.packageId),
  );
  assert.equal(
    Object.values((await f.repository.read()).profiles).flat().length,
    1,
  );
});
test("version high water is retained after an older body is restored and invalid saves do not consume names", async (t) => {
  const f = await fixture(t),
    p = await f.workspaceService.saveProfile(
      profileInput({ profileId: "synthetic-profile" }),
    );
  const old = await f.repository.read();
  await f.workspaceService.saveProfile(
    profileInput({ profileId: p.profileId, versionName: "第二版" }),
  );
  await f.repository.withMaintenanceTransaction((tx) =>
    tx.commitWorkspace(old),
  );
  const next = await f.workspaceService.saveProfile(
    profileInput({ profileId: p.profileId, versionName: "第三版" }),
  );
  assert.equal(next.revision, 3);
  const before = await f.control.read();
  await assert.rejects(
    f.workspaceService.saveProfile(
      profileInput({ versionName: "x".repeat(61) }),
    ),
  );
  assert.deepEqual(await f.control.read(), before);
});
test("version metadata updates need the correct package and normal reads exclude trash", async (t) => {
  const f = await fixture(t),
    { a, b } = await targets(f);
  await assert.rejects(
    f.workspaceService.updateVersion({
      packageId: b.packageId,
      revisionId: a.revisionId,
      enabled: false,
    }),
    { code: "package_scope_mismatch" },
  );
  const updated = await f.workspaceService.updateVersion({
    packageId: a.packageId,
    revisionId: a.revisionId,
    versionName: "新消防方向",
    enabled: false,
  });
  assert.equal(updated.versionName, "新消防方向");
  assert.equal(updated.enabled, false);
  await f.repository.mutateWorkspace((w) => {
    Object.assign(w.packages[a.packageId], {
      state: "trashed",
      archiveId: randomUUID(),
      archivedAt: "2026-10-09T00:00:00.000Z",
      purgeAt: "2026-10-12T00:00:00.000Z",
    });
    w.versionMetadata[a.revisionId].archivedAt = "2026-10-09T00:00:00.000Z";
  });
  assert.ok(
    !(await f.workspaceService.listTargets()).some(
      (t) => t.packageId === a.packageId,
    ),
  );
  await assert.rejects(f.workspaceService.getTargetRevision(a.revisionId), {
    code: "package_archived",
  });
});
