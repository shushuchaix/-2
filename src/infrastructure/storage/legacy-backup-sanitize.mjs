import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./repository.mjs";
import { writeAtomicJson } from "./atomic.mjs";
import { migrateV1 } from "./migrate-v1.mjs";
import { assertControl, assertControlTransition } from "./package-control.mjs";
import { validateBackupArchive } from "./backup.mjs";
import { createEmptyWorkspace } from "../../domain/contracts.mjs";
import { redactBusiness } from "../../domain/redact.mjs";
import { packageError, UUID_RE } from "../../domain/packages.mjs";

const HASH = /^[a-f0-9]{64}$/;
const LEGACY_PATH =
  /^(?:job-index\.json|runs\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json)$/;
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const samePath = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const unsafe = () => {
  throw Error("Unsafe managed legacy backup");
};

async function inspectPath(
  filename,
  fsAdapter,
  { optional = false, directory = false } = {},
) {
  const absolute = path.resolve(filename),
    parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    let stat;
    try {
      stat = await fsAdapter.lstat(current);
    } catch (error) {
      if (optional && error.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) unsafe();
    if (i < parts.length - 1 && !stat.isDirectory()) unsafe();
    if (!samePath(await fsAdapter.realpath(current), current)) unsafe();
    if (
      i === parts.length - 1 &&
      (directory ? !stat.isDirectory() : !stat.isFile())
    )
      unsafe();
  }
  return absolute;
}

async function readManaged(filename, fsAdapter, { optional = false } = {}) {
  if (!(await inspectPath(filename, fsAdapter, { optional }))) return null;
  const body = await fsAdapter.readFile(filename, "utf8");
  await inspectPath(filename, fsAdapter);
  return body;
}

