import os from "node:os";
import { safeApiRoute } from "../../../public/js/diagnostic-rules.js";
import { VERSION } from "../../version.mjs";

const tokens = /^[A-Za-z0-9_.@-]{1,160}$/;
export const token = (value) =>
  typeof value === "string" && tokens.test(value) ? value : undefined;
export const identifier = (value, prefix) =>
  typeof value === "string" &&
  new RegExp(
    "^" +
      prefix +
      "-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
  ).test(value)
    ? value
    : undefined;
const numeric = (value) => Number.isSafeInteger(value) && value >= 0;
function numbers(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const result = {};
  for (const key of keys) if (numeric(value[key])) result[key] = value[key];
  return Object.keys(result).length ? result : undefined;
}
const countKeys = [
  "raw",
  "normalized",
  "notices",
  "expanded",
  "deduplicated",
  "eligible",
  "shortlisted",
  "aiSuccess",
  "fallback",
  "newForTarget",
  "input",
  "accepted",
  "rejected",
  "pages",
  "plannedSites",
  "skippedSites",
  "queries",
  "cached",
  "invalid",
  "missing",
  "valid",
  "noJob",
  "skipped",
  "failed",
  "complete",
  "interrupted",
  "orphan",
  "issues",
];
const enums = {
  stage: [
    "queued",
    "planning",
    "collecting",
    "details",
    "expanding",
    "evaluating",
    "finished",
    "startup",
    "interrupted",
  ],
  phase: [
    "started",
    "finished",
    "validation",
    "cache",
    "queue",
    "dns",
    "budget",
    "transport",
    "response",
    "redirect",
    "retry",
    "parse",
    "lock",
    "read",
    "mutation",
    "previous",
    "current",
    "snapshot",
    "render",
    "load",
    "commit",
    "cleanup",
  ],
  outcome: [
    "success",
    "failed",
    "retrying",
    "cached",
    "cancelled",
    "timeout",
    "partial",
    "completed",
    "empty",
    "skipped",
    "insufficient",
  ],
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  endpointKind: [
    "list",
    "detail",
    "search",
    "dns",
    "import",
    "model",
    "request",
  ],
  dnsResolver: ["system", "doh", "cache", "fallback"],
  kind: ["request", "list", "detail", "search", "dns", "redirect", "retry"],
  abortedBy: ["caller", "timeout"],
  mode: ["rules", "ai", "auto"],
  budgetKind: ["requests", "details"],
};
export function cleanParser(value) {
  if (!value || typeof value !== "object") return undefined;
  const result =
    numbers(value, [
      "textLength",
      "documentLength",
      "resultCount",
      "expectedCount",
    ]) || {};
  if (["json", "html", "pdf", "docx", "text"].includes(value.format))
    result.format = value.format;
  if (
    [
      "object",
      "array",
      "null",
      "string",
      "number",
      "boolean",
      "unknown",
    ].includes(value.resultType)
  )
    result.resultType = value.resultType;
  for (const key of ["selectorPresent", "titleOnly"])
    if (typeof value[key] === "boolean") result[key] = value[key];
  if (token(value.version)) result.version = value.version;
  if (Array.isArray(value.missingFields)) {
    const fields = [
      ...new Set(
        value.missingFields.filter((v) =>
          [
            "data",
            "list",
            "description",
            "title",
            "url",
            "sourceId",
            "records",
            "count",
            "id",
          ].includes(v),
        ),
      ),
    ];
    if (fields.length) result.missingFields = fields;
  }
  return Object.keys(result).length ? result : undefined;
}
export function cleanRuntime(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const key of [
    "appVersion",
    "nodeVersion",
    "electronVersion",
    "chromeVersion",
    "osRelease",
  ])
    if (
      typeof value[key] === "string" &&
      /^v?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?$/.test(value[key]) &&
      value[key].length <= 60
    )
      result[key] = value[key];
  if (
    ["win32", "linux", "darwin", "freebsd", "openbsd", "aix", "sunos"].includes(
      value.platform,
    )
  )
    result.platform = value.platform;
  if (
    ["x64", "arm64", "ia32", "arm", "ppc64", "s390x", "riscv64"].includes(
      value.arch,
    )
  )
    result.arch = value.arch;
  if (typeof value.packaged === "boolean") result.packaged = value.packaged;
  if (/^[a-f0-9]{40}$/.test(String(value.buildId)))
    result.buildId = value.buildId;
  return Object.keys(result).length ? result : undefined;
}
export function defaultRuntime() {
  return cleanRuntime({
    appVersion: VERSION,
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
  });
}
export function cleanMetadata(value) {
  const result =
    numbers(value, [
      "durationMs",
      "queueMs",
      "dnsMs",
      "transportMs",
      "timeoutMs",
      "responseBytes",
      "attempt",
      "maxRetries",
      "retryCount",
      "retryDelayMs",
      "redirectCount",
      "page",
      "pageLimit",
      "queryIndex",
      "recordCount",
      "issueCount",
      "batchSize",
      "revision",
      "errorNumber",
    ]) || {};
  if (
    Number.isInteger(value.httpStatus) &&
    value.httpStatus >= 100 &&
    value.httpStatus <= 599
  )
    result.httpStatus = value.httpStatus;
  if (Number.isSafeInteger(value.exitCode)) result.exitCode = value.exitCode;
  if (Number.isSafeInteger(value.errorNumber))
    result.errorNumber = value.errorNumber;
  for (const key of ["runId", "sourceId", "siteId", "jobId", "code"])
    if (token(value[key])) result[key] = value[key];
  for (const [key, prefix] of [
    ["requestId", "q"],
    ["parentRequestId", "q"],
    ["parentDiagnosticId", "d"],
    ["sessionId", "s"],
  ])
    if (identifier(value[key], prefix)) result[key] = value[key];
  for (const [key, values] of Object.entries(enums))
    if (values.includes(value[key])) result[key] = value[key];
  if (enums.phase.includes(value.failurePhase))
    result.failurePhase = value.failurePhase;
  // Stored route values must already be templates; never persist raw identifiers.
  if (
    typeof value.route === "string" &&
    value.route === safeApiRoute(value.route)
  )
    result.route = value.route;
  for (const key of ["cacheHit", "hasMore"])
    if (typeof value[key] === "boolean") result[key] = value[key];
  const counts = numbers(value.counts, countKeys);
  if (counts) result.counts = counts;
  const coverage = numbers(value.coverage, [
    "complete",
    "failed",
    "truncated",
    "sites",
  ]);
  if (coverage) result.coverage = coverage;
  if (value.usage && typeof value.usage === "object") {
    const usage = {};
    const sources = numbers(value.usage.sources, [
      "requests",
      "details",
      "maxRequests",
      "maxDetails",
    ]);
    if (sources) {
      const byKind = numbers(value.usage.sources.byKind, enums.kind);
      if (byKind) sources.byKind = byKind;
      usage.sources = sources;
    }
    const model = numbers(value.usage.model, [
      "requests",
      "maxRequests",
      "maxOutputTokens",
      "promptTokens",
      "completionTokens",
      "calls",
      "failures",
    ]);
    if (model) usage.model = model;
    if (Object.keys(usage).length) result.usage = usage;
  }
  const parser = cleanParser(value.parser),
    runtime = cleanRuntime(value.runtime);
  if (parser) result.parser = parser;
  if (runtime) result.runtime = runtime;
  return result;
}
