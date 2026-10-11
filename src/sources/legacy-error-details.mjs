import { safeSourceIssues } from "./source-status.mjs";

// These snapshots cross the legacy string-error boundary. Never retain an
// upstream message, stack, URL, request payload, headers or arbitrary code.
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
]);
const transportCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ABORT_ERR",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_INVALID_PROTOCOL_VERSION",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]);

export function isLegacyNetworkErrorCode(code) {
  return transportCodes.has(code) && !["ETIMEDOUT", "ABORT_ERR"].includes(code);
}

export function safeLegacyErrorDetails(error) {
  const candidate = error?.code;
  const checked = safeSourceIssues([{ code: candidate }], "", "")[0].code;
  const code =
    transportCodes.has(candidate) ||
    (checked === candidate && typeof candidate === "string")
      ? candidate
      : undefined;
  const status = error?.status;
  return {
    name: errorNames.has(error?.name) ? error.name : "Error",
    ...(code ? { code } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
  };
}

export function legacyErrorFromDetails(details) {
  const safe = safeLegacyErrorDetails(details);
  const statusCode = [401, 403].includes(safe.status)
    ? "http_forbidden"
    : safe.status === 429
      ? "rate_limited"
      : [408, 504].includes(safe.status)
        ? "http_timeout"
        : undefined;
  return Object.assign(
    Error(safe.status ? `HTTP ${safe.status}` : "Source request failed"),
    safe,
    !safe.code && statusCode ? { code: statusCode } : {},
  );
}
