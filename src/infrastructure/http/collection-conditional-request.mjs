import { createHash } from "node:crypto";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const unmodified = Symbol("collection-not-modified");
const safeGet = (options) =>
  String(options?.method || "GET").toUpperCase() === "GET" &&
  options?.body === undefined &&
  !Object.keys(options?.headers || {}).some((key) =>
    /^(authorization|cookie)$/i.test(key),
  );
/** Safe public GET only. A 304 reuses parsed page evidence without advancing its evidence time. */
export function conditionalPageRequest(input, provider) {
  const cache = input.context?.conditionalCache || input.conditionalCache,
    request = input.request || input.context?.request;
  if (
    !cache ||
    !request ||
    !input.scope ||
    !input.ref ||
    !input.token ||
    !input.operationLease ||
    provider.id === "boss"
  )
    return { request, latest: () => null, isUnmodified: () => false };
  let latest = null;
  const parserVersion = provider.parserVersion || provider.id + "-1";
  const wrapped = async (url, options = {}) => {
    if (!safeGet(options)) return request(url, options);
    const parsed = new URL(url);
    parsed.hash = "";
    const resourceKey =
        "page:" +
        provider.id +
        ":" +
        parsed.href +
        ":" +
        digest(JSON.stringify(options.headers || {})),
      previous = await cache.get({ scope: input.scope, resourceKey });
    const matching =
      previous?.parserVersion === parserVersion &&
      previous.parsedEvidence?.pageResult;
    const headers = {
      ...options.headers,
      ...(matching && previous.etag ? { "If-None-Match": previous.etag } : {}),
      ...(matching && previous.lastModified
        ? { "If-Modified-Since": previous.lastModified }
        : {}),
    };
    let response = await request(url, { ...options, headers });
    if (response.status === 304 && matching) {
      latest = {
        resourceKey,
        ...previous,
        checkedAt: new Date(
          input.context?.clock?.now?.() ?? Date.now(),
        ).toISOString(),
        evidenceCheckedAt: previous.evidenceCheckedAt || previous.checkedAt,
      };
      throw {
        [unmodified]: true,
        result: {
          ...structuredClone(previous.parsedEvidence.pageResult),
          notModified: true,
          reusedEvidence: true,
        },
      };
    }
    if (response.status === 304) response = await request(url, options);
    if (response.status === 200) {
      latest = {
        resourceKey,
        etag: response.headers?.etag || null,
        lastModified: response.headers?.["last-modified"] || null,
        bodyHash: digest(
          response.bytes instanceof Uint8Array
            ? response.bytes
            : response.text || "",
        ),
        parserVersion,
        evidenceCheckedAt: new Date(
          input.context?.clock?.now?.() || Date.now(),
        ).toISOString(),
      };
    }
    return response;
  };
  return {
    request: wrapped,
    latest: () => latest,
    isUnmodified: (value) => !!value?.[unmodified],
  };
}
export async function persistConditionalPage(input, page) {
  const cache = input.context?.conditionalCache || input.conditionalCache,
    metadata = page.conditionalResponse;
  if (!cache || !metadata) return;
  const { conditionalResponse, ...pageResult } = page;
  // Oversized evidence is not cached; it remains in the owned fact/task rows.
  if (Buffer.byteLength(JSON.stringify({ pageResult })) > 1024 * 1024) return;
  await cache.put({
    scope: input.scope,
    ref: input.ref,
    token: input.token,
    operationLease: input.operationLease,
    ...metadata,
    parsedEvidence: { pageResult },
  });
}
