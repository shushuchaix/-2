export const abortError = (signal) =>
  signal?.reason || new DOMException("Aborted", "AbortError");
export function cancellableSleep(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export function createScheduler({
  maxConcurrent = 8,
  maxPerOrigin = 2,
  minIntervalMs = 600,
  clock = { now: Date.now },
} = {}) {
  const queue = [],
    active = new Map(),
    lastStart = new Map();
  const health = new Map();
  let total = 0,
    timer = null;
  function drain() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    let next = Infinity;
    for (let i = 0; i < queue.length && total < maxConcurrent; ) {
      const item = queue[i];
      if (item.signal?.aborted) {
        queue.splice(i, 1);
        item.reject(abortError(item.signal));
        continue;
      }
      const wait =
        (lastStart.get(item.origin) ?? -Infinity) +
        Math.max(
          minIntervalMs,
          item.minIntervalMs || 0,
          health.get(item.origin)?.intervalMs || 0,
        ) -
        clock.now();
      if ((active.get(item.origin) || 0) >= maxPerOrigin) {
        i++;
        continue;
      }
      if (wait > 0) {
        next = Math.min(next, wait);
        i++;
        continue;
      }
      queue.splice(i, 1);
      item.signal?.removeEventListener("abort", item.abort);
      active.set(item.origin, (active.get(item.origin) || 0) + 1);
      total++;
      lastStart.set(item.origin, clock.now());
      Promise.resolve()
        .then(() => {
          item.signal?.throwIfAborted();
          return item.fn();
        })
        .then(item.resolve, item.reject)
        .finally(() => {
          total--;
          active.set(item.origin, active.get(item.origin) - 1);
          drain();
        });
    }
    if (queue.length && Number.isFinite(next))
      timer = setTimeout(drain, Math.max(1, next));
  }
  return {
    recordOutcome(origin, { durationMs = 0, status = 200 } = {}) {
      const previous = health.get(origin)?.intervalMs ?? minIntervalMs;
      const failed = status >= 400;
      const intervalMs = Math.min(
        60000,
        failed
          ? Math.max(minIntervalMs, previous * 2, 1000)
          : Math.max(minIntervalMs, previous * 0.9, durationMs),
      );
      health.set(origin, { intervalMs: Math.ceil(intervalMs) });
    },
    originState(origin) {
      return { ...(health.get(origin) || { intervalMs: minIntervalMs }) };
    },
    run(origin, fn, { signal, minIntervalMs: interval = 0 } = {}) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const item = {
          origin,
          fn,
          signal,
          minIntervalMs: interval,
          resolve,
          reject,
        };
        item.abort = () => {
          const i = queue.indexOf(item);
          if (i >= 0) {
            queue.splice(i, 1);
            reject(abortError(signal));
            drain();
          }
        };
        signal?.addEventListener("abort", item.abort, { once: true });
        queue.push(item);
        drain();
      });
    },
  };
}
export const sharedScheduler = createScheduler();
export const sharedSocialScheduler = createScheduler({
  maxPerOrigin: 1,
  minIntervalMs: 3000,
});
export const isSocialOrigin = (value) =>
  /^(?:mp\.weixin\.qq\.com|(?:m\.)?weibo\.cn|(?:www\.)?weibo\.com)$/.test(
    new URL(value).hostname,
  );
