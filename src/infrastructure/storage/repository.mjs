import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
}) {
  if (!dataDir) throw Error("Missing data directory");
  dataDir = path.resolve(dataDir);
  await fsAdapter.mkdir(dataDir, { recursive: true });
  const filename = path.join(dataDir, "workspace.v2.json");
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
  const read = async () => {
    let raw;
    try {
      raw = await fsAdapter.readFile(filename, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return createEmptyWorkspace();
      throw e;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (e) {
      throw Error("Corrupt workspace JSON: " + e.message);
    }
    return assertWorkspace(value);
  };
  await read();
  let queue = Promise.resolve();
  const mutateWorkspace = (fn, options = {}) => {
    let phase = "lock",
      started,
      revision;
    const operation = queue
      .then(() => {
        started = clock.now();
        return withWorkspaceLock(dataDir, async () => {
          phase = "read";
          const current = await read();
          assertOperationWriteAllowed(current, options);
          const draft = structuredClone(current);
          phase = "mutation";
          const result = await fn(draft);
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
          if (current.revision > 0)
            await write(
              path.join(dataDir, "workspace.v2.previous.json"),
              current,
            );
          phase = "current";
          await write(filename, draft);
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
  return {
    dataDir,
    clock,
    read,
    mutateWorkspace,
    async writeRunSnapshot(id, snapshot, options = {}) {
      if (typeof id === "object") {
        snapshot = id;
        id = snapshot.run?.runId || snapshot.runId;
      }
      const p = runPath(id);
      return withWorkspaceLock(dataDir, async () => {
        assertOperationWriteAllowed(await read(), options);
        const raw = JSON.stringify(snapshot);
        try {
          const old = await fsAdapter.readFile(p, "utf8");
          if (contentHash(JSON.parse(old)) !== contentHash(snapshot))
            throw Error("Run snapshot immutable");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          await write(p, snapshot);
        }
        return {
          path: path.relative(dataDir, p).split(path.sep).join("/"),
          hash: contentHash(raw),
        };
      });
    },
    async readRunSnapshot(id) {
      return JSON.parse(await fsAdapter.readFile(runPath(id), "utf8"));
    },
  };
}
