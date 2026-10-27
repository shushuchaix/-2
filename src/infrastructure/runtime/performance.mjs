import { monitorEventLoopDelay } from "node:perf_hooks";

// The monitor observes its own process. Offscreen screenshot results must never
// stand in for this monitor running with normal hardware acceleration.
export function createRuntimePerformance() {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const started = performance.now();
  delay.enable();
  return {
    snapshot() {
      const ms = (value) =>
        Number.isFinite(value) && value >= 0 && value < 1e15
          ? Math.ceil(value / 1e6)
          : 0;
      return {
        elapsedMs: Math.round(performance.now() - started),
        eventLoopDelayMs: ms(delay.max),
        eventLoopP95Ms: ms(delay.percentile(95)),
        rssBytes: process.memoryUsage().rss,
      };
    },
    close() {
      delay.disable();
    },
  };
}
