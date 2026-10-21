import test from "node:test";
import assert from "node:assert/strict";
import { sourceIssue } from "../../src/sources/adapters/legacy.mjs";
import { safeSourceIssues } from "../../src/sources/source-status.mjs";

test("legacy source issues preserve structured timeout, parse and detail failure codes", () => {
  for (const code of [
    "request_timeout",
    "detail_insufficient",
    "parse_error",
    "source_budget_exhausted",
    "challenge_required",
    "http_redirect_limit",
    "response_size_exceeded",
    "response_decode_failed",
    "unsupported_content_encoding",
    "detail_identity_mismatch",
    "detail_title_mismatch",
  ]) {
    const issue = sourceIssue(
      Object.assign(Error("upstream failure"), { code }),
      "university",
      "school",
    );
    assert.equal(issue.code, code);
    assert.equal(
      safeSourceIssues([issue], "university", "school")[0].code,
      code,
    );
  }
});
test("timeout and transport failures are distinguished without assuming caller cancellation", () => {
  assert.equal(
    sourceIssue(
      Object.assign(Error("upstream failure"), { name: "TimeoutError" }),
      "university",
      "school",
    ).code,
    "request_timeout",
  );
  assert.equal(
    sourceIssue(
      Object.assign(Error("upstream failure"), { code: "ETIMEDOUT" }),
      "university",
      "school",
    ).code,
    "request_timeout",
  );
  assert.equal(
    sourceIssue(
      Object.assign(Error("upstream failure"), { code: "ECONNRESET" }),
      "university",
      "school",
    ).code,
    "network_error",
  );
  assert.equal(
    sourceIssue(
      Object.assign(Error("upstream failure"), { code: "CERT_HAS_EXPIRED" }),
      "university",
      "school",
    ).code,
    "network_error",
  );
  assert.notEqual(
    sourceIssue(
      Object.assign(Error("upstream failure"), { code: "ABORT_ERR" }),
      "university",
      "school",
    ).code,
    "request_cancelled",
  );
});
test("unknown error codes do not enter persisted public issue metadata", () => {
  const issue = sourceIssue(
    Object.assign(Error("unavailable"), { code: "secret-credential-value" }),
    "university",
    "school",
  );
  assert.equal(issue.code, "unavailable");
  assert.deepEqual(safeSourceIssues([issue], "university", "school")[0], {
    code: "unavailable",
    sourceId: "university",
    siteId: "school",
    retryable: true,
  });
});
