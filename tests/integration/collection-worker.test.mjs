import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createAnonymousWorker } from "../../src/infrastructure/collection/worker-client.mjs";
const input = {
  ref: {
    scope: { packageId: "p-a", targetRevisionId: "t-a" },
    activityId: "root-a",
  },
  token: { epoch: 1, sliceRunId: "slice-a" },
  operationLease: {},
  publicRoute: {
    providerId: "weibo-public",
    url: "https://m.weibo.cn/detail/123",
  },
  extractionRule: "weibo_post_v1",
};
function fixture(mode) {
  let child,
    options,
    reservation,
    settled = 0,
    revoke = 0;
  const spawn = (_, args, opts) => {
    options = opts;
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 123;
    child.kill = () => {
      queueMicrotask(() => child.emit("exit", 1));
    };
    child.stdin.once("data", () =>
      queueMicrotask(() => {
        child.stderr.write("DEEPSEEK_API_KEY=PRIVATE");
        if (mode === "crash") child.emit("exit", 1);
        else if (mode === "oversize") child.stdout.write(Buffer.alloc(8388609));
      }),
    );
    return child;
  };
  const worker = createAnonymousWorker({
    runtime: {
      root: "C:/runtime",
      python: "C:/runtime/python/python.exe",
      workerPath: "C:/fixture/collection_worker.py",
      capabilities: { dynamic: true, enhanced: true, static: true },
      verified: true,
    },
    spawn,
    terminateTree: async (child) => child.kill(),
    ledger: {
      reserve: async (value) => {
        reservation = value;
        return { reservationId: "reservation-one" };
      },
      settle: async () => {
        settled++;
      },
    },
    egressProxy: {
      start: async () => ({ proxyUrl: "http://127.0.0.1:12345" }),
      createClient: () => ({
        username: "synthetic",
        password: "synthetic",
        grant: () => {},
        revoke: () => revoke++,
        snapshot: () => ({ bytes: 0 }),
      }),
    },
  });
  return {
    worker,
    get child() {
      return child;
    },
    get options() {
      return options;
    },
    get reservation() {
      return reservation;
    },
    get settled() {
      return settled;
    },
    get revoked() {
      return revoke;
    },
  };
}
test("worker crash keeps complete pre-reservation and raw stderr is never exposed", async () => {
  const f = fixture("crash");
  await assert.rejects(
    f.worker.read(input),
    (e) =>
      e.code === "collection_worker_crashed" && !e.message.includes("PRIVATE"),
  );
  assert.equal(f.reservation.requestUpperBound, 60);
  assert.equal(f.reservation.bytesUpperBound, 20971520);
  assert.equal(f.settled, 0);
  assert.equal(f.options.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(f.options.shell, false);
  assert.equal(f.options.windowsHide, true);
  assert.equal(f.worker.snapshot().workers, 0);
  assert.ok(f.revoked);
});
test("oversize output and cancellation revoke proxy and terminate worker", async () => {
  const f = fixture("oversize");
  await assert.rejects(f.worker.read(input), {
    code: "collection_worker_protocol",
  });
  assert.equal(f.worker.snapshot().workers, 0);
  const g = fixture("wait"),
    abort = new AbortController(),
    pending = g.worker.read({ ...input, signal: abort.signal }),
    rejected = assert.rejects(pending);
  while (!g.child) await new Promise((r) => setImmediate(r));
  abort.abort();
  await rejected;
  assert.equal(g.worker.snapshot().workers, 0);
  assert.ok(g.revoked);
});

test("a valid grant and result settle after clean exit and same root never repeats enhancement", async () => {
  const claims = [],
    settlements = [];
  let clientGrants = 0;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.once("data", (data) =>
      queueMicrotask(() => {
        const frame = JSON.parse(data);
        child.stdout.write(
          JSON.stringify({
            protocolVersion: 1,
            kind: "grant_request",
            requestId: frame.requestId,
            sequence: 1,
            url: frame.publicUrl,
            method: "GET",
            resourceType: "document",
          }) + "\n",
        );
        child.stdout.write(
          JSON.stringify({
            protocolVersion: 1,
            kind: "result",
            requestId: frame.requestId,
            status: 200,
            url: frame.publicUrl,
            html: '<div class="weibo-text">Synthetic job</div>',
            bodyStatus: "complete",
            requests: 1,
          }) + "\n",
        );
        child.emit("exit", 0);
      }),
    );
    return child;
  };
  const worker = createAnonymousWorker({
    runtime: {
      verified: true,
      root: "C:/runtime",
      python: "C:/runtime/python/python.exe",
      workerPath: "C:/fixture/worker.py",
      capabilities: { enhanced: true },
    },
    spawn,
    ledger: {
      reserve: async (value) => {
        claims.push(value);
        return { reservationId: value.reservationId };
      },
      settle: async (value) => settlements.push(value),
    },
    egressProxy: {
      start: async () => ({ proxyUrl: "http://127.0.0.1:12345" }),
      createClient: () => ({
        username: "a",
        password: "b",
        grant: () => clientGrants++,
        revoke: () => {},
        snapshot: () => ({ bytes: 123 }),
      }),
    },
  });
  assert.equal((await worker.read(input)).bodyStatus, "complete");
  assert.equal(clientGrants, 1);
  assert.equal(settlements[0].verifiedUsage.requests, 60);
  assert.equal(settlements[0].verifiedUsage.bytes, 123);
  assert.equal(
    (
      await worker.read({
        ...input,
        token: { ...input.token, sliceRunId: "other-slice" },
      })
    ).code,
    "collection_enhancement_already_attempted",
  );
  assert.equal(claims.length, 1);
  await worker.stop();
});