function validateManifest(manifest, directoryHash) {
  if (
    !plain(manifest) ||
    manifest.version !== 1 ||
    !HASH.test(manifest.inputHash) ||
    !manifest.inputHash.startsWith(directoryHash) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    unsafe();
  const paths = new Set();
  for (const file of manifest.files) {
    if (
      !plain(file) ||
      !LEGACY_PATH.test(file.path) ||
      !HASH.test(file.hash) ||
      paths.has(file.path)
    )
      unsafe();
    paths.add(file.path);
  }
  return manifest;
}

async function inspectContents(archivePath, manifest, fsAdapter) {
  if (
    !(await inspectPath(archivePath, fsAdapter, {
      optional: true,
      directory: true,
    }))
  )
    return false;
  const files = new Set(manifest?.files.map((file) => file.path) || []);
  for (const name of await fsAdapter.readdir(archivePath)) {
    if (name === "runs") {
      const runs = path.join(archivePath, "runs");
      await inspectPath(runs, fsAdapter, { directory: true });
      for (const run of await fsAdapter.readdir(runs)) {
        if (!files.has("runs/" + run)) unsafe();
        await inspectPath(path.join(runs, run), fsAdapter);
      }
    } else {
      if (!(name === "manifest.json" && manifest) && !files.has(name)) unsafe();
      await inspectPath(path.join(archivePath, name), fsAdapter);
    }
  }
  return true;
}

function validateCleanArchive(archive, directoryHash, manifest) {
  validateBackupArchive(archive);
  const m = archive.manifest,
    snapshots = archive.runSnapshots || {};
  if (
    archive.workspace.schemaVersion !== 3 ||
    m.schemaVersion !== 3 ||
    !HASH.test(m.legacyInputHash) ||
    !m.legacyInputHash.startsWith(directoryHash) ||
    !HASH.test(m.legacyManifestHash) ||
    !Number.isFinite(Date.parse(m.createdAt)) ||
    (manifest &&
      (m.legacyInputHash !== manifest.inputHash ||
        m.legacyManifestHash !== contentHash(manifest)))
  )
    unsafe();
  if (
    !plain(snapshots) ||
    !plain(m.snapshots) ||
    Object.keys(snapshots).length !== Object.keys(m.snapshots).length
  )
    unsafe();
  for (const [id, snapshot] of Object.entries(snapshots)) {
    const run = archive.workspace.runs[id];
    if (
      !run ||
      !UUID_RE.test(snapshot.recordId) ||
      snapshot.ownerPackageId !== run.ownerPackageId ||
      (snapshot.run?.ownerPackageId &&
        snapshot.run.ownerPackageId !== run.ownerPackageId) ||
      m.snapshots[id] !== contentHash(snapshot)
    )
      unsafe();
  }
  return archive;
}

function validateLegacyInput(input) {
  const raw = JSON.parse(input.body);
  const jobs =
    input.path === "job-index.json"
      ? raw.version === 1 && plain(raw.jobs)
        ? Object.values(raw.jobs)
        : null
      : Array.isArray(raw.jobs || raw.results)
        ? raw.jobs || raw.results
        : null;
  if (!jobs) unsafe();
  for (const job of jobs) {
    if (
      !plain(job) ||
      typeof job.title !== "string" ||
      !job.title.trim() ||
      typeof job.url !== "string"
    )
      unsafe();
    const url = new URL(job.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      unsafe();
  }
}

async function convertLegacy(inputs, archivePath, now) {
  let workspace = createEmptyWorkspace({ schemaVersion: 2 });
  const snapshots = {};
  const repository = {
    clock: { now: () => now },
    read: async () => structuredClone(workspace),
    async writeRunSnapshot(id, snapshot) {
      if (snapshots[id] && contentHash(snapshots[id]) !== contentHash(snapshot))
        unsafe();
      snapshots[id] = structuredClone(snapshot);
      return { path: "runs-v2/" + id + ".json", hash: contentHash(snapshot) };
    },
    async mutateWorkspace(action) {
      const draft = structuredClone(workspace);
      await action(draft);
      draft.revision = workspace.revision + 1;
      workspace = draft;
    },
  };
  const result = await migrateV1({
    dataDir: archivePath,
    repository,
    memoryOnly: { inputs },
  });
  if (result.status !== "migrated" || result.skipped.length) unsafe();
  return { workspace, snapshots, inputHash: result.inputHash };
}

/** The caller holds maintenance exclusivity. No lock or unfiltered disk copy is created here. */
export async function sanitizeLegacyBackup({
  archivePath,
  control,
  now = Date.now(),
  currentWorkspace,
  fsAdapter = fs,
  commitControl,
  filterBackup,
}) {
  let phase = "legacy_verify";
  try {
    assertControl(control);
    if (
      typeof commitControl !== "function" ||
      typeof filterBackup !== "function" ||
      !Number.isFinite(now)
    )
      unsafe();
    archivePath = path.resolve(archivePath);
    const match = /^v1-([a-f0-9]{16}|[a-f0-9]{64})$/.exec(
      path.basename(archivePath),
    );
    const backupsRoot = path.dirname(archivePath);
    if (!match || path.basename(backupsRoot) !== "backups") unsafe();
    const directoryHash = match[1];
    await inspectPath(backupsRoot, fsAdapter, { directory: true });
    const directoryExists = !!(await inspectPath(archivePath, fsAdapter, {
      optional: true,
      directory: true,
    }));
    const manifestPath = path.join(archivePath, "manifest.json");
    const manifestBody = directoryExists
      ? await readManaged(manifestPath, fsAdapter, { optional: true })
      : null;
    const manifest =
      manifestBody === null
        ? null
        : validateManifest(JSON.parse(manifestBody), directoryHash);
    const backupId =
      "workspace-v1-" + (manifest?.inputHash || directoryHash) + ".json";
    let cleanPath = path.join(backupsRoot, backupId),
      existing = null;
    // Once the manifest has gone, find the one full-hash successor. The raw
    // directory's 16-character suffix is never enough to accept two successors.
    if (!manifest && directoryHash.length === 16) {
      const successors = (await fsAdapter.readdir(backupsRoot)).filter(
        (name) =>
          /^workspace-v1-[a-f0-9]{64}\.json$/.test(name) &&
          name.startsWith("workspace-v1-" + directoryHash),
      );
      if (successors.length !== 1) unsafe();
      cleanPath = path.join(backupsRoot, successors[0]);
    }
    const cleanBody = await readManaged(cleanPath, fsAdapter, {
      optional: true,
    });
    if (cleanBody !== null)
      existing = validateCleanArchive(
        JSON.parse(cleanBody),
        directoryHash,
        manifest,
      );
    if (
      existing &&
      path.basename(cleanPath) !==
        "workspace-v1-" + existing.manifest.legacyInputHash + ".json"
    )
      unsafe();
    if (!manifest && !existing) unsafe();
    await inspectContents(archivePath, manifest, fsAdapter);
    const inputs = [],
      missing = [];
    for (const file of manifest?.files || []) {
      const body = await readManaged(
        path.join(archivePath, file.path),
        fsAdapter,
        { optional: true },
      );
      if (body === null) {
        missing.push(file.path);
        continue;
      }
      if (contentHash(body) !== file.hash) unsafe();
      validateLegacyInput({ path: file.path, body });
      inputs.push({ path: file.path, body });
    }
    if (
      manifest &&
      !missing.length &&
      contentHash(inputs) !== manifest.inputHash
    )
      unsafe();
    if (missing.length && !existing) unsafe();
    const source = existing
      ? {
          workspace: existing.workspace,
          snapshots: existing.runSnapshots || {},
        }
      : await convertLegacy(inputs, archivePath, now);
    if (!existing && source.inputHash !== manifest.inputHash) unsafe();
    phase = "legacy_filter";
    const filtered = await filterBackup({
      workspace: structuredClone(source.workspace),
      snapshots: structuredClone(source.snapshots),
      control: structuredClone(control),
      now,
      currentWorkspace,
    });
    if (
      !plain(filtered) ||
      filtered.workspace?.schemaVersion !== 3 ||
      !plain(filtered.snapshots || {})
    )
      unsafe();
    const nextControl = filtered.control || control;
    assertControlTransition(control, nextControl);
    const workspace = redactBusiness(filtered.workspace),
      runSnapshots = redactBusiness(filtered.snapshots || {});
    const archive = {
      manifest: {
        version: 1,
        schemaVersion: 3,
        createdAt: existing?.manifest.createdAt || new Date(now).toISOString(),
        workspaceHash: contentHash(workspace),
        snapshots: Object.fromEntries(
          Object.entries(runSnapshots).map(([id, value]) => [
            id,
            contentHash(value),
          ]),
        ),
        legacyInputHash:
          manifest?.inputHash || existing.manifest.legacyInputHash,
        legacyManifestHash: manifest
          ? contentHash(manifest)
          : existing.manifest.legacyManifestHash,
      },
      workspace,
      runSnapshots,
    };
    validateCleanArchive(archive, directoryHash, manifest);
    phase = "legacy_control_commit";
    await commitControl(nextControl);
    phase = "legacy_archive_write";
    await inspectPath(backupsRoot, fsAdapter, { directory: true });
    await inspectPath(cleanPath, fsAdapter, { optional: true });
    await writeAtomicJson(cleanPath, archive, { fsAdapter });
    const written = validateCleanArchive(
      JSON.parse(await readManaged(cleanPath, fsAdapter)),
      directoryHash,
      manifest,
    );
    if (contentHash(written) !== contentHash(archive)) unsafe();
    phase = "legacy_raw_cleanup";
    await inspectContents(archivePath, manifest, fsAdapter);
    for (const file of manifest?.files || []) {
      const filename = path.join(archivePath, file.path);
      const body = await readManaged(filename, fsAdapter, { optional: true });
      if (body === null) continue;
      if (contentHash(body) !== file.hash) unsafe();
      await fsAdapter.unlink(filename);
    }
    if (
      await inspectPath(archivePath, fsAdapter, {
        optional: true,
        directory: true,
      })
    ) {
      const runs = path.join(archivePath, "runs");
      if (
        await inspectPath(runs, fsAdapter, { optional: true, directory: true })
      )
        await fsAdapter.rmdir(runs);
      if (manifest) {
        const latest = await readManaged(manifestPath, fsAdapter, {
          optional: true,
        });
        if (latest !== null) {
          if (contentHash(JSON.parse(latest)) !== contentHash(manifest))
            unsafe();
          await fsAdapter.unlink(manifestPath);
        }
      }
      await fsAdapter.rmdir(archivePath);
    }
    if (
      await inspectPath(archivePath, fsAdapter, {
        optional: true,
        directory: true,
      })
    )
      unsafe();
    validateCleanArchive(
      JSON.parse(await readManaged(cleanPath, fsAdapter)),
      directoryHash,
      manifest,
    );
    return { completed: true, backupId: path.basename(cleanPath) };
  } catch {
    const error = packageError(
      "purge_file_failed",
      "旧版管理备份尚未完成安全净化，请查看诊断并重试。",
      503,
    );
    error.failurePhase = phase;
    throw error;
  }
}
