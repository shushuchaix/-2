import { validatePublicUrl } from "../../src/infrastructure/http/public-url.mjs";

const searchPath = "/api/v1/search/job/posts";
const queries = new Set(["消防", "机场"]);
const arrays = [
  "job_category_id_list",
  "tag_id_list",
  "location_code_list",
  "subject_id_list",
  "job_function_id_list",
  "storefront_id_list",
];
const emptyPageFilters = [
  "category",
  "location",
  "project",
  "job_hot_flag",
  "functionCategory",
  "tag",
];

export const isNativePublicSearchPolicy = (policy) =>
  policy?.platform === "bytedance" && queries.has(policy.nativePublicQuery);
function expectedBody(query) {
  return {
    keyword: query,
    limit: 10,
    offset: 0,
    ...Object.fromEntries(arrays.map((k) => [k, []])),
    recruitment_id_list: ["201"],
    portal_type: 3,
    portal_entrance: 1,
  };
}
function checkedUrl(value) {
  const url = validatePublicUrl(value);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.hash)
    throw Error("native_public_route_invalid");
  return url;
}
function searchQueryMatches(url, query) {
  const expected = expectedBody(query);
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) return false;
    seen.add(key);
    // This value is produced by the employer's normal page. It is never
    // synthesized or copied from a signed-in browser by the collector.
    if (key === "_signature") {
      if (!/^[A-Za-z0-9_.~+/=-]{1,4096}$/.test(value)) return false;
    } else if (key === "job_post_id_list") {
      if (value !== "[]") return false;
    } else if (
      !Object.hasOwn(expected, key) ||
      value !==
        (Array.isArray(expected[key])
          ? JSON.stringify(expected[key])
          : String(expected[key]))
    )
      return false;
  }
  return true;
}

export function allowsNativePublicSearchUrl(value, policy) {
  if (!isNativePublicSearchPolicy(policy)) return false;
  try {
    const url = checkedUrl(value);
    if (url.hostname !== "jobs.bytedance.com" || url.pathname !== searchPath)
      return false;
    return searchQueryMatches(url, policy.nativePublicQuery);
  } catch {
    return false;
  }
}

export function allowsNativePublicPage(value, policy) {
  if (!isNativePublicSearchPolicy(policy)) return false;
  try {
    const url = checkedUrl(value);
    if (url.hostname !== "jobs.bytedance.com")
      return policy.publicPath(url) === true;
    if (url.pathname === searchPath)
      return searchQueryMatches(url, policy.nativePublicQuery);
    if (url.pathname === "/api/v1/csrf/token") return !url.search;
    if (url.pathname !== "/campus/position")
      return (
        policy.publicPath(url) === true && !url.pathname.startsWith("/api/")
      );
    const expected = {
      keywords: policy.nativePublicQuery,
      type: "2",
      current: "1",
      limit: "10",
      ...Object.fromEntries(emptyPageFilters.map((k) => [k, ""])),
    };
    const seen = new Set();
    for (const [key, value] of url.searchParams) {
      if (seen.has(key)) return false;
      seen.add(key);
      if (key === "spread") {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return false;
      } else if (!Object.hasOwn(expected, key) || value !== expected[key])
        return false;
    }
    return url.searchParams.get("keywords") === policy.nativePublicQuery;
  } catch {
    return false;
  }
}

export function isNativePublicSearchRequest(details, policy) {
  if (
    !allowsNativePublicSearchUrl(details.url, policy) ||
    details.method !== "POST"
  )
    return false;
  if (
    !Array.isArray(details.uploadData) ||
    !details.uploadData.length ||
    details.uploadData.some((v) => v.file || !(v.bytes instanceof Uint8Array))
  )
    return false;
  const bytes = Buffer.concat(
    details.uploadData.map((v) => Buffer.from(v.bytes)),
  );
  if (bytes.length > 16384) return false;
  try {
    const text = bytes.toString("utf8"),
      body = JSON.parse(text),
      expected = expectedBody(policy.nativePublicQuery);
    // Reject duplicate members, malformed UTF-8 and extra material on the wire.
    if (
      !Buffer.from(text).equals(bytes) ||
      JSON.stringify(body) !== text ||
      !body ||
      Array.isArray(body)
    )
      return false;
    if (
      Object.keys(body).some(
        (k) => k !== "job_post_id_list" && !Object.hasOwn(expected, k),
      )
    )
      return false;
    if (
      Object.hasOwn(body, "job_post_id_list") &&
      JSON.stringify(body.job_post_id_list) !== "[]"
    )
      return false;
    return Object.entries(expected).every(
      ([k, v]) => JSON.stringify(body[k]) === JSON.stringify(v),
    );
  } catch {
    return false;
  }
}
