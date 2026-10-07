import test from "node:test";
import assert from "node:assert/strict";
import { tempRepository } from "../helpers/repository.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { profile } from "../helpers/fixtures.mjs";
test("version names normalize equivalent spellings and preserve meaning", async (t) => {
  const repository = await tempRepository(t),
    service = createWorkspaceService({ repository });
  const p = await service.saveProfile({ profile: profile() });
  const save = (versionName) =>
    service.saveTarget({
      profileRevisionId: p.revisionId,
      roles: ["合成岗位"],
      versionName,
    });
  const first = await save(" ＡＢＣ  方向 ");
  assert.equal(first.versionName, "ABC 方向");
  await assert.rejects(
    save("abc 方向"),
    (e) => e.code === "version_name_conflict",
  );
  assert.notEqual(
    (await save("机场-消防")).revisionId,
    (await save("机场 消防")).revisionId,
  );
  await assert.rejects(save(""), (e) => !!e.fieldErrors?.versionName);
  await assert.rejects(
    save("a".repeat(61)),
    (e) => !!e.fieldErrors?.versionName,
  );
  assert.equal((await save("a".repeat(60))).versionName.length, 60);
  assert.equal((await save("单")).versionName, "单");
});
