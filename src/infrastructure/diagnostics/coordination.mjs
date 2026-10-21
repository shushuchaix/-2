import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  reclaimDeadFileLock,
  reclaimDeadFileLockSync,
} from "../storage/lock.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const syncPause = new Int32Array(new SharedArrayBuffer(4));
const ownershipLost = () =>
  Object.assign(Error("Diagnostic log lock ownership changed"), {
    code: "diagnostic_lock_lost",
  });
const fatalBusyFacts = new WeakMap();
// Only errors created here carry acquisition facts. Reading this provenance
// does not inspect properties (including getters) on an external thrown value.
export const getDiagnosticFatalFailureFacts = (error) => fatalBusyFacts.get(error);
const busy = (facts) => {
  const error = Object.assign(Error("Diagnostic fatal log is busy"), {
    code: "diagnostic_lock_busy",
  });
  if (
    facts.configuredTimeoutMs === 250 &&
    [facts.acquisitionElapsedMs, facts.prepareCallElapsedMs,
      facts.totalWaitRequestedMs, facts.actualWaitMs].every((n) => Number.isFinite(n) && n >= 0) &&
    Number.isSafeInteger(facts.acquireProbeCount) && facts.acquireProbeCount >= 0 &&
    ["legacy_guard", "preparation", "publication"].includes(facts.lastStage)
  ) fatalBusyFacts.set(error, Object.freeze(facts));
  return error;
};
const turnTimeout = () =>
  Object.assign(Error("Diagnostic log ownership wait timed out"), {
    code: "diagnostic_lock_timeout",
  });
const transient = (error) =>
  process.platform === "win32" &&
  ["EPERM", "EACCES", "EBUSY"].includes(error.code);

