import { createHash } from "node:crypto";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const unmodified = Symbol("collection-not-modified");
export const SINGLE_PUBLIC_GET_PAGE = "single-public-get-v2";
const normalizedHeaders = (headers = {}) => Object.entries(headers)
  .map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b));
const withoutConditions = (options) => ({ ...options, headers: Object.fromEntries(
  Object.entries(options.headers || {}).filter(([key]) => !/^(if-none-match|if-modified-since)$/i.test(key)),
) });
const safeGet = (options) =>
  String(options?.method || "GET").toUpperCase() === "GET" &&
  options?.body === undefined &&
  !Object.keys(options?.headers || {}).some((key) =>
    /^(authorization|cookie|proxy-authorization|x-api-key)$/i.test(key),
  );
/** Only explicitly versioned, single-resource pure pages may restore a parsed page. */
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
    provider.id === "boss" ||
    provider.conditionalPageCache !== SINGLE_PUBLIC_GET_PAGE ||
    typeof provider.parserVersion !== "string" || !provider.parserVersion.length ||
    !/^[a-f0-9]{64}$/.test(input.conditionalVariantHash || "")
  )
    return { request, latest: () => null, isUnmodified: () => false };
  let latest = null, requests = 0, disqualified = false;
  const parserVersion = provider.parserVersion,
    cacheEvidence = { version: 2, mode: SINGLE_PUBLIC_GET_PAGE, variantHash: input.conditionalVariantHash, singleResource: true };
  const wrapped = async (url, options = {}) => {
    if (++requests > 1 || !safeGet(options)) { latest = null; disqualified = true; }
    if (disqualified) return request(url, options);
    const parsed = new URL(url);
    parsed.hash = "";
    const resourceKey =
        "page:v2:" + digest(JSON.stringify([
          provider.id, parserVersion, input.conditionalVariantHash, parsed.href, normalizedHeaders(options.headers),
        ])),
      previous = await cache.get({ scope: input.scope, resourceKey });
    const matching =
      previous?.parserVersion === parserVersion &&
      previous.parsedEvidence?.pageResult?.parserVersion === parserVersion &&
      previous.parsedEvidence?.cacheEvidence?.version === 2 &&
      previous.parsedEvidence.cacheEvidence.mode === SINGLE_PUBLIC_GET_PAGE &&
      previous.parsedEvidence.cacheEvidence.variantHash === input.conditionalVariantHash &&
      previous.parsedEvidence.cacheEvidence.singleResource === true;
    const headers = {
      ...options.headers,
      ...(matching && previous.etag ? { "If-None-Match": previous.etag } : {}),
      ...(matching && previous.lastModified
        ? { "If-Modified-Since": previous.lastModified }
        : {}),
    };
    let response = await request(url, { ...options, headers });
    if (response.status === 304 && matching && !disqualified && requests === 1) {
      latest = {
        resourceKey,
        ...previous,
        cacheEvidence,
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
    if (response.status === 304) {
      // There is no matching body. Fetch it at most once; never invent an empty page.
      latest = null; disqualified = true; requests++;
      response = await request(url, withoutConditions(options));
    }
    if (response.status === 200 && !disqualified && requests === 1) {
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
        cacheEvidence,
        evidenceCheckedAt: new Date(
          input.context?.clock?.now?.() ?? Date.now(),
        ).toISOString(),
      };
    }
    return response;
  };
  return {
    request: wrapped,
    latest: () => !disqualified && requests === 1 ? latest : null,
    isUnmodified: (value) => !!value?.[unmodified],
  };
}
export async function persistConditionalPage(input, page) {
  const cache = input.context?.conditionalCache || input.conditionalCache,
    metadata = page.conditionalResponse;
  if (!cache || !metadata || metadata.cacheEvidence?.version !== 2 ||
    metadata.cacheEvidence.mode !== SINGLE_PUBLIC_GET_PAGE || metadata.cacheEvidence.singleResource !== true ||
    metadata.cacheEvidence.variantHash !== input.conditionalVariantHash || !metadata.resourceKey?.startsWith("page:v2:")) return;
  const { conditionalResponse, ...pageResult } = page;
  const { cacheEvidence, ...cacheMetadata } = metadata,
    parsedEvidence = { pageResult, cacheEvidence };
  // Oversized evidence is not cached; it remains in the owned fact/task rows.
  if (Buffer.byteLength(JSON.stringify(parsedEvidence)) > 1024 * 1024) return;
  await cache.put({
    scope: input.scope,
    ref: input.ref,
    token: input.token,
    operationLease: input.operationLease,
    ...cacheMetadata,
    parsedEvidence,
  });
}
