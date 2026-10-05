import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createRunEventHub } from "../../src/application/run-events.mjs";
import { writeRunEventStream } from "../../src/server/event-stream.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { recoverWorkspace } from "../../src/infrastructure/storage/recovery.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
async function fixture(t) {
  const repository = await openWorkspaceRepository({
    dataDir: await createTempDir(t),
  });
  await repository.mutateWorkspace((w) => {
    w.runs.r1 = {
      runId: "r1",
      status: "running",
      lastSeq: 0,
      events: [],
      counts: {},
      snapshotRef: null,
    };
  });
  return { repository, hub: createRunEventHub({ repository, maxBuffered: 2 }) };
}
test("old cursors get one covering snapshot and boundary cursors replay monotonically", async (t) => {
  const { repository, hub } = await fixture(t);
  for (let i = 0; i < 3; i++)
    await hub.publish("r1", "stage", { stage: "阶段" + i });
  const seen = [];
  const stop = await hub.subscribe("r1", {
    afterSeq: 0,
    onEvent: async (e) => seen.push(e),
  });
  await delay(20);
  assert.equal(seen[0].type, "snapshot");
  assert.equal(seen[0].seq, 3);
  assert.equal(seen.length, 1);
  await hub.publish("r1", "batch", { counts: { raw: 2 } });
  await delay(20);
  assert.equal(seen[1].seq, 4);
  stop();
  const boundary = [];
  const unsub = await hub.subscribe("r1", {
    afterSeq: 2,
    onEvent: (e) => boundary.push(e),
  });
  await delay(20);
  assert.deepEqual(
    boundary.map((e) => e.seq),
    [3, 4],
  );
  unsub();
  await assert.rejects(
    hub.subscribe("r1", { afterSeq: 99, onEvent: () => {} }),
    /cursor|seq/i,
  );
  await recoverWorkspace(repository);
  assert.equal((await repository.read()).runs.r1.status, "interrupted");
  const restarted = createRunEventHub({ repository, maxBuffered: 2 });
  assert.equal((await restarted.publish("r1", "recovery", {})).seq, 5);
});
test("disconnect unsubscribes without cancelling and writes respect backpressure", async (t) => {
  const { repository, hub } = await fixture(t),
    req = new EventEmitter(),
    res = new EventEmitter();
  res.headers = {};
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.parts = [];
  res.write = (text) => {
    res.parts.push(Buffer.from(text));
    setTimeout(() => res.emit("drain"), 2);
    return false;
  };
  res.end = () => {
    res.writableEnded = true;
    res.emit("close");
  };
  const streaming = writeRunEventStream({
    req,
    res,
    runId: "r1",
    afterSeq: 0,
    eventHub: hub,
    heartbeatMs: 100,
  });
  await delay(20);
  await hub.publish("r1", "stage", { stage: "中文跨字节事件" });
  await delay(20);
  res.emit("close");
  await streaming;
  assert.equal((await repository.read()).runs.r1.status, "running");
  const bytes = Buffer.concat(res.parts),
    decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < bytes.length; i += 3)
    text += decoder.decode(bytes.subarray(i, i + 3), { stream: true });
  text += decoder.decode();
  assert.ok(text.includes("中文跨字节事件"));
  assert.ok(
    text
      .trim()
      .split("\n")
      .every((line) => JSON.parse(line).runId === "r1"),
  );
});
test("terminal cursor gets a current snapshot and missing terminal files remain visible", async (t) => {
  const { repository, hub } = await fixture(t);
  await hub.publish("r1", "done", { status: "failed" });
  await repository.mutateWorkspace((w) => {
    w.runs.r1.status = "failed";
    w.runs.r1.mode = "rules";
  });
  const seen = [];
  const stop = await hub.subscribe("r1", {
    afterSeq: 1,
    onEvent: (e) => seen.push(e),
  });
  await delay(20);
  stop();
  assert.equal(seen[0]?.type, "snapshot");
  assert.ok(
    (await recoverWorkspace(repository)).issues.some(
      (i) => i.code === "missing_snapshot",
    ),
  );
});
