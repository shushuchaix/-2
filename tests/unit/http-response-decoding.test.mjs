import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { decompressResponseBytes } from "../../src/infrastructure/http/response-decoding.mjs";
const html = Buffer.from(
  "<title>招聘</title><p>消防岗位完整要求和截止日期</p>",
);
for (const [encoding, compress] of [
  ["gzip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
])
  test(
    "HTTP " + encoding + " is decoded before HTML and preserves the full body",
    () => {
      assert.deepEqual(
        decompressResponseBytes(
          compress(html),
          { "content-encoding": encoding },
          1024,
        ),
        html,
      );
    },
  );
test("nested content codings are decoded in reverse order", () => {
  assert.deepEqual(
    decompressResponseBytes(
      brotliCompressSync(gzipSync(html)),
      { "content-encoding": "gzip, br" },
      1024,
    ),
    html,
  );
});
test("compressed and expanded bodies both remain bounded", () => {
  assert.throws(() => decompressResponseBytes(Buffer.alloc(101), {}, 100), {
    code: "response_size_exceeded",
  });
  assert.throws(
    () =>
      decompressResponseBytes(
        gzipSync(Buffer.alloc(4096)),
        { "content-encoding": "gzip" },
        100,
      ),
    { code: "response_size_exceeded" },
  );
});
test("corrupt or unsupported content codings fail rather than passing binary text to a parser", () => {
  assert.throws(
    () =>
      decompressResponseBytes(
        Buffer.from([0x1f, 0x8b, 0x08]),
        { "content-encoding": "gzip" },
        1024,
      ),
    { code: "response_decode_failed" },
  );
  assert.throws(
    () =>
      decompressResponseBytes(html, { "content-encoding": "unknown" }, 1024),
    { code: "unsupported_content_encoding" },
  );
});
test("identity bytes are unchanged for PDF, attachments and ordinary HTML", () => {
  assert.deepEqual(decompressResponseBytes(html, {}, 1024), html);
  const pdf = Buffer.from("%PDF-1.7");
  assert.deepEqual(
    decompressResponseBytes(
      gzipSync(pdf),
      { "content-encoding": "gzip" },
      1024,
    ),
    pdf,
  );
});
