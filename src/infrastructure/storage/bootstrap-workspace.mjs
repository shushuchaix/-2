import fs from "node:fs/promises";
import path from "node:path";
import { migrateV1 } from "./migrate-v1.mjs";
import { normalizeBackupOwnership } from "./package-migration.mjs";
import { contentHash } from "./repository.mjs";
import { writeAtomicJson } from "./atomic.mjs";
import { redactBusiness } from "../../domain/redact.mjs";
import { packageError } from "../../domain/packages.mjs";

/** This entry is called before ordinary business services are exposed. Legacy readers remain internal to bootstrap. */
export async function bootstrapWorkspace({
  repository,
  clock = repository.clock,
  fsAdapter = fs,
}) {
  const fs = fsAdapter;
  async function consume(tx) {
    const journal = tx.control?.migrationJournal.bootstrap;
    if (!journal || journal.phase === "complete") return;
    for (const relative of journal.legacyFiles) {
      if (
        !/^(?:job-index\.json|(?:runs|runs-v2)\/[A-Za-z0-9_-]{1,160}\.json)$/.test(
          relative,
        )
      )
        throw packageError(
          "migration_identity_conflict",
          "旧数据文件路径不安全。",
        );
      const filename = path.join(repository.dataDir, relative);
      try {
        if (
          (await fs.lstat(path.dirname(filename))).isSymbolicLink() ||
          (await fs.lstat(filename)).isSymbolicLink()
        )
          throw packageError(
            "migration_identity_conflict",
            "旧数据文件包含符号链接。",
          );
        await fs.unlink(filename);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    const completed = structuredClone(tx.control);
    completed.migrationJournal.bootstrap.phase = "complete";
    await tx.commitControl(completed);
  }
  const initial = await repository.read();
  if (initial.schemaVersion !== 3)
    await migrateV1({ repository, dataDir: repository.dataDir });
  return repository.withMaintenanceTransaction(
    async (tx) => {
      if (tx.workspace.schemaVersion === 3) {
        await consume(tx);
        return {
          ...normalizeBackupOwnership({
            workspace: tx.workspace,
            control: tx.control,
            now: clock.now(),
          }).report,
          changed: false,
        };
      }
      const legacy = structuredClone(tx.workspace),
        snapshots = {},
        missing = [];
      for (const run of Object.values(legacy.runs))
        if (run.snapshotRef) {
          try {
            snapshots[run.runId] = await tx.readSnapshot(run.runId);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            missing.push(run.runId);
          }
        }
      const normalized = normalizeBackupOwnership({
        workspace: legacy,
        snapshots,
        control: tx.control,
        now: clock.now(),
      });
      // Create a verifiable managed archive before activating the new workspace.
      // A missing file is recorded as missing rather than fabricating its former contents.
      const backupWorkspace = redactBusiness(legacy),
        runSnapshots = redactBusiness(snapshots);
      if (backupWorkspace.operationLeases) backupWorkspace.operationLeases = {};
      for (const id of missing) {
        backupWorkspace.runs[id].snapshotRef = null;
        backupWorkspace.recoveryRecords.push({
          type: "missing_legacy_snapshot",
          runId: id,
        });
      }
      const backupId =
        "workspace-migration-" +
        contentHash(backupWorkspace).slice(0, 32) +
        ".json";
      if (
        Object.values(legacy.profiles).flat().length ||
        Object.values(legacy.targets).flat().length ||
        Object.keys(legacy.jobs).length ||
        Object.keys(legacy.runs).length
      ) {
        const archive = {
          manifest: {
            version: 1,
            schemaVersion: 2,
            createdAt: new Date(clock.now()).toISOString(),
            workspaceHash: contentHash(backupWorkspace),
            snapshots: Object.fromEntries(
              Object.entries(runSnapshots).map(([id, s]) => [
                id,
                contentHash(s),
              ]),
            ),
          },
          workspace: backupWorkspace,
          runSnapshots,
        };
        const filename = path.join(repository.dataDir, "backups", backupId);
        try {
          const old = JSON.parse(await fs.readFile(filename, "utf8"));
          if (old.manifest.workspaceHash !== archive.manifest.workspaceHash)
            throw packageError(
              "migration_identity_conflict",
              "迁移备份与原始数据不一致。",
            );
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          await writeAtomicJson(filename, archive, { fsAdapter });
        }
      }
      const legacyFiles = [];
      if (legacy.migration?.inputHash) legacyFiles.push("job-index.json");
      for (const run of Object.values(legacy.runs)) {
        if (run.legacy) legacyFiles.push("runs/" + run.runId + ".json");
        if (run.snapshotRef) legacyFiles.push("runs-v2/" + run.runId + ".json");
      }
      normalized.control.migrationJournal.bootstrap = {
        phase: "prepared",
        backupId,
        legacyFiles,
        preparedAt:
          normalized.control.migrationJournal.bootstrap?.preparedAt ||
          new Date(clock.now()).toISOString(),
      };
      await tx.commitControl(normalized.control);
      for (const [id, snapshot] of Object.entries(normalized.snapshots))
        await tx.writeSnapshot(id, snapshot);
      await tx.commitWorkspace(normalized.workspace);
      // Consumption happens only after the complete schema3 main state is durable.
      await consume(tx);
      return {
        ...normalized.report,
        changed: true,
        backupId,
        warnings: [
          ...new Set([
            ...normalized.report.warnings,
            ...missing.map(() => "missing_legacy_snapshot"),
          ]),
        ],
      };
    },
    { bootstrap: true },
  );
}
