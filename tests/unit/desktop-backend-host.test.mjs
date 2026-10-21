import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDesktopBackend } from "../../electron/backend/host.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";

test("utility exit synchronously revokes an owned browser and rejects reverse RPC without waiting for settlement", async () => {
  const child = new EventEmitter(),
    sent = [];
  child.kill = () => true;
  child.postMessage = (frame) => {
    sent.push(frame);
    if (frame.type !== "request") return;
    const result =
      frame.method === "browser.ledger.snapshot"
        ? {
            maxRequests: 400,
            usedRequests: 0,
            usedBytes: 0,
            maxPageBytes: 20971520,
            maxAttachmentBytes: 20971520,
            maxTotalAttachmentBytes: 209715200,
          }
        : { accepted: true };
    queueMicrotask(() =>
      child.emit("message", {
        version: 1,
        type: "response",
        requestId: frame.requestId,
        ok: true,
        result,
      }),
    );
  };
  let started;
  const rendering = new Promise((resolve) => {
    started = resolve;
  });
  const fixture = collectionBrowserFixture({
    executeJavaScript: () => {
      started();
      return new Promise(() => {});
    },
  });
  const backend = createDesktopBackend({
    utilityProcess: { fork: () => child },
    ...fixture,
    sessionStore: {},
    appRoot: process.cwd(),
    dataDir: process.cwd(),
    packaged: false,
  });
  try {
    child.emit("message", {
      version: 1,
      type: "request",
      requestId: "q-00000000-0000-4000-8000-000000000001",
      method: "host.browser.read",
      input: {
        ref: {
          scope: { packageId: "A", targetRevisionId: "t1@1" },
          activityId: "root-one",
        },
        token: { epoch: 0, sliceRunId: "slice-one" },
        operationLease: { operationId: "op-one", token: "lease" },
        url: "https://m.weibo.cn/detail/123",
        platform: "weibo",
      },
    });
    await rendering;
    assert.equal(
      sent.some((frame) => frame.method === "browser.ledger.reserveBatch"),
      true,
    );
    assert.equal(fixture.windows[0].destroyed, false);
    child.emit("exit", 1);
    assert.equal(fixture.windows[0].destroyed, true);
    assert.equal(backend.snapshot().closed, true);
    assert.equal(backend.snapshot().pending, 0);
    assert.equal(
      sent.some((frame) => frame.method === "browser.ledger.settleBatch"),
      false,
    );
    await new Promise(setImmediate);
  } finally {
    await backend.close();
  }
});
