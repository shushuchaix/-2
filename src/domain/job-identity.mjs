import { createHash } from "node:crypto";
import {
  conditionIdentity,
  recruitmentConflicts,
  sharedVerifiedJobLocator,
} from "./recruitment-fact-primitives.mjs";
export const identityText = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
export const identityCities = (r) =>
  [
    ...new Set(
      (r.cities || [r.city])
        .filter(Boolean)
        .map((x) => identityText(x).replace(/市$/u, ""))
        .filter((x) => !["全国", "不限", "远程"].includes(x)),
    ),
  ].sort();
export const stableIdentityValue = (value) =>
  Array.isArray(value)
    ? value.map(stableIdentityValue)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stableIdentityValue(value[k])]),
        )
      : value;
const businessFields = [
  "kind",
  "title",
  "company",
  "cities",
  "jobType",
  "graduationYear",
  "cohort",
  "batch",
  "recruitmentBatch",
  "recruitmentYear",
  "level",
  "degree",
  "experience",
  "requiredCertificates",
  "workMode",
  "employmentMode",
  "contractType",
  "major",
  "majorRequired",
  "requirements",
  "description",
  "publishedAt",
  "deadlineAt",
  "salary",
  "account",
  "platform",
];
export function jobBusinessContent(r) {
  return {
    ...Object.fromEntries(businessFields.map((k) => [k, r[k] ?? null])),
    conditions: (r.conditions || []).map(conditionIdentity),
  };
}
export function jobBusinessFingerprint(r) {
  return createHash("sha256")
    .update(JSON.stringify(stableIdentityValue(jobBusinessContent(r))))
    .digest("hex");
}
export function canonicalizeSourceUrl(value, policy = {}) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("Invalid job url");
  for (const key of [...u.searchParams.keys()])
    if (/^utm_/i.test(key) || (policy.trackingParams || []).includes(key))
      u.searchParams.delete(key);
  u.searchParams.sort();
  if (policy.preserveHash === false) u.hash = "";
  return u.href;
}
export const identitySource = (r) => r.sourceId || r.source || "unknown";
export const identityScope = (r) =>
  r.identityScope || r.siteId || identitySource(r);
export const isKnownIdentityValue = (v) =>
  v !== null && v !== undefined && v !== "" && v !== "unknown";
const batch = (r) => r.batch || r.recruitmentBatch || r.extra?.batch || null;
const year = (r) =>
  r.recruitmentYear ||
  (r.publishedAt && /^\d{4}/.test(r.publishedAt)
    ? String(r.publishedAt).slice(0, 4)
    : null);
const level = (r) =>
  r.level ||
  String(r.title || "").match(
    /高级|资深|初级|中级|实习|(?:^|[^A-Za-z])([PMLT][0-9]{1,2})(?:$|[^0-9A-Za-z])/u,
  )?.[0] ||
  null;
const certificates = (r) =>
  [
    ...new Set(
      (r.requiredCertificates || []).map((x) =>
        identityText(typeof x === "string" ? x : x.name),
      ),
    ),
  ].sort();
