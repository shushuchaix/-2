import test from "node:test";
import assert from "node:assert/strict";
import { tempRepository } from "../helpers/repository.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { profile, AT } from "../helpers/fixtures.mjs";
async function setup(t) {
  const repository = await tempRepository(t),
    service = createWorkspaceService({ repository });
  const p = await service.saveProfile({ profile: profile() });
  const input = {
    targetId: "t1",
    profileRevisionId: p.revisionId,
    roles: ["合成岗位"],
    sourceIds: ["synthetic"],
    versionName: "消防方向",
    submissionId: "request-1",
  };
  return { repository, service, p, input };
}
test("concurrent equivalent names and retries save exactly one version", async (t) => {
  const { repository, service, input } = await setup(t);
  const results = await Promise.allSettled([
    service.saveTarget(input),
    service.saveTarget({
      ...input,
      submissionId: "request-2",
      versionName: " 消防方向 ",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "version_name_conflict",
  );
  const first = results[0].value;
  assert.equal(
    (await service.saveTarget({ ...input })).revisionId,
    first.revisionId,
  );
  await assert.rejects(
    service.saveTarget({ ...input, roles: ["机场"] }),
    (e) => e.code === "version_submission_conflict",
  );
  assert.equal((await repository.read()).targets.t1.length, 1);
});
test("management changes preserve immutable config and do not revalidate old sources", async (t) => {
  const { repository, service, input } = await setup(t),
    saved = await service.saveTarget(input),
    before = await repository.read();
  const restricted = createWorkspaceService({ repository, sourceIds: [] });
  const args = { kind: "target", parentId: "t1", revisionId: saved.revisionId };
  const off = await restricted.updateVersion({ ...args, enabled: false });
  assert.equal(off.enabled, false);
  const renamed = await restricted.updateVersion({
    ...args,
    versionName: "机场消防",
  });
  assert.equal(renamed.versionName, "机场消防");
  assert.deepEqual((await repository.read()).targets, before.targets);
  await assert.rejects(
    restricted.saveTarget({
      ...input,
      submissionId: "new",
      versionName: "另一个方向",
    }),
    (e) => !!e.fieldErrors?.sourceIds,
  );
  assert.equal(
    (await restricted.updateVersion({ ...args, versionName: "机场消防" }))
      .unchanged,
    true,
  );
  await assert.rejects(
    restricted.updateVersion({ ...args, parentId: "other", enabled: true }),
    (e) => e.code === "version_parent_mismatch",
  );
});
test("archive keeps references and names; restore retains ID; counters never reuse IDs", async (t) => {
  const { repository, service, input, p } = await setup(t),
    saved = await service.saveTarget(input);
  const args = { kind: "target", parentId: "t1", revisionId: saved.revisionId };
  assert.ok((await service.archiveVersion(args)).archivedAt);
  await assert.rejects(
    service.saveTarget({ ...input, submissionId: "another" }),
    (e) => e.code === "version_name_conflict",
  );
  assert.equal(
    (await service.restoreVersion(args)).revisionId,
    saved.revisionId,
  );
  await service.archiveVersion(args);
  await service.permanentlyDeleteVersion(args);
  const next = await service.saveTarget({
    ...input,
    submissionId: "next",
    versionName: "新消防",
  });
  assert.equal(next.revisionId, "t1@2");
  await assert.rejects(
    service.saveTarget(input),
    (e) => e.code === "version_submission_retired",
  );
  const archived = await service.archiveVersion({
    kind: "profile",
    parentId: p.profileId,
    revisionId: p.revisionId,
  });
  assert.ok(archived.archivedAt);
  await assert.rejects(
    service.saveTarget({
      ...input,
      submissionId: "new",
      versionName: "新目标",
    }),
    (e) => e.code === "version_archived",
  );
  await assert.rejects(
    service.permanentlyDeleteVersion({
      kind: "profile",
      parentId: p.profileId,
      revisionId: p.revisionId,
    }),
    (e) => e.code === "version_referenced" && e.references.targets === 1,
  );
  assert.equal((await repository.read()).targets.t1.length, 1);
});
test("permanent deletion checks historical resume event references", async (t) => {
  const { repository, service, p } = await setup(t);
  await repository.mutateWorkspace((w) => {
    w.applications.old = {
      jobId: "old",
      status: "seen",
      note: "合成",
      resumeRevisionId: null,
      events: [
        {
          at: AT,
          changes: { resumeRevisionId: { from: p.revisionId, to: null } },
        },
      ],
    };
  });
  const args = {
    kind: "profile",
    parentId: p.profileId,
    revisionId: p.revisionId,
  };
  await service.archiveVersion(args);
  await assert.rejects(
    service.permanentlyDeleteVersion(args),
    (e) =>
      e.code === "version_referenced" && e.references.applicationEvents === 1,
  );
});
test("profile display names have a separate namespace and never become profile facts", async (t) => {
  const { service, input } = await setup(t);
  await service.saveTarget(input);
  const saved = await service.saveProfile({
    versionName: "消防方向",
    submissionId: "profile-request",
    profile: { ...profile(), name: "合成人名" },
  });
  assert.equal(saved.versionName, "消防方向");
  assert.equal(saved.profile.name, "合成人名");
  assert.equal(saved.profile.versionName, undefined);
  assert.equal(saved.profile.submissionId, undefined);
  await assert.rejects(
    service.saveProfile({ versionName: "消防方向", profile: profile() }),
    (e) => e.code === "version_name_conflict",
  );
});
test("version routes enforce parent and allow archive restore management without config", async (t) => {
  const f = await apiFixture(t),
    p = (await f.call("/api/v2/profiles", { profile: profile() })).data;
  const saved = (
    await f.call("/api/v2/targets", {
      profileRevisionId: p.revisionId,
      roles: ["合成"],
      versionName: "API消防",
    })
  ).data;
  const base =
    "/api/v2/targets/" + saved.targetId + "/revisions/" + saved.revisionId;
  assert.equal(
    (await f.call(base, { enabled: false }, "PATCH")).data.enabled,
    false,
  );
  assert.equal((await f.call(base, undefined, "DELETE")).response.status, 200);
  assert.ok((await f.call(base)).data.archivedAt);
  assert.equal((await f.call(base + "/restore", {})).data.archivedAt, null);
  assert.equal(
    (
      await f.call(
        base.replace(saved.targetId, "wrong"),
        { enabled: true },
        "PATCH",
      )
    ).data.code,
    "version_parent_mismatch",
  );
  const pb = "/api/v2/profiles/" + p.profileId + "/revisions/" + p.revisionId;
  await f.call(pb, undefined, "DELETE");
  const blocked = await f.call(pb + "/permanent", undefined, "DELETE");
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.data.references?.targets, 1);
});
