import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTempDir } from "../helpers/fixtures.mjs";
import { createEmptyWorkspace } from "../../src/domain/contracts.mjs";
import { contentHash } from "../../src/infrastructure/storage/repository.mjs";
import { createEmptyControl } from "../../src/infrastructure/storage/package-control.mjs";
import { normalizeBackupOwnership } from "../../src/infrastructure/storage/package-migration.mjs";
import { migrateV1 } from "../../src/infrastructure/storage/migrate-v1.mjs";
import { validateBackupArchive } from "../../src/infrastructure/storage/backup.mjs";

const NOW = Date.parse("2026-10-09T00:00:00Z");
const SENTINEL = "SYNTHETIC_BODY_MUST_BE_REMOVED";
async function sanitize() {
  const module = await import(
    "../../src/infrastructure/storage/legacy-backup-sanitize.mjs"
  ).catch((error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  });
  assert.equal(
    typeof module?.sanitizeLegacyBackup,
    "function",
    "managed V1 sanitation API is missing",
  );
  return module.sanitizeLegacyBackup;
}

function memoryRepository() {
  let workspace = createEmptyWorkspace({ schemaVersion: 2 });
  const snapshots = {};
  return {
    clock: { now: () => NOW },
    read: async () => structuredClone(workspace),
    writeRunSnapshot: async (id, snapshot) => {
      snapshots[id] = structuredClone(snapshot);
      return { path: "runs-v2/" + id + ".json", hash: contentHash(snapshot) };
    },
    mutateWorkspace: async (action) => {
      await action(workspace);
      workspace.revision++;
    },
    snapshots,
  };
}

async function fixture(t, { deleted = false, badRun = false } = {}) {
  const dir = await createTempDir(t),
    backups = path.join(dir, "backups");
  await fs.mkdir(backups);
  const job = {
    id: "legacy-a",
    source: "synthetic",
    title: "合成消防岗位",
    url: "https://jobs.example.com/a",
    description: SENTINEL,
    note: "合成投递备注",
    status: "applied",
  };
  const inputs = [
    {
      path: "job-index.json",
      body: JSON.stringify({ version: 1, jobs: { "legacy-a": job } }),
    },
    {
      path: "runs/legacy-run.json",
      body: badRun
        ? "{bad"
        : JSON.stringify({ runId: "legacy-run", jobs: [job] }),
    },
  ];
  const hash = contentHash(inputs),
    archivePath = path.join(backups, "v1-" + hash.slice(0, 16));
  await fs.mkdir(path.join(archivePath, "runs"), { recursive: true });
  for (const input of inputs)
    await fs.writeFile(path.join(archivePath, input.path), input.body);
  const manifest = {
    version: 1,
    inputHash: hash,
    files: inputs.map((input) => ({
      path: input.path,
      hash: contentHash(input.body),
    })),
  };
  await fs.writeFile(
    path.join(archivePath, "manifest.json"),
    JSON.stringify(manifest),
  );
  let control = createEmptyControl();
  if (deleted) {
    const owner = randomUUID();
    control.identityIndex.package[
      "legacy:" + contentHash(["legacy_unassigned", control.workspaceId])
    ] = owner;
    control.deletionLedger[owner] = { phase: "purged", recordIds: [] };
  }
  const f = {
    dir,
    backups,
    inputs,
    manifest,
    archivePath,
    now: NOW,
    currentWorkspace: createEmptyWorkspace({ schemaVersion: 3 }),
    commits: 0,
    filters: 0,
  };
  Object.defineProperty(f, "control", { get: () => control });
  f.commitControl = async (next) => {
    control = structuredClone(next);
    f.commits++;
  };
  f.filterBackup = (input) => {
    f.filters++;
    return normalizeBackupOwnership(input);
  };
  f.run = async (overrides = {}) => {
    try {
      return await (
        await sanitize()
      )({
        archivePath,
        control,
        now: NOW,
        currentWorkspace: f.currentWorkspace,
        commitControl: f.commitControl,
        filterBackup: f.filterBackup,
        ...overrides,
      });
    } catch (error) {
      error.message += " (" + (error.failurePhase || "test_setup") + ")";
      throw error;
    }
  };
  f.cleanPath = path.join(backups, "workspace-v1-" + hash + ".json");
  f.readClean = async () =>
    validateBackupArchive(JSON.parse(await fs.readFile(f.cleanPath, "utf8")));
  return f;
}

