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
  "detail_title_mismatch",
  "public_dns_unavailable",
  "public_dns_resolution_failed",
  "public_dns_no_answer",
  "public_dns_non_public",
  "public_dns_invalid_response",
]);
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
export function safeSourceIssues(issues, sourceId, siteId) {
  return (Array.isArray(issues) ? issues : []).slice(0, 100).map((issue) => ({
    code: issueCodes.has(issue?.code) ? issue.code : "source_probe_failed",
    sourceId,
    siteId,
    ...(typeof issue?.retryable === "boolean"
      ? { retryable: issue.retryable }
      : {}),
    ...(typeof issue?.diagnosticId === "string" &&
    /^d-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      issue.diagnosticId,
    )
      ? { diagnosticId: issue.diagnosticId }
      : {}),
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
