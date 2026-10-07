import {namedTargetInput} from '../helpers/fixtures.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tempRepository } from "../helpers/repository.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config.mjs";
import { apiFixture } from "../helpers/api-fixture.mjs";
function referencedProfileError(error) {
  assert.equal(error.status, 409);
  assert.equal(error.code, "version_referenced");
  assert.match(error.fieldErrors.revisionId, /引用.*不能永久删除/);
  assert.ok(Object.values(error.references).some(n=>n>0));
  return true;
}
test("profile and target revisions are immutable and references prevent deletion", async (t) => {
  const repository = await tempRepository(t);
  const s = createWorkspaceService({ repository });
  const a = await s.saveProfile({
    text: "合成简历：本科消防工程专业，拥有工程实践项目经验，期望在北京从事安全工程工作。",
    profile: { major: "消防工程", cities: ["北京"] },
    overrides: { major: "安全工程" },
  });
  const b = await s.saveProfile({
    profileId: a.profileId,
    text: "更新简历：本科软件工程专业，掌握 Java 开发，拥有项目经验，期望从事软件开发工作。",
    profile: { major: "软件工程" },
  });
  assert.notEqual(a.revisionId, b.revisionId);
  assert.equal((await s.getProfileRevision(a.revisionId)).text, a.text);
  assert.equal(a.profile.major, "安全工程");
  const target = await s.saveTarget(namedTargetInput({
    profileRevisionId: a.revisionId,
    roles: ["安全工程师"],
    cityMode: "any",
    cities: [],
    enabled: false,
  }));
  assert.equal(target.enabled, false);
  assert.equal(target.profileRevisionId, a.revisionId);
  await s.deleteProfileRevision(a.revisionId);
  await assert.rejects(
    s.permanentlyDeleteVersion({kind:'profile',parentId:a.profileId,revisionId:a.revisionId}),
    referencedProfileError,
  );
  await assert.rejects(
    s.saveTarget(namedTargetInput({ profileRevisionId: "absent@1", roles: ["岗位"] })),
    (e) => e.status === 400 && !!e.fieldErrors.profileRevisionId,
  );
  assert.equal(
    (
      await s.saveTarget(namedTargetInput({
        profileRevisionId: b.revisionId,
        roles: ["岗位"],
        cities: null,
      }))
    ).cityMode,
    "from_profile",
  );
  assert.equal(
    (
      await s.saveTarget(namedTargetInput({
        profileRevisionId: b.revisionId,
        roles: ["岗位"],
        cities: ["上海"],
      }))
    ).cityMode,
    "selected",
  );
});
for (const reference of ["target", "run", "application"]) {
  test(`referenced profile deletion reports a conflict and preserves ${reference} history`, async (t) => {
    const repository = await tempRepository(t);
    const service = createWorkspaceService({ repository });
    const saved = await service.saveProfile({
      text: "合成简历正文，仅用于删除引用保护测试，包含软件开发项目经验和求职意向。",
      profile: { major: "合成专业" },
    });
    if (reference === "target") {
      await service.saveTarget(namedTargetInput({
        profileRevisionId: saved.revisionId,
        roles: ["合成岗位"],
        enabled: false,
      }));
    } else {
      await repository.mutateWorkspace((workspace) => {
        if (reference === "run")
          workspace.runs["synthetic-run"] = {
            runId: "synthetic-run",
            status: "completed",
            stage: "finished",
            targetSnapshot: { profileRevisionId: saved.revisionId },
            counts: {},
            usage: {},
            coverage: [],
            issues: [],
            lastSeq: 0,
          };
        else
          workspace.applications["synthetic-job"] = {
            jobId: "synthetic-job",
            status: "applied",
            note: "合成记录",
            resumeRevisionId: saved.revisionId,
            events: [],
          };
      });
    }
    await service.deleteProfileRevision(saved.revisionId);
    const before = await repository.read();
    await assert.rejects(
      service.permanentlyDeleteVersion({kind:'profile',parentId:saved.profileId,revisionId:saved.revisionId}),
      referencedProfileError,
    );
    assert.deepEqual(await repository.read(), before);
  });
}
test("unreferenced profile deletion still succeeds and retains the other revision", async (t) => {
  const repository = await tempRepository(t);
  const service = createWorkspaceService({ repository });
  const first = await service.saveProfile({
    text: "第一份合成简历正文，用于验证未引用版本可删除，同时保留其他版本的历史记录。",
  });
  const second = await service.saveProfile({
    profileId: first.profileId,
    text: "第二份合成简历正文，用于验证未引用版本可删除，同时保留其他版本的历史记录。",
  });
  assert.ok((await service.deleteProfileRevision(first.revisionId)).archivedAt);
  assert.deepEqual(await service.permanentlyDeleteVersion({kind:'profile',parentId:first.profileId,revisionId:first.revisionId}), {
    deleted: first.revisionId,
    permanent:true,
  });
  assert.equal(await service.getProfileRevision(first.revisionId), null);
  assert.deepEqual(await service.getProfileRevision(second.revisionId), second);
});
test("profile DELETE returns Chinese HTTP 409 field feedback for a referenced version", async (t) => {
  const f = await apiFixture(t);
  const { data: saved } = await f.call("/api/v2/profiles", {
    text: "合成简历正文，本科软件工程背景，包含开发项目经验，期望从事软件开发工作。",
    profile: { major: "合成专业" },
  });
  assert.ok(saved.revisionId);
  const { response: targetResponse } = await f.call("/api/v2/targets", namedTargetInput({
    profileRevisionId: saved.revisionId,
    roles: ["合成岗位"],
  }));
  assert.equal(targetResponse.status, 201);
  const base = "/api/v2/profiles/"+encodeURIComponent(saved.profileId)+"/revisions/"+encodeURIComponent(saved.revisionId);
  assert.equal((await f.call(base,undefined,'DELETE')).response.status,200);
  const { response, data } = await f.call(
    "/api/v2/profiles/" +
      encodeURIComponent(saved.profileId) +
      "/revisions/" +
      encodeURIComponent(saved.revisionId)+"/permanent",
    undefined,
    "DELETE",
  );
  assert.equal(response.status, 409);
  assert.equal(data.code, "version_referenced");
  assert.match(data.fieldErrors.revisionId, /引用.*不能永久删除/);
  assert.equal(data.references.targets,1);
  assert.equal(typeof data.diagnosticId, "string");
  const { data: stillPresent } = await f.call(
    "/api/v2/profiles/" +
      encodeURIComponent(saved.profileId) +
      "/revisions/" +
      encodeURIComponent(saved.revisionId),
  );
  assert.equal(stillPresent.revisionId, saved.revisionId);
});
test("configuration reads new seeds immediately and never mutates defaults", async (t) => {
  const repo = await tempRepository(t);
  const first = loadConfig({ quiet: true, dataDir: repo.dataDir });
  first.sources.zhaopin.enabled = false;
  first.deepseek.apiKey = "mutation";
  assert.equal(DEFAULT_CONFIG.sources.zhaopin.enabled, true);
  assert.equal(DEFAULT_CONFIG.deepseek.apiKey, "");
  await fs.writeFile(
    path.join(repo.dataDir, "config.json"),
    JSON.stringify({
      sources: { zhaopin: { enabled: false } },
      server: { port: 9876 },
    }),
  );
  const seeded = loadConfig({ quiet: true, dataDir: repo.dataDir });
  assert.equal(seeded.server.port, 9876);
  assert.equal(seeded.sources.zhaopin.enabled, false);
  assert.equal(
    loadConfig({ quiet: true, dataDir: repo.dataDir }).server.port,
    9876,
  );
});
