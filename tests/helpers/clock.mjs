export function createFakeClock(start = "2026-10-05T00:00:00.000Z") {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    advance: (ms) => {
      time += ms;
    },
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      time += ms;
      await Promise.resolve();
      signal?.throwIfAborted();
    },
  };
}
