const finished = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);
export async function writeRunEventStream({
  req,
  res,
  runId,
  afterSeq = 0,
  eventHub,
  heartbeatMs = 15000,
}) {
  const controller = new AbortController();
  let closed = false,
    unsubscribe,
    heartbeat,
    pendingHeartbeat = false;
  let resolveClosed;
  const ended = new Promise((resolve) => (resolveClosed = resolve));
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    unsubscribe?.();
    clearInterval(heartbeat);
    resolveClosed();
  };
  res.once("close", close);
  req.once("aborted", close);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  async function write(event) {
    if (closed || res.writableEnded) return;
    const accepted = res.write(JSON.stringify(event) + "\n");
    if (!accepted)
      await new Promise((resolve) => {
        const complete = () => {
          res.removeListener("drain", complete);
          res.removeListener("close", complete);
          resolve();
        };
        res.once("drain", complete);
        res.once("close", complete);
      });
  }
  try {
    unsubscribe = await eventHub.subscribe(runId, {
      afterSeq,
      signal: controller.signal,
      onEvent: async (event) => {
        await write(event);
        if (
          event.type === "done" ||
          (event.type === "snapshot" && finished.has(event.payload.run.status))
        ) {
          res.end();
          close();
        }
      },
    });
    if (closed) unsubscribe();
    else {
      heartbeat = setInterval(async () => {
        if (closed || pendingHeartbeat) return;
        pendingHeartbeat = true;
        try {
          // Heartbeats are transport frames, not persisted domain events; their seq is null.
          await write({
            schemaVersion: 2,
            runId,
            seq: null,
            type: "heartbeat",
            at: new Date().toISOString(),
            payload: {},
          });
        } finally {
          pendingHeartbeat = false;
        }
      }, heartbeatMs);
      heartbeat.unref?.();
    }
    await ended;
  } finally {
    close();
    res.removeListener("close", close);
    req.removeListener("aborted", close);
  }
}