function substantive(r) {
  const text = String(r.description || "").trim();
  return (
    text.length >= 30 &&
    !/^(?:点击|请点击|详情请|登录后|招聘信息|岗位详情|欢迎加入|公司招聘|请填写|暂无|待补充|验证码|人机验证)/u.test(
      text,
    ) &&
    /职责|负责|要求|学历|本科|硕士|经验|证书|毕业|专业|资格|任职|工作内容|responsibilit|qualification|requirement|degree|experience/i.test(
      text,
    )
  );
}
function similarity(a, b) {
  const grams = (s) =>
      new Set([...s].slice(1).map((_, i) => s.slice(i, i + 2))),
    x = grams(a),
    y = grams(b);
  const common = [...x].filter((g) => y.has(g)).length;
  return common / Math.max(1, x.size + y.size - common);
}
export function classifyJobDuplicate(
  left,
  right,
  { leftProvenance = left, rightProvenance = right } = {},
) {
  const evidenceConflicts = recruitmentConflicts(left, right);
  const conflicts = [];
  for (const [field, a, b] of [
    ["kind", left.kind, right.kind],
    ["company", left.company, right.company],
    [
      "cohort",
      left.graduationYear || left.cohort,
      right.graduationYear || right.cohort,
    ],
    ["batch", batch(left), batch(right)],
    ["year", year(left), year(right)],
    ["job_type", left.jobType, right.jobType],
    ["level", level(left), level(right)],
    ["degree", left.degree, right.degree],
    ["experience", left.experience, right.experience],
    ["work_mode", left.workMode, right.workMode],
  ])
    if (
      isKnownIdentityValue(a) &&
      isKnownIdentityValue(b) &&
      identityText(a) !== identityText(b)
    )
      conflicts.push("different_" + field);
  const aCities = identityCities(left),
    bCities = identityCities(right);
  if (
    aCities.length &&
    bCities.length &&
    JSON.stringify(aCities) !== JSON.stringify(bCities)
  )
    conflicts.push("different_cities");
  // Missing certificates are unknown, not an explicit contradictory requirement.
  const authorityA =
    leftProvenance.sourceRecordIdKind === "authority" &&
    isKnownIdentityValue(left.sourceRecordId);
  const authorityB =
    rightProvenance.sourceRecordIdKind === "authority" &&
    isKnownIdentityValue(right.sourceRecordId);
  const sameAuthorityScope =
    authorityA &&
    authorityB &&
    identitySource(left) === identitySource(right) &&
    identityScope(left) === identityScope(right);
  if (
    sameAuthorityScope &&
    String(left.sourceRecordId) !== String(right.sourceRecordId)
  )
    conflicts.push("different_recruitment_ids");
  const company = identityText(left.company),
    title = identityText(left.title),
    rightTitle = identityText(right.title);
  if (title && rightTitle && title !== rightTitle)
    conflicts.push("different_title");
  if (conflicts.length) {
    const fuzzy =
      conflicts.length === 1 &&
      conflicts[0] === "different_title" &&
      company &&
      company === identityText(right.company) &&
      similarity(title, rightTitle) >= 0.82;
    return {
      relation: fuzzy ? "possible" : "distinct",
      reasonCodes: fuzzy ? ["similar_company_title"] : conflicts,
    };
  }
  if (evidenceConflicts.length)
    return {
      relation: evidenceConflicts.some((c) => c.decision === "distinct")
        ? "distinct"
        : "possible",
      reasonCodes: evidenceConflicts.map((c) => c.code),
    };
  const fieldsMatch =
    company &&
    company === identityText(right.company) &&
    title &&
    title === rightTitle;
  const sameAuthority =
    sameAuthorityScope &&
    String(left.sourceRecordId) === String(right.sourceRecordId);
  let specificUrl = false;
  const specificKinds =
    left.kind === "recruitment_notice"
      ? ["notice_detail"]
      : ["job_detail", "job_apply"];
  if (
    fieldsMatch &&
    specificKinds.includes(leftProvenance.urlKind) &&
    specificKinds.includes(rightProvenance.urlKind)
  )
    try {
      // urlKind describes only the primary source URL. A separate application
      // form has no specificity proof and cannot inherit the detail URL's role.
      specificUrl =
        canonicalizeSourceUrl(left.url, left.urlPolicy) ===
        canonicalizeSourceUrl(right.url, right.urlPolicy);
    } catch {
      /* invalid URL is not proof */
    }
  if (
    sameAuthority &&
    (!company ||
      !identityText(right.company) ||
      company === identityText(right.company)) &&
    (!title || !rightTitle || title === rightTitle)
  )
    return { relation: "confirmed", reasonCodes: ["authority_id"] };
  if (fieldsMatch && specificUrl)
    return { relation: "confirmed", reasonCodes: ["specific_job_url"] };
  if (fieldsMatch && sharedVerifiedJobLocator(left, right))
    return { relation: "confirmed", reasonCodes: ["verified_job_locator"] };
  const exactBusiness =
    jobBusinessFingerprint(left) === jobBusinessFingerprint(right);
  const manual =
    identitySource(left) === "manual" &&
    identitySource(right) === "manual" &&
    !left.url &&
    !right.url;
  if (
    exactBusiness &&
    substantive(left) &&
    (manual ||
      (fieldsMatch && aCities.length && isKnownIdentityValue(left.jobType)))
  )
    return {
      relation: "confirmed",
      reasonCodes: [
        manual ? "identical_manual_input" : "identical_complete_content",
      ],
    };
  if (fieldsMatch || (manual && exactBusiness))
    return {
      relation: "possible",
      reasonCodes: ["insufficient_identity_evidence"],
    };
  return {
    relation: "distinct",
    reasonCodes: ["insufficient_identity_evidence"],
  };
}
