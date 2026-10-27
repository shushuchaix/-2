import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nonce = () => randomUUID().replaceAll("-", "");
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}
function deadOwner(owner) {
  return Boolean(owner && (typeof owner.token === "string" || typeof owner.nonce === "string") && !alive(owner.pid));
}
const claimPattern = /^([1-9][0-9]*)-([a-f0-9]{32})\.claim(\.[a-f0-9]{32}\.tmp)?$/;
function participant(name) {
  const match = claimPattern.exec(name);
  return match ? { id: match[1] + "-" + match[2], pid: Number(match[1]), temporary: Boolean(match[3]) } : null;
}
function ticketState(text, id) {
  try {
    const state = JSON.parse(text);
    if (state.choosing === false && Number.isSafeInteger(state.ticket) && state.ticket > 0)
      return { id, ticket: state.ticket, choosing: false };
  } catch { /* A live owner with incomplete state must still block contenders. */ }
  return { id, ticket: 0, choosing: true };
}
const precedes = (other, own) => other.choosing || other.ticket < own.ticket || (other.ticket === own.ticket && other.id < own.id);
const busyLegacy = () => Object.assign(Error("Workspace busy: legacy recovery lock has an uncertain owner"), { code: "EEXIST" });
function coordinationFailure(error, phase) {
  const storageOperation = "workspace.lock." + phase;
  try {
    error.runFatal = true;
    error.storageOperation = storageOperation;
    if (error.runFatal === true && error.storageOperation === storageOperation) return error;
  } catch { /* Frozen errors require an explicit wrapper retaining the cause. */ }
  const failure = new Error("Workspace lock coordination failed.", { cause: error });
  if (error?.code !== undefined) failure.code = error.code;
  failure.runFatal = true;
  failure.storageOperation = storageOperation;
  return failure;
}
async function legacyGuardAbsent(filename, adapter) {
  try {
    if (typeof adapter.stat === "function") await adapter.stat(filename + ".reclaim");
    else await adapter.readFile(filename + ".reclaim");
    throw busyLegacy();
  }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
function legacyGuardAbsentSync(filename) {
  try { syncFs.statSync(filename + ".reclaim"); throw busyLegacy(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function removeOwn(file, adapter) {
  try { await adapter.unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
function removeOwnSync(file) {
  try { syncFs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function writeComplete(file, data, adapter) {
  const handle = await adapter.open(file, "wx", 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
function writeCompleteSync(file, data) {
  const handle = syncFs.openSync(file, "wx", 0o600);
  try { syncFs.writeFileSync(handle, data); syncFs.fsyncSync(handle); } finally { syncFs.closeSync(handle); }
}

// Publish a complete owner in one no-replace operation. A process that dies
// before publication leaves no main lock; after publication its PID is readable.
export async function publishOwnedFileLock(filename, owner, adapter) {
  await legacyGuardAbsent(filename, adapter);
  const temp = filename + "." + process.pid + "." + nonce() + ".tmp";
  let published = false;
  try {
    await writeComplete(temp, JSON.stringify(owner), adapter);
    await adapter.link(temp, filename);
    published = true;
  } finally {
    try { await removeOwn(temp, adapter); } catch (error) {
      // Once published, the caller must be allowed to release its main lock.
      if (!published) throw error;
    }
  }
}
export function publishOwnedFileLockSync(filename, owner) {
  legacyGuardAbsentSync(filename);
  const temp = filename + "." + process.pid + "." + nonce() + ".tmp";
  let published = false;
  try {
    writeCompleteSync(temp, JSON.stringify(owner));
    syncFs.linkSync(temp, filename);
    published = true;
  } finally {
    try { removeOwnSync(temp); } catch (error) { if (!published) throw error; }
  }
}

async function participants(directory, ownId, adapter) {
  const records = [];
  for (const name of await adapter.readdir(directory)) {
    const item = participant(name), file = path.join(directory, name);
    if (!item) { records.push({ choosing: true }); continue; }
    if (item.id === ownId) continue;
    if (!alive(item.pid)) { await removeOwn(file, adapter); continue; }
    if (item.temporary) continue;
    try { records.push(ticketState(await adapter.readFile(file, "utf8"), item.id)); }
    catch (error) { if (error.code !== "ENOENT") records.push({ id: item.id, choosing: true }); }
  }
  return records;
}
function participantsSync(directory, ownId) {
  const records = [];
  for (const name of syncFs.readdirSync(directory)) {
    const item = participant(name), file = path.join(directory, name);
    if (!item) { records.push({ choosing: true }); continue; }
    if (item.id === ownId) continue;
    if (!alive(item.pid)) { removeOwnSync(file); continue; }
    if (item.temporary) continue;
    try { records.push(ticketState(syncFs.readFileSync(file, "utf8"), item.id)); }
    catch (error) { if (error.code !== "ENOENT") records.push({ id: item.id, choosing: true }); }
  }
  return records;
}
const nextTicket = records => Math.max(0, ...records.map(item => item.ticket || 0)) + 1;

/**
 * A short Lamport bakery election serializes stale-owner removal. Participant
 * paths contain PID + a never-reused nonce, so even a crash immediately after
 * open has identifiable ownership. Choosing/ticket updates replace that same
 * path atomically. No fixed recovery lock, recursive recovery lock, expiry, or
 * read-nonce/unlink race is used to remove another contender's ownership.
 */
export async function reclaimDeadFileLock(filename, adapter) {
  try { if (!deadOwner(JSON.parse(await adapter.readFile(filename, "utf8")))) return false; }
  catch (error) { return error.code === "ENOENT"; }
  try { await legacyGuardAbsent(filename, adapter); } catch { return false; }
  const directory = filename + ".reclaimers", id = process.pid + "-" + nonce();
  const claim = path.join(directory, id + ".claim"), temp = claim + "." + nonce() + ".tmp";
  await adapter.mkdir(directory, { recursive: true });
  try {
    await writeComplete(claim, JSON.stringify({ choosing: true, ticket: 0 }), adapter);
    const own = { id, ticket: nextTicket(await participants(directory, id, adapter)) };
    if (!Number.isSafeInteger(own.ticket)) return false;
    await writeComplete(temp, JSON.stringify({ choosing: false, ticket: own.ticket }), adapter);
    await adapter.rename(temp, claim);
    if ((await participants(directory, id, adapter)).some(other => precedes(other, own))) return false;
    // Every remover participates in the election; an ordinary writer can only
    // publish while this path is absent. Re-read its current PID under the turn.
    let current;
    try { current = JSON.parse(await adapter.readFile(filename, "utf8")); }
    catch (error) { return error.code === "ENOENT"; }
    if (!deadOwner(current)) return false;
    await adapter.unlink(filename);
    return true;
  } finally {
    await removeOwn(temp, adapter);
    await removeOwn(claim, adapter);
  }
}
export function reclaimDeadFileLockSync(filename) {
  try { if (!deadOwner(JSON.parse(syncFs.readFileSync(filename, "utf8")))) return false; }
  catch (error) { return error.code === "ENOENT"; }
  try { legacyGuardAbsentSync(filename); } catch { return false; }
  const directory = filename + ".reclaimers", id = process.pid + "-" + nonce();
  const claim = path.join(directory, id + ".claim"), temp = claim + "." + nonce() + ".tmp";
  syncFs.mkdirSync(directory, { recursive: true });
  try {
    writeCompleteSync(claim, JSON.stringify({ choosing: true, ticket: 0 }));
    const own = { id, ticket: nextTicket(participantsSync(directory, id)) };
    if (!Number.isSafeInteger(own.ticket)) return false;
    writeCompleteSync(temp, JSON.stringify({ choosing: false, ticket: own.ticket }));
    syncFs.renameSync(temp, claim);
    if (participantsSync(directory, id).some(other => precedes(other, own))) return false;
    let current;
    try { current = JSON.parse(syncFs.readFileSync(filename, "utf8")); }
    catch (error) { return error.code === "ENOENT"; }
    if (!deadOwner(current)) return false;
    syncFs.unlinkSync(filename);
    return true;
  } finally {
    removeOwnSync(temp);
    removeOwnSync(claim);
  }
}

export async function withWorkspaceLock(dataDir, fn, { timeoutMs = 10000, pollMs = 25, fsAdapter = fs, platform = process.platform } = {}) {
  const adapter = fsAdapter;
  const transient = error => platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
  let filename, token;
  // Only coordination failures receive this origin. The caller's business or
  // network callback below must retain its own error classification.
  try {
  await adapter.mkdir(dataDir, { recursive: true });
  filename = path.join(dataDir, ".workspace.lock");
  token = randomUUID();
  const start = Date.now();
  const busy = () => Error("Workspace busy: active or uncertain owner lock (including legacy recovery locks)");
  let attempted = false, recoveredSlot = false;
  for (;;) {
    // Finishing an already-started recovery is not another wait. If its native
    // IO crossed the deadline, consume that result with exactly one no-replace
    // publication; losing that final race must never start another recovery.
    const followsRecovery = recoveredSlot;
    recoveredSlot = false;
    if (attempted && !followsRecovery && Date.now() - start >= timeoutMs) throw busy();
    attempted = true;
    try {
      await publishOwnedFileLock(filename, { pid: process.pid, token, createdAt: new Date().toISOString() }, adapter);
      break;
    } catch (error) {
      if (followsRecovery && Date.now() - start >= timeoutMs) {
        if (error.code === "EEXIST") throw busy();
        throw error;
      }
      if (transient(error)) {
        if (Date.now() - start >= timeoutMs) throw error;
      } else if (error.code !== "EEXIST") throw error;
      else {
        if (Date.now() - start >= timeoutMs) throw busy();
        // An immediate recovered-slot publication can lose to a live writer or
        // a legacy guard. Within budget it resumes the normal polling interval;
        // a repeatedly absent main file must not turn this into a busy loop.
        if (!followsRecovery) {
          try { recoveredSlot = await reclaimDeadFileLock(filename, adapter); }
          catch (failure) { if (!["ENOENT", "EEXIST"].includes(failure.code) && !transient(failure)) throw failure; }
          if (recoveredSlot) continue;
          if (Date.now() - start >= timeoutMs) throw busy();
        }
      }
      await sleep(pollMs);
    }
  }
  } catch (error) { throw coordinationFailure(error, "acquire"); }
  try { return await fn(); }
  finally {
    try {
    for (let attempt = 0;; attempt++) {
      try {
        const owner = JSON.parse(await adapter.readFile(filename, "utf8"));
        if (owner.token === token) await adapter.unlink(filename);
        break;
      } catch (error) {
        if (error.code === "ENOENT") break;
        if (!transient(error) || attempt >= 6) throw error;
        await sleep(Math.min(800, pollMs * 2 ** attempt));
      }
    }
    } catch (error) { throw coordinationFailure(error, "release"); }
  }
}
