import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tempRepository } from "../helpers/repository.mjs";
import { job } from "../helpers/fixtures.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";

test("malformed canonical mutation is rejected before replacing a committed workspace", async (t) => {
  const repository = await tempRepository(t);
  await repository.mutateWorkspace((w) => {
    w.jobs.j = { jobId: "j", kind: "job", canonical: job() };
    w.jobs.stub = {
      jobId: "stub",
      kind: "job",
      canonical: { title: "合成历史稀疏记录" },
    };
  });
  const before = await repository.read();
  const file = path.join(repository.dataDir, "workspace.v2.json");
  const bytes = await fs.readFile(file, "utf8");
  for (const fields of [
    { cities: "北京" },
    { evidence: [42] },
    { description: {} },
    { jobType: "fulltime" },
  ]) {
    await assert.rejects(
      repository.mutateWorkspace((w) =>
        Object.assign(w.jobs.j.canonical, fields),
      ),
      /Invalid source/,
    );
    assert.equal(await fs.readFile(file, "utf8"), bytes);
    assert.deepEqual(await repository.read(), before);
  }
  const reopened = await openWorkspaceRepository({
    allowLegacy: true,
    dataDir: repository.dataDir,
  });
  assert.deepEqual(await reopened.read(), before);
  assert.deepEqual((await reopened.read()).jobs.stub.canonical, {
    title: "合成历史稀疏记录",
  });
});
