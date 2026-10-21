import test from "node:test";
import assert from "node:assert/strict";
import {
  createRpcPeer,
  assertRpcValue,
} from "../../src/infrastructure/runtime/rpc.mjs";
import {
  desktopCapabilities,
  serializableBrowserInput,
} from "../../electron/backend/protocol.mjs";
import {
  desktopShutdownReceipt,
  stopDesktopHttp,
} from "../../electron/backend/shutdown.mjs";

function pair(
  capabilities,
  leftHandlers = {},
  rightHandlers = {},
  options = {},
) {
  let left, right;
  left = createRpcPeer({
    capabilities,
    handlers: leftHandlers,
    send: (v) => queueMicrotask(() => right.receive(structuredClone(v))),
    ...options,
  });
  right = createRpcPeer({
    capabilities,
    handlers: rightHandlers,
    send: (v) => queueMicrotask(() => left.receive(structuredClone(v))),
    ...options,
  });
  return {
    left,
    right,
    close() {
      left.close();
      right.close();
    },
  };
}
const dto = (v) => v && typeof v === "object";
const contract = {
  "browser.read": { input: dto, output: dto },
  "ledger.reserve": { input: dto, output: dto },
};

test("reverse ledger RPC remains reentrant while the original browser operation waits", async () => {
  let peers,
    reservations = 0;
  peers = pair(
    contract,
    { "ledger.reserve": async () => ({ reserved: ++reservations }) },
    {
      "browser.read": async () => {
        const value = await peers.right.call("ledger.reserve", {});
        return { response: true, reservation: value.reserved };
      },
    },
    { timeoutMs: 500 },
  );
  try {
    assert.deepEqual(await peers.left.call("browser.read", {}), {
      response: true,
      reservation: 1,
    });
  } finally {
    peers.close();
  }
});

test("exit uniformly rejects pending work and aborts handlers without awaiting them", async () => {
  let aborted = false;
  const peers = pair(
    contract,
    {},
    {
      "browser.read": (_input, { signal }) =>
        new Promise(() =>
          signal.addEventListener("abort", () => {
            aborted = true;
          }),
        ),
    },
  );
  const waiting = peers.left.call("browser.read", {});
  await new Promise(setImmediate);
  peers.right.close("backend_exited");
  peers.left.close("backend_exited");
  await assert.rejects(waiting, { code: "backend_exited" });
  assert.equal(aborted, true);
  assert.deepEqual(peers.left.snapshot(), {
    closed: true,
    pending: 0,
    incoming: 0,
  });
});

test("pending work is bounded; cancellation and timeout revoke correlation and late results", async () => {
  let resolve, observed;
  const peers = pair(
    contract,
    {},
    {
      "browser.read": (_v, { signal }) => {
        observed = signal;
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    { maxPending: 1 },
  );
  try {
    const controller = new AbortController();
    const task = peers.left.call(
      "browser.read",
      {},
      { signal: controller.signal },
    );
    await assert.rejects(peers.left.call("browser.read", {}), {
      code: "rpc_pending_limit",
    });
    await new Promise(setImmediate);
    controller.abort();
    await assert.rejects(task, { code: "rpc_cancelled" });
    await new Promise(setImmediate);
    assert.equal(observed.aborted, true);
    resolve({ tooLate: true });
    await new Promise(setImmediate);
    assert.equal(peers.left.snapshot().pending, 0);
    await assert.rejects(
      peers.left.call("browser.read", {}, { timeoutMs: 2 }),
      { code: "rpc_timeout" },
    );
  } finally {
    peers.close();
  }
});

test("capability contract rejects native handles, arbitrary methods and raw session material", async () => {
  const peers = pair(
    desktopCapabilities,
    {},
    {
      "host.sessions.get": () => ({
        platform: "boss",
        cookies: [{ value: "private" }],
      }),
    },
  );
  try {
    for (const payload of [
      { callback() {} },
      { signal: new AbortController().signal },
      { native: new URL("https://example.invalid") },
    ])
      assert.throws(() => assertRpcValue(payload), {
        code: "rpc_payload_invalid",
      });
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => assertRpcValue(cycle), { code: "rpc_payload_invalid" });
    let accessed = false;
    const accessor = Object.defineProperty({}, "private", {
      enumerable: true,
      get() {
        accessed = true;
        return "secret";
      },
    });
    assert.throws(() => assertRpcValue(accessor), {
      code: "rpc_payload_invalid",
    });
    assert.equal(accessed, false);
    assert.throws(() => assertRpcValue(new Array(2)), {
      code: "rpc_payload_invalid",
    });
    const extra = [1];
    extra.callback = "unexpected";
    assert.throws(() => assertRpcValue(extra), { code: "rpc_payload_invalid" });
    assert.throws(
      () => assertRpcValue({ text: "x".repeat(100) }, { maxBytes: 20 }),
      { code: "rpc_payload_limit" },
    );
    await assert.rejects(peers.left.call("repository.read", {}), {
      code: "rpc_capability_invalid",
    });
    await assert.rejects(
      peers.left.call("host.sessions.get", {
        scope: { packageId: "A", targetRevisionId: "t1@1" },
        sessionRef: "session-one",
      }),
      { code: "rpc_response_invalid" },
    );
    const input = serializableBrowserInput({
      ref: {
        scope: { packageId: "A", targetRevisionId: "t1@1" },
        activityId: "root",
      },
      operationLease: { operationId: "op-one", token: "lease", release() {} },
      signal: new AbortController().signal,
      request() {},
      routePolicy: { platform: "wechat", publicPath() {} },
    });
    assert.equal(input.signal, undefined);
    assert.equal(input.request, undefined);
    assert.equal(input.operationLease.release, undefined);
    assert.equal(input.platform, "wechat");
  } finally {
    peers.close();
  }
});

test("remote failures retain safe identifiers and committed state without exception content", async () => {
  const peers = pair(
    contract,
    {},
    {
      "browser.read": () => {
        throw Object.assign(Error("secret body C:/Users/private resume"), {
          code: "sqlite_post_commit",
          committed: true,
          diagnosticId: "d-00000000-0000-4000-8000-000000000001",
          stack: "secret stack",
          cookie: "secret",
        });
      },
    },
  );
  try {
    await assert.rejects(peers.left.call("browser.read", {}), (error) => {
      assert.equal(error.committed, true);
      assert.equal(error.code, "sqlite_post_commit");
      assert.equal(JSON.stringify(error).includes("secret"), false);
      assert.equal(error.message.includes("secret"), false);
      assert.match(error.message, /错误编号/);
      return true;
    });
  } finally {
    peers.close();
  }
});

test("shutdown receipts preserve failed drain resources without carrying exception data", () => {
  assert.deepEqual(desktopShutdownReceipt(["worker", "repository", "worker"]), {
    stopped: true,
    cleanupComplete: false,
    failedResources: ["worker", "repository"],
  });
  assert.deepEqual(desktopShutdownReceipt(["C:/private/path"]), {
    stopped: true,
    cleanupComplete: false,
    failedResources: ["application"],
  });
  assert.equal(desktopShutdownReceipt().cleanupComplete, true);
});

test("desktop shutdown stops HTTP admission and keepalives before application drain", async () => {
  const events = [];
  let serverClosed;
  const promise = stopDesktopHttp({
    listening: true,
    close(callback) {
      events.push("stop-admission");
      serverClosed = callback;
    },
    closeAllConnections() {
      events.push("close-connections");
    },
  });
  events.push("drain-context");
  assert.deepEqual(events, [
    "stop-admission",
    "close-connections",
    "drain-context",
  ]);
  serverClosed();
  await promise;
});
