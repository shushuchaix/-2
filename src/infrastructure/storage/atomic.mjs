import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const renameDelays = [25, 50, 100, 200, 400, 800];
const transientWindowsCodes = new Set(["EPERM", "EACCES", "EBUSY"]);

async function replaceFile(
  from,
  to,
  { fsAdapter, platform, sleep, onRenameRecovery },
) {
  let retryCount = 0,
    retryDelayMs = 0,
    code;
  for (;;) {
    try {
      await fsAdapter.rename(from, to);
      break;
    } catch (error) {
      if (
        platform !== "win32" ||
        !transientWindowsCodes.has(error.code) ||
        retryCount >= renameDelays.length
      ) {
        if (retryCount) error.retryCount = retryCount;
        throw error;
      }
      code = error.code;
      const delay = renameDelays[retryCount++];
      retryDelayMs += delay;
      await sleep(delay);
    }
  }
  if (retryCount && onRenameRecovery) {
    // Diagnostics must not turn a completed save into an apparent failure.
    try {
      await onRenameRecovery({ retryCount, code, retryDelayMs });
    } catch {}
  }
}

export async function writeAtomicJson(
  filename,
  value,
  options = {},
) {
  return writeAtomicJsonText(filename, JSON.stringify(value, null, 2), options);
}

/** Internal pre-serialized JSON path; durability is identical to writeAtomicJson. */
export async function writeAtomicJsonText(
  filename,
  serialized,
  {
    fsAdapter = fs,
    platform = process.platform,
    sleep = wait,
    onRenameRecovery,
    captureFileIdentity = false,
  } = {},
) {
  if (typeof serialized !== "string") throw TypeError("Expected serialized JSON");
  const temp = filename + "." + randomUUID() + ".tmp";
  let handle,
    identityHandle,
    beforeIdentity,
    identity,
    failure,
    phase = "mkdir";
  try {
    await fsAdapter.mkdir(path.dirname(filename), { recursive: true });
    phase = "open";
    handle = await fsAdapter.open(temp, "wx");
    phase = "write";
    await handle.writeFile(serialized, "utf8");
    phase = "sync";
    await handle.sync();
    phase = "close";
    await handle.close();
    handle = null;
    if (captureFileIdentity) {
      // The read handle stays attached to this inode even if an outside writer
      // replaces the destination immediately after rename. The writer is closed
      // first because Windows may finalize mtime only on close.
      try {
        identityHandle = await fsAdapter.open(temp, "r");
        beforeIdentity = await identityHandle.stat({ bigint: true });
      } catch {}
    }
    phase = "rename";
    // Retry only replacement of the already synced file. Never remove the old
    // destination or repeat the business transaction to overcome a sharing lock.
    await replaceFile(temp, filename, {
      fsAdapter,
      platform,
      sleep,
      onRenameRecovery,
    });
    if (beforeIdentity) {
      try {
        const after = await identityHandle.stat({ bigint: true });
        if (["dev", "ino", "size", "mtimeNs"].every((key) =>
          beforeIdentity[key] !== undefined && beforeIdentity[key] === after[key])) identity = after;
      } catch {}
    }
    return captureFileIdentity ? identity : undefined;
  } catch (error) {
    failure = error;
    error.storageOperation ||= "atomic." + phase;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (identityHandle) await identityHandle.close().catch(() => {});
    await fsAdapter.unlink(temp).catch((e) => {
      if (e.code !== "ENOENT" && !failure) {
        e.storageOperation ||= "atomic.cleanup";
        throw e;
      }
    });
  }
}
