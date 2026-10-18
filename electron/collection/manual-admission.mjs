import { cancellableSleep } from "../../src/infrastructure/http/scheduler.mjs";

const assets = new Set(["script", "stylesheet", "font", "image"]);
const cancelled = () =>
  Object.assign(Error("采集窗口已关闭。"), { code: "collection_cancelled" });

/** The manual window already owns a 60-request/20MiB allowance. Static assets
 * share at most six live requests per host, while login/business navigation
 * retains its 300ms pacing. A completed/failed/redirected request releases its
 * slot; abandoning a window aborts all queued admission immediately. */
export function createManualAdmission({
  signal,
  allowance,
  perHost = 6,
  maxQueued = 60,
} = {}) {
  const hosts = new Map(),
    releases = new Map();
  let queue = Promise.resolve(),
    closed = false,
    queued = 0;
  const ensure = () => {
    if (closed || signal?.aborted) throw cancelled();
  };
  const keyFor = (details) =>
    typeof details.id === "number" || typeof details.id === "string"
      ? details.id
      : null;
  const release = (details) => {
    const key = keyFor(details),
      done = releases.get(key);
    releases.delete(key);
    done?.();
  };
  const acquire = async (details) => {
    ensure();
    const host = new URL(details.url).hostname;
    let state = hosts.get(host);
    if (!state) {
      state = { active: 0, waiting: [] };
      hosts.set(host, state);
    }
    if (state.active >= perHost) {
      if (queued >= maxQueued)
        throw Object.assign(Error("登录窗口请求已达上限。"), {
          code: "collection_login_budget_exhausted",
        });
      queued++;
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, abort: null };
        entry.abort = () => {
          const index = state.waiting.indexOf(entry);
          if (index < 0) return;
          state.waiting.splice(index, 1);
          queued--;
          reject(cancelled());
        };
        state.waiting.push(entry);
        signal?.addEventListener("abort", entry.abort, { once: true });
        if (signal?.aborted) entry.abort();
      });
    } else state.active++;
    ensure();
    const key = keyFor(details);
    if (key === null) {
      state.active--;
      throw cancelled();
    }
    release(details);
    let done = false;
    releases.set(key, () => {
      if (done) return;
      done = true;
      const next = state.waiting.shift();
      if (next) {
        queued--;
        signal?.removeEventListener("abort", next.abort);
        next.resolve();
      } else state.active--;
    });
  };
  return {
    async admit(details) {
      ensure();
      if (
        assets.has(details.resourceType) &&
        ["GET", "HEAD"].includes(details.method || "GET")
      )
        return acquire(details);
      const task = queue.then(async () => {
        ensure();
        await cancellableSleep(
          Math.max(0, allowance.lastAt + 300 - Date.now()),
          signal,
        );
        ensure();
        allowance.lastAt = Date.now();
      });
      queue = task.catch(() => {});
      await task;
    },
    release,
    close() {
      if (closed) return;
      closed = true;
      for (const state of hosts.values())
        for (const entry of state.waiting.splice(0)) {
          queued--;
          signal?.removeEventListener("abort", entry.abort);
          entry.reject(cancelled());
        }
      for (const done of releases.values()) done();
      releases.clear();
    },
    snapshot: () => ({ queued, active: releases.size }),
  };
}
