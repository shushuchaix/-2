import fs from "node:fs/promises";
import path from "node:path";

/** Test-only completion observation; a released owner does not assert success. */
export function createDiagnosticWriteBarrier({ dataDir, fsAdapter = fs }) {
  const lock = path.join(dataDir, "logs", ".application.lock");
  let releaseCount = 0;
  const observers = new Set();
  const adapter = {
    ...fsAdapter,
    async unlink(...args) {
      await fsAdapter.unlink(...args);
      if (args[0] === lock) {
        releaseCount++;
        for (const observe of observers) observe();
      }
    },
  };
  return {
    fsAdapter: adapter,
    get releaseCount() { return releaseCount; },
    async waitForWrites(expectedCount, { phase = "normal_write", releaseHold = () => {} } = {}) {
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw Error("Invalid fixture completion count");
      let watchdog, observe;
      try {
        await new Promise((resolve, reject) => {
          observe = () => { if (releaseCount >= expectedCount) resolve(); };
          observers.add(observe);
          // Fixture liveness only, independent of the product's 500ms observer.
          // Missing actual completion fails; it never forces owner release.
          watchdog = setTimeout(() => reject(Object.assign(
            Error("Physical diagnostic owner release missing"),
            { code: "physical_release_missing", phase, releaseCount, expectedCount },
          )), 5000);
          observe();
        });
        // Let the native unlink's enclosing promise/finalizers finish first.
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        clearTimeout(watchdog);
        observers.delete(observe);
        releaseHold();
      }
    },
  };
}