test("memory-only migration converts validated input strings without creating raw backup copies", async (t) => {
  const dir = await createTempDir(t),
    repository = memoryRepository();
  const inputs = [
    {
      path: "runs/r1.json",
      body: JSON.stringify({
        runId: "r1",
        jobs: [{ title: "合成岗位", url: "https://jobs.example.com/1" }],
      }),
    },
  ];
  const result = await migrateV1({
    dataDir: path.join(dir, "not-created"),
    repository,
    memoryOnly: { inputs },
  });
  assert.equal(result.status, "migrated");
  assert.equal(result.backupPath, null);
  assert.equal(result.manifestPath, null);
  assert.equal(Object.keys((await repository.read()).jobs).length, 1);
  assert.equal(Object.keys(repository.snapshots).length, 1);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("legacy sanitation commits durable identity before writing only filtered standard archive", async (t) => {
  const f = await fixture(t, { deleted: true });
  const fsAdapter = {
    ...fs,
    async open(file, ...args) {
      assert.ok(f.commits > 0, "body persisted before control");
      return fs.open(file, ...args);
    },
  };
  const result = await f.run({ fsAdapter });
  assert.deepEqual(result, {
    completed: true,
    backupId: path.basename(f.cleanPath),
  });
  const archive = await f.readClean();
  assert.equal(archive.workspace.schemaVersion, 3);
  assert.equal(Object.keys(archive.workspace.jobs).length, 0);
  assert.deepEqual(archive.runSnapshots, {});
  assert.equal(JSON.stringify(archive).includes(SENTINEL), false);
  assert.equal(archive.manifest.legacyInputHash, f.manifest.inputHash);
  assert.equal(archive.manifest.legacyManifestHash, contentHash(f.manifest));
  assert.deepEqual(await fs.readdir(f.backups), [path.basename(f.cleanPath)]);
});

test("legacy sanitation retains undeleted records and embedded run history", async (t) => {
  const f = await fixture(t);
  await f.run();
  const archive = await f.readClean();
  assert.ok(Object.values(archive.workspace.jobs).length > 0);
  assert.ok(
    Object.values(archive.workspace.jobs).every(
      (job) => job.canonical.description === SENTINEL,
    ),
  );
  assert.equal(
    Object.values(archive.workspace.applications)[0].note,
    "合成投递备注",
  );
  assert.equal(Object.keys(archive.runSnapshots).length, 1);
  assert.ok(JSON.stringify(archive).includes(SENTINEL));
});

test("corrupt original hash is rejected before normalization or persistence", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.archivePath, f.inputs[0].path), " ");
  await assert.rejects(f.run(), (error) => error.code === "purge_file_failed");
  assert.equal(f.filters, 0);
  assert.equal(f.commits, 0);
  assert.deepEqual(await fs.readdir(f.backups), [path.basename(f.archivePath)]);
});

test("hash-valid corrupt legacy run remains pending rather than being silently skipped", async (t) => {
  const f = await fixture(t, { badRun: true });
  await assert.rejects(f.run(), (error) => error.code === "purge_file_failed");
  assert.equal(f.commits, 0);
  assert.equal(
    await fs.readFile(path.join(f.archivePath, "runs/legacy-run.json"), "utf8"),
    "{bad",
  );
});

test("manifest path traversal and unregistered files are rejected without touching originals", async (t) => {
  const f = await fixture(t);
  const unsafe = {
    ...f.manifest,
    files: [{ path: "../outside.json", hash: contentHash("{}") }],
  };
  await fs.writeFile(
    path.join(f.archivePath, "manifest.json"),
    JSON.stringify(unsafe),
  );
  await assert.rejects(f.run(), (error) => error.code === "purge_file_failed");
  await fs.writeFile(
    path.join(f.archivePath, "manifest.json"),
    JSON.stringify(f.manifest),
  );
  await fs.writeFile(path.join(f.archivePath, "unknown.json"), SENTINEL);
  await assert.rejects(f.run(), (error) => error.code === "purge_file_failed");
  assert.equal(f.commits, 0);
  assert.equal(
    await fs.readFile(path.join(f.archivePath, "unknown.json"), "utf8"),
    SENTINEL,
  );
});

test("legacy input directory junction is rejected before reading or writing body", async (t) => {
  const f = await fixture(t),
    outside = path.join(f.dir, "outside");
  await fs.rename(path.join(f.archivePath, "runs"), outside);
  await fs.symlink(
    outside,
    path.join(f.archivePath, "runs"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(f.run(), (error) => error.code === "purge_file_failed");
  assert.equal(f.filters, 0);
  assert.equal(f.commits, 0);
  assert.equal(
    await fs.readFile(path.join(outside, "legacy-run.json"), "utf8"),
    f.inputs[1].body,
  );
});

test("control commit failure leaves every raw input and no clean archive", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      commitControl: async () => {
        throw Error("synthetic control failure");
      },
    }),
    (error) => error.code === "purge_file_failed",
  );
  for (const input of f.inputs)
    assert.equal(
      await fs.readFile(path.join(f.archivePath, input.path), "utf8"),
      input.body,
    );
  assert.deepEqual(await fs.readdir(f.backups), [path.basename(f.archivePath)]);
});

