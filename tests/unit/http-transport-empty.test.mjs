import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { socketTransport } from "../../src/infrastructure/http/transport.mjs";

const address = { address: "93.184.216.34", family: 4 };

function respond(t, { status = 200, content = Buffer.alloc(0) } = {}) {
  t.mock.method(http, "request", (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.destroy = (error) => {
      request.destroyed = true;
      request.emit("error", error);
      return request;
    };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = status;
      response.headers = {
        "content-encoding": "gzip",
        "content-type": "text/html; charset=utf-8",
      };
      onResponse(response);
      if (content.length) response.emit("data", content);
      if (!request.destroyed) response.emit("end");
      return request;
    };
    queueMicrotask(() => {
      const socket = new EventEmitter();
      socket.remoteAddress = address.address;
      request.emit("socket", socket);
      socket.emit("connect");
    });
    return request;
  });
}

const read = (options = {}) =>
  socketTransport({
    url: new URL("http://jobs.example.org/notice"),
    addresses: [address],
    maxBytes: 1024,
    ...options,
  });

for (const [method, status] of [
  ["HEAD", 200],
  ["GET", 204],
  ["GET", 304],
]) {
  for (const responseType of ["text", "bytes"]) {
    test(`${method} ${status} retains encoding metadata without decoding an absent ${responseType} body`, async (t) => {
      respond(t, { status });
      const result = await read({ method, responseType });
      assert.equal(result.status, status);
      assert.equal(result.headers["content-encoding"], "gzip");
      assert.equal(result.wireByteLength, 0);
      if (responseType === "bytes") assert.equal(result.bytes.byteLength, 0);
      else assert.equal(result.text, "");
    });
  }
}

test("an unexpected 204 body is ignored while its received bytes stay counted", async (t) => {
  respond(t, { status: 204, content: Buffer.from("invalid gzip body") });
  const result = await read();
  assert.equal(result.text, "");
  assert.equal(result.wireByteLength, 17);
});

test("an unexpected 204 body still obeys the received byte limit", async (t) => {
  respond(t, { status: 204, content: Buffer.alloc(40) });
  await assert.rejects(read({ maxBytes: 8 }), {
    code: "response_size_exceeded",
  });
});

test("a redirect with a gzip body retains its decoded content", async (t) => {
  const content = gzipSync(Buffer.from("<p>notice moved</p>"));
  respond(t, { status: 301, content });
  const result = await read();
  assert.equal(result.status, 301);
  assert.equal(result.text, "<p>notice moved</p>");
  assert.equal(result.wireByteLength, content.length);
});

test("an empty GET 200 gzip body still fails decoding", async (t) => {
  respond(t);
  await assert.rejects(read(), { code: "response_decode_failed" });
});
