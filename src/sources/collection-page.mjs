import { createHash } from "node:crypto";
import { assertSourceRecord } from "../domain/contracts.mjs";
const error = (code) => Object.assign(Error(code), { code });
function finite(value, depth = 0) {
  if (depth > 8) throw error("collection_cursor_invalid");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 4096) return;
  if (Array.isArray(value) && value.length <= 128) {
    for (const v of value) finite(v, depth + 1);
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length > 128
  )
    throw error("collection_cursor_invalid");
  for (const [k, v] of Object.entries(value)) {
    if (
      /^(?:__proto__|constructor|prototype|cookie|cookies|authorization|password|access_token|api_key|apiKey)$/i.test(
        k,
      )
    )
      throw error("collection_cursor_invalid");
    finite(v, depth + 1);
  }
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, ordered(value[k])]),
    );
  return value;
}
export function collectionCursorHash(cursor) {
  finite(cursor);
  if (cursor !== null && (typeof cursor !== "object" || Array.isArray(cursor)))
    throw error("collection_cursor_invalid");
  const encoded = JSON.stringify(ordered(cursor));
  if (Buffer.byteLength(encoded) > 16384)
    throw error("collection_cursor_invalid");
  return digest(cursor?.url ? JSON.stringify({ url: cursor.url }) : encoded);
}
export async function readProviderPage(provider, input) {
  const cursor = input.cursor ?? null,
    cursorHash = collectionCursorHash(cursor);
  input.signal?.throwIfAborted();
  const resumable =
    typeof provider.collectPage === "function" &&
    provider.capabilities?.resumablePages !== false;
  if (!resumable && cursor !== null) throw error("pagination_not_supported");
  const result = resumable
    ? await provider.collectPage({ ...input, cursor })
    : await provider.collect({
        ...input.context,
        scope: input.scope,
        site: input.site,
        sites: [input.site],
        queries: [input.query || {}],
        request: input.request || input.context?.request,
        signal: input.signal || input.context?.signal,
        onBatch: undefined,
      });
  input.signal?.throwIfAborted();
  if (!result || !Array.isArray(result.records))
    throw error("collection_page_invalid");
  const records = [],
    issues = [...(result.issues || [])];
  for (const record of result.records) {
    try {
      assertSourceRecord(record);
      records.push(record);
    } catch {
      issues.push({
        code: "invalid_record",
        sourceId: provider.id,
        siteId: input.site?.siteId,
        retryable: false,
      });
    }
  }
  const done = resumable ? result.done === true : true;
  const nextCursor = done ? null : (result.nextCursor ?? null);
  if (!done && nextCursor === null) throw error("collection_page_invalid");
  const nextCursorHash =
    nextCursor === null ? null : collectionCursorHash(nextCursor);
  if (
    nextCursorHash &&
    (nextCursorHash === cursorHash ||
      (input.seenCursorHashes || []).includes(nextCursorHash))
  )
    throw error("pagination_cycle");
  const parserVersion =
    result.parserVersion || provider.parserVersion || provider.id + "-1";
  const unitId =
    input.unitId ||
    provider.id +
      "/" +
      input.site?.siteId +
      "/" +
      digest(JSON.stringify(ordered(input.query || {})));
  return {
    ...result,
    records,
    issues,
    done,
    nextCursor,
    cursorHash,
    nextCursorHash,
    parserVersion,
    resumablePages: resumable,
    pageKey: digest(JSON.stringify([unitId, cursorHash, parserVersion])),
  };
}
