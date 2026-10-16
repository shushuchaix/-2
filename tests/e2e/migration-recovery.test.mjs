import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
test("synthetic v1 migration keeps notes and repeated startup is idempotent", async (t) => {
  const dataDir = await createTempDir(t),
    index = {
      version: 1,
      jobs: {
        "old-1": {
          id: "old-1",
          title: "旧岗位",
          company: "合成公司",
          url: "https://example.com/job/old-1",
          source: "legacy",
          status: "applied",
          note: "保留旧备注",
          firstSeen: "2026-10-01T00:00:00.000Z",
          lastSeen: "2026-10-02T00:00:00.000Z",
          score: 80,
        },
      },
      runs: [],
    };
  await fs.writeFile(
    path.join(dataDir, "job-index.json"),
    JSON.stringify(index),
  );
  let f = await apiFixture(t, { dataDir });
  const jobs = await f.call("/api/v2/jobs");
  assert.equal(jobs.data.total, 1);
  assert.equal(jobs.data.items[0].application.note, "保留旧备注");
  const before = (await f.ctx.ready).migration;
  assert.equal(before.status, "migrated");
  const original = await fs.readFile(
    path.join(dataDir, "job-index.json"),
    "utf8",
  );
  f.ctx.server.closeAllConnections();
  await new Promise((r) => f.ctx.server.close(r));
  f = await apiFixture(t, { dataDir });
  assert.equal((await f.call("/api/v2/jobs")).data.total, 1);
  assert.equal(
    await fs.readFile(path.join(dataDir, "job-index.json"), "utf8"),
    original,
  );
});
