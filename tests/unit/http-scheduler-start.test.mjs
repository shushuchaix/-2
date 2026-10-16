import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";

test("origin spacing starts at callback entry after delayed microtasks", async () => {
  let now = 0;
  const scheduler = createScheduler({
    minIntervalMs: 25,
    maxConcurrent: 3,
    clock: { now: () => now },
  });
  const starts = [];
  const pending = Promise.all([
    scheduler.run("a", () => starts.push(["a", now])),
    scheduler.run("a", () => starts.push(["a", now])),
    scheduler.run("b", () => starts.push(["b", now])),
  ]);
  // Time passes before the admitted callbacks enter, as on a busy event loop.
  now = 40;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [
    ["a", 40],
    ["b", 40],
  ]);
  now = 65;
  await pending;
  assert.deepEqual(starts, [
    ["a", 40],
    ["b", 40],
    ["a", 65],
  ]);
});

test("abort before callback entry releases admission without consuming spacing", async () => {
  const scheduler = createScheduler({
    minIntervalMs: 60_000,
    maxConcurrent: 2,
    clock: { now: () => 10 },
  });
  const controller = new AbortController();
  let abortedCalls = 0;
  const cancelled = scheduler.run("a", () => abortedCalls++, {
    signal: controller.signal,
  });
  controller.abort();
  let nextCalls = 0;
  const next = scheduler.run("a", () => nextCalls++);
  await assert.rejects(cancelled, { name: "AbortError" });
  await next;
  assert.equal(abortedCalls, 0);
  assert.equal(nextCalls, 1);
});

test("zero interval preserves per-origin concurrency and rejection drains queued work", async () => {
  const scheduler = createScheduler({
    minIntervalMs: 0,
    maxConcurrent: 3,
    maxPerOrigin: 2,
  });
  let active = 0,
    maximum = 0,
    release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const run = () =>
    scheduler.run("a", async () => {
      active++;
      maximum = Math.max(maximum, active);
      await held;
      active--;
    });
  const first = run(),
    second = run(),
    third = run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  release();
  await Promise.all([first, second, third]);
  assert.equal(maximum, 2);
  const failed = scheduler.run("a", () => {
    throw Error("synthetic failure");
  });
  let drained = false;
  const after = scheduler.run("a", () => {
    drained = true;
  });
  await assert.rejects(failed, /synthetic failure/);
  await after;
  assert.equal(drained, true);
});
