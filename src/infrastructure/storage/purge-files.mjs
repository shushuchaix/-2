import fs from "node:fs/promises";
import path from "node:path";
import { packageError, UUID_RE } from "../../domain/packages.mjs";
import { contentHash } from "./repository.mjs";
const unsafe = () =>
  packageError("purge_file_failed", "受管理文件无法安全校验或清理。", 503);
export async function assertManagedPath(
  layout,
  filename,
  { fsAdapter = fs, allowMissing = false } = {},
) {
  const root = path.resolve(layout.root),
    absolute = path.resolve(filename),
    relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw unsafe();
  const realRoot = await fsAdapter.realpath(root);
  let p = root;
  for (const part of relative.split(path.sep)) {
    p = path.join(p, part);
    let stat;
    try {
      stat = await fsAdapter.lstat(p);
    } catch (e) {
      if (e.code === "ENOENT" && allowMissing) return absolute;
      throw unsafe();
    }
    if (stat.isSymbolicLink()) throw unsafe();
    const real = await fsAdapter.realpath(p),
      rel = path.relative(realRoot, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw unsafe();
  }
  return absolute;
}
export function planPackageFiles({ layout, workspace, control, packageId }) {
  const effectiveOwner = (f) =>
    control.ownershipTransfers[f.recordId]?.to || f.ownerPackageId;
  const files = Object.values(workspace.files || {})
    .filter((f) => effectiveOwner(f) === packageId)
    .map((f) => {
      const copy = structuredClone(f),
        intent = control.ownershipTransfers[f.snapshotRecordId],
        journal =
          control.migrationJournal.ownershipTransferSnapshots?.[
            intent?.operationId
          ]?.[f.snapshotRecordId];
      copy.acceptedOwnerPackageIds = [
        ...new Set([f.ownerPackageId, packageId]),
      ];
      copy.acceptedHashes = [
        ...new Set([
          f.hash,
          ...(intent?.to === packageId && journal
            ? [journal.fromHash, journal.toHash]
            : []),
        ]),
      ];
      return copy;
    });
  for (const f of files) {
    if (
      !UUID_RE.test(f.recordId) ||
      !UUID_RE.test(f.snapshotRecordId) ||
      !/^runs-v2\/[A-Za-z0-9_-]{1,160}\.json$/.test(f.path || "")
    )
      throw unsafe();
    if (
      Object.values(workspace.files).some(
        (other) => effectiveOwner(other) !== packageId && other.path === f.path,
      )
    )
      throw unsafe();
  }
  for (const run of Object.values(workspace.runs))
    if (
      run.ownerPackageId === packageId &&
      run.snapshotRef &&
      !files.some((f) => f.path === run.snapshotRef.path)
    )
      throw unsafe();
  return { packageId, files };
}
export async function removeManagedFiles({ layout, filePlan, fsAdapter = fs }) {
  let removed = 0;
  for (const f of filePlan.files) {
    if (!/^runs-v2\/[A-Za-z0-9_-]{1,160}\.json$/.test(f.path || ""))
      throw unsafe();
    const filename = path.join(layout.root, f.path);
    await assertManagedPath(layout, filename, {
      fsAdapter,
      allowMissing: true,
    });
    let snapshot;
    try {
      snapshot = JSON.parse(await fsAdapter.readFile(filename, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw unsafe();
    }
    if (
      snapshot.recordId !== f.snapshotRecordId ||
      !(f.acceptedOwnerPackageIds || [filePlan.packageId]).includes(
        snapshot.ownerPackageId,
      ) ||
      !(f.acceptedHashes || [f.hash]).includes(contentHash(snapshot))
    )
      throw unsafe();
    await fsAdapter.unlink(filename);
    try {
      await fsAdapter.lstat(filename);
      throw unsafe();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    removed++;
  }
  return { removed, completed: true };
}