function confirmedDead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}
function artifactOwner(filename, name, claim) {
  const prefix = path.basename(filename) + ".";
  const match = claim
    ? /^([1-9][0-9]*)-[a-f0-9]{32}\.claim(?:\.[a-f0-9]{32}\.tmp)?$/.exec(name)
    : name.startsWith(prefix)
      ? /^([1-9][0-9]*)\.[a-f0-9]{32}\.tmp$/.exec(name.slice(prefix.length))
      : null;
  return match ? Number(match[1]) : null;
}
async function pruneDeadPublications(filename, adapter) {
  for (const [directory, claim] of [
    [path.dirname(filename), false],
    [filename + ".reclaimers", true],
  ]) {
    let names;
    try {
      names = await adapter.readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      if (!confirmedDead(artifactOwner(filename, name, claim))) continue;
      try {
        await adapter.unlink(path.join(directory, name));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}
function pruneDeadPublicationsSync(filename) {
  for (const [directory, claim] of [
    [path.dirname(filename), false],
    [filename + ".reclaimers", true],
  ]) {
    let names;
    try {
      names = fsSync.readdirSync(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      if (!confirmedDead(artifactOwner(filename, name, claim))) continue;
      try {
        fsSync.unlinkSync(path.join(directory, name));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

/**
 * These are log-only paths, never the business workspace lock. Reuse its atomic
 * complete-owner publication and dead-owner election without changing that
 * protocol. A deadline observing this promise must not release its ownership:
 * a native append can still finish after its observer has timed out.
 */
export async function withDiagnosticLogTurn(filename, adapter, action, { signal, onWaiting } = {}) {
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + 500;
  const temp = filename + "." + process.pid + "." + randomUUID().replaceAll("-", "") + ".tmp";
  let prepared = false, published = false;
  const check = () => {
    if (signal?.aborted) throw turnTimeout();
  };
  const checkWait = () => {
    check();
    if (Date.now() >= deadline) throw turnTimeout();
  };
  const wait = () => new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(turnTimeout());
    const timer = setTimeout(() => finish(), Math.min(5, Math.max(0, deadline - Date.now())));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  // Waiting on an existing live/uncertain owner must not create and fsync a
  // fresh publication on every probe. Prepare one complete owner only when a
  // publication is possible; retain it across a lost no-replace race.
  check();
  try {
    for (;;) {
      check();
      let available = false;
      try { available = await reclaimDeadFileLock(filename, adapter); }
      catch (error) {
        if (!["ENOENT", "EEXIST"].includes(error.code) && !transient(error)) throw error;
      }
      check();
      if (available) {
        try {
          try {
            await adapter.stat(filename + ".reclaim");
            throw Object.assign(Error("Diagnostic legacy recovery owner uncertain"), { code: "EEXIST" });
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          check();
          if (!prepared) {
            const handle = await adapter.open(temp, "wx", 0o600);
            try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
            finally { await handle.close(); }
            prepared = true;
          }
          check();
          await adapter.link(temp, filename);
          published = true;
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      checkWait();
      onWaiting?.(true);
      try { await wait(); }
      finally { onWaiting?.(false); }
    }
  } finally {
    try { await adapter.unlink(temp); }
    catch (error) { if (error.code !== "ENOENT" && !published) throw error; }
  }
  try {
    await pruneDeadPublications(filename, adapter);
    if (signal?.aborted) throw turnTimeout();
    return await action();
  } finally {
    for (let attempt = 0; ; attempt++) {
      try {
        const current = JSON.parse(await adapter.readFile(filename, "utf8"));
        if (current.token !== owner.token) throw ownershipLost();
        await adapter.unlink(filename);
        break;
      } catch (error) {
        if (!transient(error) || attempt >= 6) throw error;
        await pause(Math.min(80, 5 * 2 ** attempt));
      }
    }
  }
}

/** Fatal writers alone use this independent turn; normal async IO never holds it. */
export function withDiagnosticFatalTurn(filename, action) {
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + 250;
  // Observation only: the existing wall-clock deadline and wait protocol below
  // remain authoritative. Synchronous call elapsed time includes scheduling.
  const acquisitionStart = performance.now();
  let prepareCallElapsedMs = 0, acquireProbeCount = 0,
    totalWaitRequestedMs = 0, actualWaitMs = 0, lastStage = "legacy_guard";
  const temp =
    filename +
    "." +
    process.pid +
    "." +
    randomUUID().replaceAll("-", "") +
    ".tmp";
  let prepared = false,
    published = false;
  try {
    for (;;) {
      try {
        acquireProbeCount++;
        lastStage = "legacy_guard";
        // Preserve the legacy recovery guard on every no-replace publication.
        try {
          fsSync.statSync(filename + ".reclaim");
          throw Object.assign(
            Error("Diagnostic legacy recovery owner uncertain"),
            { code: "EEXIST" },
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (!prepared) {
          lastStage = "preparation";
          const prepareStart = performance.now();
          try {
            const handle = fsSync.openSync(temp, "wx", 0o600);
            try {
              fsSync.writeFileSync(handle, JSON.stringify(owner));
              fsSync.fsyncSync(handle);
            } finally {
              fsSync.closeSync(handle);
            }
          } finally {
            prepareCallElapsedMs += Math.max(0, performance.now() - prepareStart);
          }
          prepared = true;
        }
        lastStage = "publication";
        fsSync.linkSync(temp, filename);
        published = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw busy({
          configuredTimeoutMs: 250,
          acquisitionElapsedMs: Math.max(0, performance.now() - acquisitionStart),
          prepareCallElapsedMs,
          acquireProbeCount,
          totalWaitRequestedMs,
          actualWaitMs,
          lastStage,
        });
        reclaimDeadFileLockSync(filename);
        const requestedWaitMs = Math.min(5, Math.max(0, deadline - Date.now()));
        totalWaitRequestedMs += requestedWaitMs;
        const waitStart = performance.now();
        Atomics.wait(
          syncPause,
          0,
          0,
          requestedWaitMs,
        );
        actualWaitMs += Math.max(0, performance.now() - waitStart);
      }
    }
  } finally {
    try {
      fsSync.unlinkSync(temp);
    } catch (error) {
      if (error.code !== "ENOENT" && !published) throw error;
    }
  }
  try {
    pruneDeadPublicationsSync(filename);
    return action();
  } finally {
    for (;;) {
      try {
        const current = JSON.parse(fsSync.readFileSync(filename, "utf8"));
        if (current.token !== owner.token) throw ownershipLost();
        fsSync.unlinkSync(filename);
        break;
      } catch (error) {
        if (!transient(error) || Date.now() >= deadline) throw error;
        Atomics.wait(syncPause, 0, 0, 5);
      }
    }
  }
}
