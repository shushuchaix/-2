import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAttachmentCleanup } from "../../src/attachments/cleanup.mjs";
test("cleanup_manifest_survives_failed_delete_and_restarts_after_package_is_gone", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, "temp"),
    manifestPath = path.join(root, "control", "manifest.json");
  let locked = true;
  const adapter = {
    ...fs,
    unlink: async (p) => {
      if (locked && p.endsWith("input.bin"))
        throw Object.assign(Error("busy"), { code: "EBUSY" });
      return fs.unlink(p);
    },
  };
  const cleanup = createAttachmentCleanup({
    tempRoot,
    manifestPath,
    fsAdapter: adapter,
  });
  const file = await cleanup.register({
    scope: { packageId: "p", targetRevisionId: "t" },
    activityId: "a",
    attemptId: "attempt",
    relativePath: "attempt/input.bin",
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "synthetic");
  assert.equal((await cleanup.cleanupPackage("p")).status, "cleanup_pending");
  assert.equal(JSON.parse(await fs.readFile(manifestPath)).entries.length, 1);
  locked = false;
  const reopened = createAttachmentCleanup({ tempRoot, manifestPath });
  assert.equal((await reopened.resumePending()).status, "clean");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(manifestPath)).entries.length, 0);
});
test("cleanup_rejects_escape_and_junction_paths_without_deleting_outside", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside"),
    tempRoot = path.join(root, "temp"),
    manifestPath = path.join(root, "manifest.json");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep"), "safe");
  await fs.mkdir(tempRoot);
  await fs.symlink(outside, path.join(tempRoot, "link"), "junction");
  const cleanup = createAttachmentCleanup({ tempRoot, manifestPath });
  for (const relativePath of ["../outside/keep", "link/keep"])
    await assert.rejects(
      cleanup.register({
        scope: { packageId: "p", targetRevisionId: "t" },
        activityId: "a",
        attemptId: "x",
        relativePath,
      }),
    );
  assert.equal(await fs.readFile(path.join(outside, "keep"), "utf8"), "safe");
});