test("clean archive replace failure can restart with persisted identities and no raw temporary copy", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      fsAdapter: {
        ...fs,
        rename: async () => {
          throw Error("synthetic replace failure");
        },
      },
    }),
  );
  const identities = structuredClone(f.control.identityIndex);
  assert.equal(f.commits, 1);
  assert.deepEqual(await fs.readdir(f.backups), [path.basename(f.archivePath)]);
  await f.run();
  assert.deepEqual(f.control.identityIndex, identities);
  await f.readClean();
});

test("partial raw unlink restarts from validated clean archive and removes manifest last", async (t) => {
  const f = await fixture(t, { deleted: true });
  let removed = 0;
  const fsAdapter = {
    ...fs,
    async unlink(file) {
      if (!String(file).endsWith(".tmp") && ++removed === 2)
        throw Error("synthetic raw unlink failure");
      return fs.unlink(file);
    },
  };
  await assert.rejects(f.run({ fsAdapter }));
  await assert.rejects(fs.access(path.join(f.archivePath, "job-index.json")), {
    code: "ENOENT",
  });
  await fs.access(path.join(f.archivePath, "manifest.json"));
  await f.readClean();
  const identities = structuredClone(f.control.identityIndex);
  await f.run();
  assert.deepEqual(f.control.identityIndex, identities);
  assert.deepEqual(await fs.readdir(f.backups), [path.basename(f.cleanPath)]);
  assert.equal((await f.run()).completed, true);
});

test("manifest unlink interruption keeps restart proof after all raw inputs disappear", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      fsAdapter: {
        ...fs,
        async unlink(file) {
          if (path.basename(file) === "manifest.json")
            throw Error("synthetic manifest failure");
          return fs.unlink(file);
        },
      },
    }),
  );
  await fs.access(path.join(f.archivePath, "manifest.json"));
  const result = await f.run();
  assert.equal(result.completed, true);
  assert.deepEqual(await fs.readdir(f.backups), [path.basename(f.cleanPath)]);
});

test("missing raw input cannot be excused by a damaged replacement archive", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.archivePath, f.inputs[0].path));
  await fs.writeFile(
    f.cleanPath,
    JSON.stringify({
      manifest: { version: 1, legacyInputHash: f.manifest.inputHash },
      workspace: {},
    }),
  );
  await assert.rejects(f.run(), (error) => error.code === "purge_file_failed");
  await fs.access(path.join(f.archivePath, f.inputs[1].path));
  await fs.access(path.join(f.archivePath, "manifest.json"));
  assert.equal(f.commits, 0);
});

test("unknown ownership is rejected before writing or cleaning original bodies", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      filterBackup: () => {
        throw Error("unproven synthetic ownership");
      },
    }),
    (error) =>
      error.code === "purge_file_failed" &&
      error.failurePhase === "legacy_filter",
  );
  assert.equal(f.commits, 0);
  assert.deepEqual(await fs.readdir(f.backups), [path.basename(f.archivePath)]);
});

test("conflicting legacy run identities cannot silently overwrite their in-memory snapshots", async (t) => {
  const f = await fixture(t);
  const extra = {
    path: "runs/other.json",
    body: JSON.stringify({
      runId: "legacy-run",
      jobs: [
        { title: "另一个合成岗位", url: "https://jobs.example.com/other" },
      ],
    }),
  };
  f.inputs.push(extra);
  const hash = contentHash(f.inputs),
    nextPath = path.join(f.backups, "v1-" + hash.slice(0, 16));
  await fs.rename(f.archivePath, nextPath);
  await fs.writeFile(path.join(nextPath, extra.path), extra.body);
  await fs.writeFile(
    path.join(nextPath, "manifest.json"),
    JSON.stringify({
      version: 1,
      inputHash: hash,
      files: f.inputs.map((i) => ({ path: i.path, hash: contentHash(i.body) })),
    }),
  );
  await assert.rejects(
    f.run({ archivePath: nextPath }),
    (error) => error.code === "purge_file_failed",
  );
  assert.equal(f.commits, 0);
  await fs.access(path.join(nextPath, extra.path));
});

test("cleanup restarts after the manifest disappeared but its empty directory remains", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      fsAdapter: {
        ...fs,
        async rmdir(filename) {
          if (filename === f.archivePath)
            throw Error("synthetic final rmdir failure");
          return fs.rmdir(filename);
        },
      },
    }),
    (error) => error.code === "purge_file_failed",
  );
  assert.deepEqual(await fs.readdir(f.archivePath), []);
  const result = await f.run();
  assert.equal(result.completed, true);
  await f.readClean();
});

test("a manifest-less restart requires successor filename and full input hash to agree", async (t) => {
  const f = await fixture(t);
  await f.run();
  const archive = await f.readClean();
  archive.manifest.legacyInputHash =
    f.manifest.inputHash.slice(0, 16) + "f".repeat(48);
  await fs.writeFile(f.cleanPath, JSON.stringify(archive));
  await assert.rejects(f.run(), (error) => error.code === "purge_file_failed");
});
