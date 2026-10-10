import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { openPackageControl, applyDeletionLedger } from "./package-control.mjs";
import {
  requirePackage,
  assertOwned,
  packageError,
  UUID_RE,
} from "../../domain/packages.mjs";
import {
  assertWorkspace,
  createEmptyWorkspace,
} from "../../domain/contracts.mjs";
import { writeAtomicJson } from "./atomic.mjs";
import { withWorkspaceLock } from "./lock.mjs";
import { recordDiagnostic } from "../diagnostics/log.mjs";
import { assertOperationWriteAllowed } from "../../application/workspace-operations.mjs";
export const contentHash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export async function openWorkspaceRepository({
  dataDir,
  fsAdapter = fs,
  clock = { now: () => Date.now() },
  diagnostics,
  allowLegacy = false,
}) {
  if (!dataDir) throw Error("Missing data directory");
  dataDir = path.resolve(dataDir);
  await fsAdapter.mkdir(dataDir, { recursive: true });
  const filename = path.join(dataDir, "workspace.v2.json");
  const controlStore = openPackageControl({ dataDir, fsAdapter });
  let legacyAllowed = true;
  const heldLock = new AsyncLocalStorage();
  const inLock = (action) =>
    heldLock.getStore()
      ? action()
      : withWorkspaceLock(dataDir, () => heldLock.run(true, action));
  const write = (file, value) =>
    writeAtomicJson(file, value, {
      fsAdapter,
      onRenameRecovery: diagnostics
        ? (event) =>
            recordDiagnostic(diagnostics, {
              operation: "storage.recovered",
              resource: path.basename(file),
              ...event,
            })
        : undefined,
    });
  const readStored = async () => {
    let raw;
    try {
      raw = await fsAdapter.readFile(filename, "utf8");
    } catch (e) {
      if (e.code === "ENOENT")
        return createEmptyWorkspace({ schemaVersion: 2 });
      throw e;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (e) {
      throw Error("Corrupt workspace JSON: " + e.message);
    }
    if (!legacyAllowed && value.schemaVersion !== 3)
      throw packageError(
        "workspace_upgrade_required",
        "旧格式仅可通过启动升级读取。",
        503,
      );
    return assertWorkspace(value);
  };
  const readInLock = async () => {
    const value = await readStored();
    const control = await controlStore.read({
      allowUninitialized: value.schemaVersion !== 3,
    });
    return assertWorkspace(applyDeletionLedger(value, control));
  };
  const read = () => inLock(readInLock);
  await read();
  let queue = Promise.resolve();
  async function makeTransaction(options = {}) {
    const stored = await readStored();
    const initialControl = await controlStore.read({
      allowUninitialized: stored.schemaVersion !== 3 || options.bootstrap,
    });
    if (stored.schemaVersion === 3 && !initialControl)
      throw packageError("control_state_invalid", "控制状态缺失。", 503);
    if (!options.bootstrap) assertOperationWriteAllowed(stored, options);
    let committedControl = structuredClone(initialControl);
    const tx = {
      workspace: applyDeletionLedger(stored, initialControl),
      control: structuredClone(initialControl),
      async commitControl(next) {
        await controlStore.commitInLock(next, { previous: committedControl });
        committedControl = structuredClone(next);
        tx.control = structuredClone(next);
      },
      async commitWorkspace(next) {
        if (next.schemaVersion === 3 && !committedControl)
          throw packageError(
            "control_state_invalid",
            "请先准备持久控制状态。",
            503,
          );
        const draft = applyDeletionLedger(next, committedControl);
        draft.revision = tx.workspace.revision + 1;
        assertWorkspace(draft);
        if (
          tx.workspace.revision > 0 &&
          !(tx.workspace.schemaVersion === 2 && draft.schemaVersion === 3)
        )
          await write(
            path.join(dataDir, "workspace.v2.previous.json"),
            applyDeletionLedger(tx.workspace, committedControl),
          );
        await write(filename, draft);
        tx.workspace = structuredClone(draft);
        return draft.revision;
      },
      async readSnapshot(id) {
        return JSON.parse(await fsAdapter.readFile(runPath(id), "utf8"));
      },
      async writeSnapshot(id, snapshot) {
        if (!options.bootstrap && tx.workspace.schemaVersion === 3)
          assertSnapshotOwner(tx.workspace, id, snapshot);
        const p = runPath(id);
        try {
          const old = JSON.parse(await fsAdapter.readFile(p, "utf8"));
          if (contentHash(old) !== contentHash(snapshot))
            throw Error("Run snapshot immutable");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          await write(p, snapshot);
        }
        return {
          path: path.relative(dataDir, p).split(path.sep).join("/"),
          hash: contentHash(snapshot),
        };
      },
      async replaceSnapshot(id, snapshot) {
        const run = tx.workspace.runs[id],
          file = Object.values(tx.workspace.files || {}).find(
            (f) => f.runId === id && f.kind === "run_snapshot",
          );
        if (
          !run ||
          !file ||
          file.snapshotRecordId !== snapshot.recordId ||
          !UUID_RE.test(snapshot.recordId)
        )
          throw packageError(
            "snapshot_identity_conflict",
            "快照稳定身份不一致。",
          );
        const intent = tx.control?.ownershipTransfers?.[snapshot.recordId],
          exclusive =
            options.operationLease &&
            tx.workspace.operationLeases?.[options.operationLease.operationId];
        const transferring =
          intent?.phase === "prepared" &&
          intent.to === snapshot.ownerPackageId &&
          [intent.from, intent.to].includes(run.ownerPackageId);
        if (
          !transferring &&
          !(
            exclusive &&
            exclusive.token === options.operationLease.token &&
            ["restore", "upgrade"].includes(exclusive.kind)
          )
        )
          throw packageError(
            "snapshot_replace_forbidden",
            "快照替换需要持久转移意图或恢复授权。",
          );
        const p = runPath(id),
          relative = path.relative(dataDir, p).split(path.sep).join("/");
        if (file.path !== relative)
          throw packageError(
            "snapshot_identity_conflict",
            "受管理快照路径不一致。",
          );
        for (const current of [dataDir, path.dirname(p), p]) {
          try {
            if ((await fsAdapter.lstat(current)).isSymbolicLink())
              throw packageError(
                "snapshot_identity_conflict",
                "受管理快照路径包含符号链接。",
              );
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }
        const expectedOwner = transferring ? intent.to : run.ownerPackageId;
        if (
          snapshot.ownerPackageId !== expectedOwner ||
          (snapshot.run?.ownerPackageId &&
            snapshot.run.ownerPackageId !== expectedOwner)
        )
          throw packageError("snapshot_identity_conflict", "快照归属不一致。");
        let old;
        try {
          old = JSON.parse(await fsAdapter.readFile(p, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT" || transferring) throw error;
          if (file.hash !== contentHash(snapshot))
            throw packageError(
              "snapshot_identity_conflict",
              "恢复快照哈希不一致。",
            );
          await write(p, snapshot);
          return { path: relative, hash: contentHash(snapshot) };
        }
        if (old.recordId !== snapshot.recordId)
          throw packageError(
            "snapshot_identity_conflict",
            "现有快照身份不一致。",
          );
        const journal =
          tx.control?.migrationJournal?.ownershipTransferSnapshots?.[
            intent?.operationId
          ]?.[snapshot.recordId];
        if (
          transferring &&
          (!journal ||
            contentHash(snapshot) !== journal.toHash ||
            ![journal.fromHash, journal.toHash].includes(contentHash(old)))
        )
          throw packageError(
            "snapshot_identity_conflict",
            "快照哈希与转移准备记录不一致。",
          );
        if (contentHash(old) !== contentHash(snapshot))
          await write(p, snapshot);
        return { path: relative, hash: contentHash(snapshot) };
      },
      async removeManagedFile(fileId) {
        const file =
          tx.workspace.files?.[fileId] ||
          Object.values(tx.control?.purgeTasks || {})
            .flatMap((task) => task.files || [])
            .find((f) => f.recordId === fileId);
        if (
          !file ||
          typeof file.path !== "string" ||
          !/^(?:runs-v2|runs|backups)\/[A-Za-z0-9_.-]+\.json$/.test(file.path)
        )
          throw packageError("purge_file_failed", "受管理文件身份无效。", 503);
        let current = dataDir;
        for (const part of file.path.split("/")) {
          current = path.join(current, part);
          try {
            if ((await fsAdapter.lstat(current)).isSymbolicLink())
              throw packageError(
                "purge_file_failed",
                "受管理文件路径包含符号链接。",
                503,
              );
          } catch (e) {
            if (e.code === "ENOENT") return;
            throw e;
          }
        }
        await fsAdapter.unlink(current);
      },
    };
    return tx;
  }
  const withMaintenanceTransaction = (action, options = {}) => {
    if (heldLock.getStore())
      throw Error("Nested maintenance transaction: use the held transaction");
    const pending = queue.then(() =>
      inLock(async () => action(await makeTransaction(options))),
    );
    queue = pending.catch(() => {});
    return pending;
  };
  function assertSnapshotOwner(w, id, snapshot) {
    const run = w.runs[id];
    if (!run) throw packageError("package_not_found", "检索记录不存在。", 404);
    requirePackage(w, run.ownerPackageId, { now: clock.now() });
    assertOwned(w, snapshot, run.ownerPackageId);
    if (!UUID_RE.test(snapshot.recordId))
      throw packageError("package_scope_mismatch", "快照缺少稳定记录身份。");
    if (
      snapshot.run?.ownerPackageId &&
      snapshot.run.ownerPackageId !== run.ownerPackageId
    )
      throw packageError("package_scope_mismatch", "快照归属不一致。");
  }
  const mutateWorkspace = (fn, options = {}) => {
    let phase = "lock",
      started,
      revision;
    const operation = queue
      .then(() => {
        started = clock.now();
        return inLock(async () => {
          phase = "read";
          const tx = await makeTransaction(options);
          const current = tx.workspace;
          const draft = structuredClone(current);
          phase = "mutation";
          const result = await fn(draft, tx);
          if (options.operationMaintenance) {
            const business = (w) =>
              contentHash({
                ...w,
                revision: undefined,
                operationLeases: undefined,
              });
            if (business(current) !== business(draft))
              throw Error("Operation maintenance cannot change business data");
          }
          draft.revision = current.revision + 1;
          revision = draft.revision;
          phase = "validation";
          assertWorkspace(draft);
          phase = "previous";
          phase = "current";
          await tx.commitWorkspace(draft);
          phase = "result";
          return { revision: draft.revision, result: structuredClone(result) };
        });
      })
      .then(async (result) => {
        await recordDiagnostic(diagnostics, {
          operation: "storage.transaction",
          outcome: "success",
          phase: "finished",
          resource: "workspace.v2.json",
          revision,
          durationMs: Math.max(0, clock.now() - started),
        });
        return result;
      })
      .catch(async (error) => {
        error.storageOperation ||= "workspace." + phase;
        const entry = await recordDiagnostic(
          diagnostics,
          {
            operation: "storage.transaction",
            outcome: "failed",
            phase,
            resource: "workspace.v2.json",
            durationMs: Math.max(0, clock.now() - (started ?? clock.now())),
          },
          error,
        );
        if (entry) error.diagnosticId ||= entry.diagnosticId;
        throw error;
      });
    queue = operation.catch(() => {});
    return operation;
  };
  const runPath = (id) => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw Error("Invalid run id");
    return path.join(dataDir, "runs-v2", id + ".json");
  };
  const repository = {
    dataDir,
    clock,
    enableStrictSchema3() {
      legacyAllowed = false;
    },
    read,
    withMaintenanceTransaction,
    mutateWorkspace,
    async writeRunSnapshot(id, snapshot, options = {}) {
      if (typeof id === "object") {
        snapshot = id;
        id = snapshot.run?.runId || snapshot.runId;
      }
      const p = runPath(id);
      return inLock(async () =>
        (await makeTransaction(options)).writeSnapshot(id, snapshot),
      );
    },
    async readRunSnapshot(id) {
      return inLock(async () => {
        const w = await readInLock();
        const snapshot = JSON.parse(
          await fsAdapter.readFile(runPath(id), "utf8"),
        );
        if (w.schemaVersion === 3) assertSnapshotOwner(w, id, snapshot);
        return snapshot;
      });
    },
  };
  if (!allowLegacy) {
    const { bootstrapWorkspace } = await import("./bootstrap-workspace.mjs");
    await bootstrapWorkspace({ repository, fsAdapter });
    legacyAllowed = false;
  }
  return repository;
}
