import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../infrastructure/storage/atomic.mjs";
import { withWorkspaceLock } from "../infrastructure/storage/lock.mjs";
const safeId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 160 &&
  !/[\u0000-\u001f]/.test(value);
export function createAttachmentCleanup({
  tempRoot,
  manifestPath,
  fsAdapter = fs,
}) {
  const root = path.resolve(tempRoot),
    manifest = path.resolve(manifestPath),
    lockDir = path.dirname(manifest);
  async function safePath(relativePath) {
    if (
      typeof relativePath !== "string" ||
      relativePath.length > 512 ||
      path.isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath
        .split("/")
        .some(
          (s) => !s || s === "." || s === ".." || !/^[A-Za-z0-9_.-]+$/.test(s),
        )
    )
      throw Error("Unsafe temporary path");
    const dest = path.resolve(root, relativePath);
    if (path.relative(root, dest).startsWith(".."))
      throw Error("Unsafe temporary path");
    for (
      let ancestor = path.dirname(root);
      ;
      ancestor = path.dirname(ancestor)
    ) {
      try {
        if ((await fsAdapter.lstat(ancestor)).isSymbolicLink())
          throw Error("Temporary ancestor link forbidden");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (path.dirname(ancestor) === ancestor) break;
    }
    for (let part = root; ; ) {
      try {
        if ((await fsAdapter.lstat(part)).isSymbolicLink())
          throw Error("Temporary link forbidden");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (part === dest) break;
      const relative = path.relative(part, dest).split(path.sep);
      part = path.join(part, relative[0]);
    }
    return dest;
  }
  async function load() {
    let data;
    try {
      data = JSON.parse(await fsAdapter.readFile(manifest, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return { version: 1, entries: [] };
      throw e;
    }
    if (
      data.version !== 1 ||
      !Array.isArray(data.entries) ||
      data.entries.length > 10000
    )
      throw Error("Invalid cleanup manifest");
    return data;
  }
  async function remove(dest) {
    const stat = await fsAdapter.lstat(dest).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw Error("Temporary link forbidden");
    if (stat.isDirectory()) {
      for (const name of await fsAdapter.readdir(dest)) {
        const child = await safePath(
          path.relative(root, path.join(dest, name)).split(path.sep).join("/"),
        );
        await remove(child);
      }
      await fsAdapter.rmdir(dest);
    } else if (stat.isFile()) await fsAdapter.unlink(dest);
    else throw Error("Unsupported temporary object");
  }
  async function sweep(select) {
    return withWorkspaceLock(lockDir, async () => {
      const data = await load();
      let pending = 0;
      const keep = [];
      for (const entry of data.entries) {
        if (!select(entry)) {
          keep.push(entry);
          continue;
        }
        try {
          await remove(await safePath(entry.relativePath));
        } catch {
          entry.status = "cleanup_pending";
          keep.push(entry);
          pending++;
        }
      }
      data.entries = keep;
      await writeAtomicJson(manifest, data);
      return { status: pending ? "cleanup_pending" : "clean", pending };
    });
  }
  return {
    async register({ scope, activityId, attemptId, relativePath }) {
      if (
        !safeId(scope?.packageId) ||
        !safeId(scope?.targetRevisionId) ||
        !safeId(activityId) ||
        !safeId(attemptId)
      )
        throw Error("Invalid cleanup ownership");
      const dest = await safePath(relativePath);
      await withWorkspaceLock(lockDir, async () => {
        const data = await load();
        const existing = data.entries.find(
          (e) => e.relativePath === relativePath,
        );
        if (
          existing &&
          (existing.packageId !== scope.packageId ||
            existing.attemptId !== attemptId)
        )
          throw Error("Temporary path already owned");
        if (!existing)
          data.entries.push({
            id: randomUUID(),
            packageId: scope.packageId,
            targetRevisionId: scope.targetRevisionId,
            activityId,
            attemptId,
            relativePath,
            status: "registered",
          });
        await writeAtomicJson(manifest, data);
      });
      return dest;
    },
    cleanupAttempt: (attemptId) => sweep((e) => e.attemptId === attemptId),
    cleanupPackage: (packageId) => sweep((e) => e.packageId === packageId),
    resumePending: () => sweep(() => true),
    tempRoot: root,
  };
}
