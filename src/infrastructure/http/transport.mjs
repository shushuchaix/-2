import http from "node:http";
import https from "node:https";
import { isPublicAddress } from "./public-url.mjs";
import { decodeResponseText } from "./text-decoding.mjs";
import { decompressResponseBytes } from "./response-decoding.mjs";
export function socketTransport({
  url,
  addresses,
  method = "GET",
  headers = {},
  body,
  signal,
  maxBytes,
  responseType = "text",
}) {
  return new Promise((resolve, reject) => {
    const address = addresses[0];
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers,
        signal,
        agent: false,
        lookup: (host, options, callback) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(
              Object.assign(Error("Response size limit exceeded"), {
                code: "response_size_exceeded",
              }),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const wireContent = Buffer.concat(chunks);
            const responseHeaders = Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(",") : String(v || ""),
              ]),
            );
            // Encoding metadata may describe a representation even when the
            // method or status prohibits a body. Received bytes still count.
            const bodyAllowed =
              method !== "HEAD" && ![204, 304].includes(res.statusCode);
            const content = bodyAllowed
              ? decompressResponseBytes(wireContent, responseHeaders, maxBytes)
              : Buffer.alloc(0);
            if (responseType === "bytes") {
              resolve({
                status: res.statusCode,
                headers: responseHeaders,
                bytes: new Uint8Array(content),
                url: url.href,
                wireByteLength: wireContent.length,
              });
              return;
            }
            const text = decodeResponseText(
              content,
              String(res.headers["content-type"] || ""),
            );
            resolve({
              status: res.statusCode,
              headers: responseHeaders,
              text,
              url: url.href,
              wireByteLength: wireContent.length,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.on("socket", (socket) => {
      const connected = () => {
        if (
          !isPublicAddress(socket.remoteAddress) ||
          !addresses.some(
            (a) =>
              a.address === socket.remoteAddress ||
              (a.family === 4 &&
                socket.remoteAddress === "::ffff:" + a.address),
          )
        ) {
          request.destroy(Error("Unexpected connected address"));
          return;
        }
        request.end(body);
      };
      socket.once(
        url.protocol === "https:" ? "secureConnect" : "connect",
        connected,
      );
    });
  });
}
