import { createHash } from "node:crypto";
import { CONDITIONS_PARSER_VERSION } from "../domain/recruitment-evidence.mjs";

// Map an explicit public source field. Codes and ambiguous qualifiers remain unknown.
export function withMajorEvidence(record, rawMajor, { sourceField, location }) {
  if (rawMajor == null || String(rawMajor).trim() === "") return record;
  const excerpt =
    typeof rawMajor === "string" ? rawMajor.trim() : JSON.stringify(rawMajor);
  const unrestricted = /^(?:不限(?:专业)?|专业不限|无专业限制)$/.test(excerpt);
  const preferred = /优先$/.test(excerpt);
  const values = excerpt
    .replace(/(?:专业)?(?:者)?优先$/, "")
    .split(/、|，|,|\/|／|或|以及/)
    .map((v) => v.trim().replace(/专业$/, ""))
    .filter(Boolean);
  const literal =
    typeof rawMajor === "string" &&
    values.length > 0 &&
    values.every(
      (v) =>
        /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z\s·-]{1,80}$/u.test(v) &&
        !/相关|相近|类|详见|见|等|不限|任意|限制|无要求|要求|须|必须|不接受|除外|优先/.test(
          v,
        ),
    );
  const sourceId = record.sourceId || record.source;
  const prefix = sourceId === "university-91job" ? "91job" : sourceId;
  const evidenceId =
    prefix +
    "-major-" +
    createHash("sha256")
      .update([record.siteId, record.sourceRecordId, excerpt].join("|"))
      .digest("hex")
      .slice(0, 24);
  const previousIds = new Set(
    (record.sourceEvidence || [])
      .filter((e) => e.field === "major" && e.sourceField === sourceField)
      .map((e) => e.evidenceId),
  );
  return {
    ...record,
    conditions: [
      ...(record.conditions || []).filter(
        (c) =>
          c.sourceField !== sourceField &&
          !(c.evidenceRefs || []).some((id) => previousIds.has(id)),
      ),
      {
        type: "major",
        origin: "structured_source",
        conditionsParserVersion: CONDITIONS_PARSER_VERSION,
        sourceField,
        operator: "any",
        values,
        required: !unrestricted && !preferred,
        preferred,
        evidenceRefs: [evidenceId],
      },
    ],
    sourceEvidence: [
      ...(record.sourceEvidence || []).filter(
        (e) => !previousIds.has(e.evidenceId),
      ),
      {
        evidenceId,
        origin: "structured_source",
        field: "major",
        sourceField,
        value: values,
        sourceId,
        sourceUrl: record.url,
        sourceKind: "structured_source",
        sourceExcerpt: excerpt,
        location,
        parserVersion: record.parserVersion,
        status: literal || unrestricted ? "verified" : "unknown",
        confidence: 100,
      },
    ],
  };
}
