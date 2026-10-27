// Persist only public diagnostic metadata, never upstream messages or content.
const issueCodes = new Set([
  "parse_error",
  "content_non_json",
  "risk_blocked",
  "unavailable",
  "captcha",
  "http_forbidden",
  "restricted",
  "budget_exhausted",
  "source_budget_exhausted",
  "rate_limited",
  "request_timeout",
  "http_timeout",
  "network_error",
  "tls_certificate_expired",
  "tls_hostname_mismatch",
  "invalid_record",
  "detail_unavailable",
  "detail_insufficient",
  "body_unverified",
  "list_unverified",
  "source_restricted",
  "pagination_not_supported",
  "account_history_limited",
  "login_required",
  "challenge_required",
  "session_unavailable",
  "boss_account_risk",
  "boss_environment_risk",
  "boss_risk_blocked",
  "boss_auth_expired",
  "boss_login_required",
  "boss_ajax_unavailable",
  "boss_transport_failed",
  "boss_response_invalid",
  "boss_rate_limited",
  "collection_browser_timeout",
  "collection_browser_output_limit",
  "collection_route_forbidden",
  "service_disabled",
  "not_configured",
  "candidate_not_verified",
  "source_probe_failed",
  "source_unavailable",
  "collection_page_issue",
  "pagination_cycle",
  "empty_evidence_unverified",
  "template_not_configured",
  "native_transport_contract_mismatch",
  "http_redirect_limit",
  "response_size_exceeded",
  "response_decode_failed",
  "unsupported_content_encoding",
  "detail_identity_mismatch",
  "detail_identity_unsupported",
  "detail_title_mismatch",
  "public_dns_unavailable",
  "public_dns_resolution_failed",
  "public_dns_no_answer",
  "public_dns_non_public",
  "public_dns_invalid_response",
]);
export const SOURCE_CONTRACT_STAGES = Object.freeze([
  "input", "response_identity", "response_size", "portal_identity", "asset_identity", "inline_parse",
  "config_shape", "config_identity", "token_shape", "anonymous_cookie", "token_cookie_mismatch",
]);
export const SOURCE_CONTRACT_REASONS = Object.freeze([
  "invalid_input", "unexpected_status", "unexpected_url", "invalid_body", "body_too_large", "title_mismatch",
  "asset_missing_or_duplicate", "javascript_syntax_invalid", "config_duplicate_or_dynamic",
  "property_missing_or_duplicate", "property_not_literal", "portal_config_mismatch", "token_invalid",
  "cookie_invalid_or_duplicate", "cookie_missing", "token_cookie_mismatch",
]);
export function safeSourceContractMetadata(value) {
  return {
    ...(SOURCE_CONTRACT_STAGES.includes(value?.contractStage) ? { contractStage: value.contractStage } : {}),
    ...(SOURCE_CONTRACT_REASONS.includes(value?.contractReason) ? { contractReason: value.contractReason } : {}),
    ...(value?.configurationReason === "public_seeds_required" || value?.code === "public_seeds_required"
      ? { configurationReason: "public_seeds_required" } : {}),
  };
}
export function isVersionPrivateSource(provider) {
  return (
    [
      "boss",
      "wechat",
      "weibo",
      "douyin",
      "weibo-official",
      "wechat-authorized",
    ].includes(provider?.id) ||
    ["social", "social_discovery"].includes(provider?.capabilities?.category)
  );
}
export function safeSourceDiagnosticRefs(value) {
  const refs = safeSourceContractMetadata(value);
  for (const [key, prefix] of [
    ["diagnosticId", "d"],
    ["requestId", "q"],
  ]) {
    if (
      typeof value?.[key] === "string" &&
      new RegExp(
        "^" +
          prefix +
          "-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
      ).test(value[key])
    )
      refs[key] = value[key];
  }
  return refs;
}
// Classify only structured facts. Upstream text is neither evidence of risk
// nor safe diagnostic metadata.
export function sourceIssueCode(error, fallback = "source_probe_failed") {
  if (error?.code === "CERT_HAS_EXPIRED") return "tls_certificate_expired";
  if (error?.code === "ERR_TLS_CERT_ALTNAME_INVALID") return "tls_hostname_mismatch";
  if (error?.code === "public_seeds_required") return "not_configured";
  if (issueCodes.has(error?.code)) return error.code;
  if (error?.name === "TimeoutError" || error?.code === "ETIMEDOUT")
    return "request_timeout";
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
    ].includes(error?.code)
  )
    return "network_error";
  if (error?.status === 429) return "rate_limited";
  if (error?.status === 401) return "login_required";
  if (error?.status === 403) return "restricted";
  if (error?.status === 408 || error?.status === 504) return "http_timeout";
  return issueCodes.has(fallback) ? fallback : "source_probe_failed";
}
export function safeSourceIssues(issues, sourceId, siteId) {
  return (Array.isArray(issues) ? issues : []).slice(0, 100).map((issue) => ({
    code: sourceIssueCode(issue),
    sourceId,
    siteId,
    ...(typeof issue?.retryable === "boolean"
      ? { retryable: issue.retryable }
      : {}),
    ...safeSourceDiagnosticRefs(issue),
  }));
}
export function normalizeSourceStatus({ status, issues = [] }) {
  if (status === "ready") return status;
  const codes = issues.map((i) => i?.code).filter(Boolean),
    failures = codes.filter(
      (code) => !["body_unverified", "list_unverified"].includes(code),
    );
  if (
    failures.length &&
    failures.every((code) =>
      ["budget_exhausted", "source_budget_exhausted"].includes(code),
    )
  )
    return "budget_exhausted";
  if (
    codes.some((code) =>
      [
        "restricted",
        "source_restricted",
        "captcha",
        "http_forbidden",
        "login_required",
        "challenge_required",
        "risk_blocked",
        "boss_account_risk",
        "boss_environment_risk",
        "boss_risk_blocked",
        "boss_auth_expired",
        "boss_login_required",
      ].includes(code),
    )
  )
    return "restricted";
  if (codes.includes("content_non_json")) return "unavailable";
  if (codes.includes("parse_error")) return "parse_error";
  if (failures.length && failures.every(code => ["not_configured", "public_seeds_required"].includes(code)))
    return "not_configured";
  if (
    failures.some(
      (code) =>
        ![
          "not_configured",
          "candidate_not_verified",
          "template_not_configured",
          "service_disabled",
        ].includes(code),
    )
  )
    return "unavailable";
  if (failures.length) return "skipped";
  return status;
}
