import { contentHash } from "../infrastructure/storage/repository.mjs";
export function evaluationCacheKey({
  jdHash,
  profileRevisionId,
  targetRevisionId,
  promptVersion,
  ruleVersion,
  modelFingerprint,
}) {
  return contentHash({
    jdHash,
    profileRevisionId,
    targetRevisionId,
    promptVersion,
    ruleVersion,
    modelFingerprint,
  });
}
export function validateModelResults(raw, { records }) {
  const known = new Map(records.map((r) => [r.jobId, r])),
    valid = [],
    invalidIds = new Set(),
    issues = [],
    validationCounts = {};
  const countReason = (reason) =>
    (validationCounts[reason] = (validationCounts[reason] || 0) + 1);
  if (!Array.isArray(raw?.results)) countReason("invalid_results_shape");
  const rows = Array.isArray(raw?.results) ? raw.results : [],
    counts = new Map();
  for (const row of rows)
    if (row && typeof row.jobId === "string")
      counts.set(row.jobId, (counts.get(row.jobId) || 0) + 1);
  for (const row of rows) {
    if (!row || !known.has(row.jobId)) {
      countReason("unknown_id");
      // An unknown identifier is untrusted model output, not a known job reference.
      issues.push({ code: "unknown_model_job_id", jobId: null });
      continue;
    }
    if (invalidIds.has(row.jobId)) continue;
    const record = known.get(row.jobId),
      source = [record.title, record.description].filter(Boolean).join("\n");
    const strings = (value) =>
      Array.isArray(value) &&
      value.every((s) => typeof s === "string" && s.length <= 2000);
    const reasons = [];
    if (counts.get(row.jobId) !== 1) reasons.push("duplicate_id");
    if (!Number.isFinite(row.score) || row.score < 0 || row.score > 100)
      reasons.push("invalid_score");
    if (!strings(row.reasons)) reasons.push("invalid_reasons");
    if (!strings(row.gaps)) reasons.push("invalid_gaps");
    if (
      row.evidence == null ||
      (Array.isArray(row.evidence) && !row.evidence.length)
    )
      reasons.push("missing_evidence");
    else if (
      !Array.isArray(row.evidence) ||
      !row.evidence.every(
        (e) => e && typeof e.excerpt === "string" && e.excerpt.trim(),
      )
    )
      reasons.push("invalid_evidence");
    else if (!row.evidence.every((e) => source.includes(e.excerpt)))
      reasons.push("evidence_not_in_source");
    if (reasons.length) {
      invalidIds.add(row.jobId);
      for (const reason of reasons) countReason(reason);
      issues.push({ code: "invalid_model_result", jobId: row.jobId, reasons });
      continue;
    }
    valid.push(row);
  }
  const validIds = new Set(valid.map((v) => v.jobId));
  const missingIds = records
    .filter((r) => !validIds.has(r.jobId) && !invalidIds.has(r.jobId))
    .map((r) => r.jobId);
  if (missingIds.length) validationCounts.missing_result = missingIds.length;
  return {
    valid,
    invalidIds: [...invalidIds],
    missingIds,
    issues,
    validationCounts,
  };
}
