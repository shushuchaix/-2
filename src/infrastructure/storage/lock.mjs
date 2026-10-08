import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
export async function withWorkspaceLock(
  dataDir,
  fn,
  { timeoutMs = 10000, pollMs = 25, fsAdapter = fs, platform = process.platform } = {},
) {
  const fs = fsAdapter;
  const transient = e => platform === 'win32' && ['EPERM','EACCES','EBUSY'].includes(e.code);
  await fs.mkdir(dataDir, { recursive: true });
  const filename = path.join(dataDir, ".workspace.lock");
  const token = randomUUID();
  const start = Date.now();
  for (;;) {
    let opened = false;
    try {
      const h = await fs.open(filename, "wx");
      opened = true;
      try {
        await h.writeFile(
          JSON.stringify({
            pid: process.pid,
            token,
            createdAt: new Date().toISOString(),
          }),
        );
        await h.sync();
      } finally {
        await h.close();
      }
      break;
    } catch (e) {
      // Windows can report sharing/delete-pending contention as EPERM instead of EEXIST.
      // Retry acquisition only; never execute a transaction again after it acquired the lock.
      if (!opened && transient(e)) {
        if (Date.now() - start >= timeoutMs) throw e;
        await sleep(pollMs);
        continue;
      }
      if (e.code !== "EEXIST") throw e;
      try {
        const owner = JSON.parse(await fs.readFile(filename, "utf8"));
        if (!alive(owner.pid)) {
          // Serialize reclamation too: two reclaimers must not remove a newly acquired lock.
          let reclaim;
          try {
            reclaim = await fs.open(filename + ".reclaim", "wx");
            const current = JSON.parse(await fs.readFile(filename, "utf8"));
            if (!alive(current.pid)) await fs.unlink(filename);
          } catch (err) {
            if (!["EEXIST", "ENOENT"].includes(err.code)) throw err;
          } finally {
            if (reclaim) {
              await reclaim.close();
              await fs.unlink(filename + ".reclaim").catch(() => {});
            }
          }
          if (Date.now() - start >= timeoutMs)
            throw Error("Workspace busy: uncertain lock reclamation");
          await sleep(pollMs);
        }
      } catch (err) {
        if (err.code === "ENOENT") continue;
      }
      if (Date.now() - start >= timeoutMs)
        throw Error("Workspace busy: active or uncertain owner lock");
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    for (let attempt = 0;;attempt++) {
      try {
        const owner = JSON.parse(await fs.readFile(filename, "utf8"));
        if (owner.token === token) await fs.unlink(filename);
        break;
      } catch (e) {
        if (e.code === "ENOENT") break;
        if (!transient(e) || attempt >= 6) throw e;
        await sleep(Math.min(800, pollMs * 2 ** attempt));
      }
    }
  }
}
