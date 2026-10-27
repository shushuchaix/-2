import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
import { contentHash } from "../../src/infrastructure/storage/content-hash.mjs";
import { assertWorkspace } from "../../src/domain/contracts.mjs";
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
  const original = JSON.stringify(index);
  await fs.writeFile(
    path.join(dataDir, "job-index.json"),
    original,
  );
  let f = await apiFixture(t, { dataDir, legacySchema: false });
  const jobs = await f.call("/api/v2/legacy-records");
  assert.equal(jobs.data.total, 1);
  const detail = await f.call("/api/v2/legacy-records/" + jobs.data.items[0].recordId);
  assert.equal(detail.data.root.note, "保留旧备注");
  assert.equal(detail.data.root.status, "applied");
  assert.equal(detail.data.counts.jobs, 1);
  const context = await f.ctx.ready;
  const before = context.repository.migration;
  assert.equal(before.changed, true);
  assert.equal(before.phase, "complete");
  const control = await context.repository.readControl();
  assert.deepEqual(control.migrationJournal.sqlite.legacyFiles, [{path:"job-index.json",hash:contentHash(original)}]);
  const archivePath = path.join(dataDir, "backups", before.archiveId);
  const archiveBody = await fs.readFile(archivePath,"utf8");
  const archive = JSON.parse(archiveBody);
  assert.equal(archive.manifest.migrationSourceHash, before.sourceHash);
  assert.equal(archive.manifest.workspaceHash, contentHash(archive.workspace));
  assert.equal(archive.workspace.migration.inputHash, contentHash([{path:"job-index.json",body:original}]));
  assert.ok(Object.values(archive.workspace.applications).some((application)=>application.note==="保留旧备注"));
  const markerPath = path.join(dataDir, "workspace.v2.json");
  const markerBody = await fs.readFile(markerPath,"utf8");
  const marker = JSON.parse(markerBody);
  assert.equal(marker.format, "resume-job-radar/sqlite-migrated");
  assert.equal(marker.sourceHash, before.sourceHash);
  // A legacy JSON reader's workspace contract must reject the refusal marker.
  assert.throws(()=>assertWorkspace(marker), /Unsupported workspace schema/);
  await assert.rejects(fs.access(path.join(dataDir,"job-index.json")), {code:"ENOENT"});
  await context.close();
  f.ctx.server.closeAllConnections();
  await new Promise((r) => f.ctx.server.close(r));
  f = await apiFixture(t, { dataDir, legacySchema: false });
  const restarted = await f.call("/api/v2/legacy-records");
  assert.equal(restarted.data.total, 1);
  const reopenedDetail = await f.call("/api/v2/legacy-records/" + restarted.data.items[0].recordId);
  assert.equal(reopenedDetail.data.root.note, "保留旧备注");
  assert.equal(reopenedDetail.data.root.status, "applied");
  assert.deepEqual(reopenedDetail.data, detail.data);
  assert.equal((await f.ctx.ready).repository.migration.changed,false);
  assert.equal(await fs.readFile(archivePath,"utf8"),archiveBody);
  assert.equal(await fs.readFile(markerPath,"utf8"),markerBody);
  await assert.rejects(fs.access(path.join(dataDir,"job-index.json")), {code:"ENOENT"});
});
