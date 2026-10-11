import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
const failure = (code) => Object.assign(Error(code), { code });
export function decompressResponseBytes(content, headers, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw failure("response_size_exceeded");
  let bytes = Buffer.from(content);
  if (bytes.length > maxBytes) throw failure("response_size_exceeded");
  const codings = String(headers?.["content-encoding"] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== "identity");
  if (codings.length > 3) throw failure("unsupported_content_encoding");
  for (const coding of codings.reverse()) {
    const decode = {
      gzip: gunzipSync,
      "x-gzip": gunzipSync,
      deflate: inflateSync,
      br: brotliDecompressSync,
    }[coding];
    if (!decode) throw failure("unsupported_content_encoding");
    try {
      bytes = decode(bytes, { maxOutputLength: maxBytes });
    } catch (error) {
      throw failure(
        error.code === "ERR_BUFFER_TOO_LARGE"
          ? "response_size_exceeded"
          : "response_decode_failed",
      );
    }
    if (bytes.length > maxBytes) throw failure("response_size_exceeded");
  }
  return bytes;
}
