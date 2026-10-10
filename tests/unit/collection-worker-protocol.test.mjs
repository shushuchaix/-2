import test from "node:test";
import assert from "node:assert/strict";
import {
  validateWorkerRequest,
  createJsonLineReader,
  workerEnvironment,
} from "../../src/infrastructure/collection/worker-protocol.mjs";
const input = {
  protocolVersion: 1,
  kind: "read",
  requestId: "request-one",
  mode: "dynamic",
  publicRoute: {
    providerId: "weibo-public",
    url: "https://m.weibo.cn/detail/123",
  },
  ruleId: "weibo_post_v1",
  limits: { maxRequests: 60, maxWireBytes: 20971520, maxDomBytes: 6291456 },
  timeoutMs: 45000,
};
test("worker only accepts fixed public routes and rules with no login materials", () => {
  assert.equal(
    validateWorkerRequest(input).publicUrl,
    "https://m.weibo.cn/detail/123",
  );
  for (const patch of [
    { cookies: [] },
    { command: "exec" },
    { ruleId: "script:run" },
    {
      publicRoute: {
        providerId: "weibo-public",
        url: "https://m.weibo.cn/detail/123?token=secret",
      },
    },
    {
      publicRoute: {
        providerId: "weibo-public",
        url: "https://m.weibo.cn/chat/123",
      },
    },
  ])
    assert.throws(() => validateWorkerRequest({ ...input, ...patch }));
  const env = workerEnvironment(
    {
      SystemRoot: "C:/Windows",
      TEMP: "C:/tmp",
      DEEPSEEK_API_KEY: "secret",
      HTTP_PROXY: "secret",
      PATH: "systemPython",
    },
    "C:/runtime",
  );
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.PATH, undefined);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, "C:/runtime/browsers");
});
test("line reader buffers bytes and refuses oversize, malformed and partial messages", () => {
  const values = [],
    reader = createJsonLineReader({
      maxBytes: 20,
      onMessage: (value) => values.push(value),
    });
  reader.push(Buffer.from('{"ok":'));
  reader.push(Buffer.from("true}\n"));
  reader.finish();
  assert.deepEqual(values, [{ ok: true }]);
  assert.throws(() =>
    createJsonLineReader({ maxBytes: 3 }).push(Buffer.from("four")),
  );
  const partial = createJsonLineReader({ maxBytes: 20 });
  partial.push(Buffer.from("{"));
  assert.throws(() => partial.finish());
  assert.throws(() =>
    createJsonLineReader({ maxBytes: 20 }).push(Buffer.from("oops\n")),
  );
});
