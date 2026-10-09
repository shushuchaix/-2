import { clauseAt, isSoftRequirement } from "../match/requirements.mjs";
import { termEvidence } from "./skills.mjs";
import { extractRecruitmentConditions } from "./recruitment-evidence.mjs";
const degrees = [
  ["博士", 5],
  ["PhD", 5],
  ["硕士", 4],
  ["研究生", 4],
  ["master", 4],
  ["本科", 3],
  ["学士", 3],
  ["bachelor", 3],
  ["大专", 2],
  ["专科", 2],
  ["高中", 1],
  ["中专", 1],
];
export function degreeRank(value) {
  const text = String(value || "");
  if (/学历不限|不限学历/.test(text)) return 0;
  const ranks = degrees
    .filter(([name]) => text.toLowerCase().includes(name.toLowerCase()))
    .map(([, rank]) => rank);
  return ranks.length ? Math.min(...ranks) : null;
}
const knownCertificates = [
  "注册消防工程师",
  "注册安全工程师",
  "法律职业资格",
  "初级会计",
  "CPA",
  "ACCA",
  "CET-6",
  "CET-4",
  "英语六级",
  "英语四级",
];
const check = (type, status, requirement, evidence, reason, extra = {}) => ({
  type,
  status,
  requirement,
  evidence: evidence ? { excerpt: evidence } : null,
  reason,
  ...extra,
});
function evaluateLegacyQualification(record, profile, target = {}) {
  const text = String(record.description || ""),
    checks = [];
  if (record.kind !== "job" || !text.trim())
    return {
      status: "unknown",
      checks: [
        check(
          "record",
          "unknown",
          null,
          null,
          "公告或缺少岗位正文，资格需核实",
        ),
      ],
    };
  const degreeText =
    record.degree ||
    record.education ||
    clauseAt(
      text,
      text.search(
        /博士|硕士|研究生|本科|学士|大专|专科|学历不限|bachelor|master|PhD/i,
      ),
      2,
    );
  const required = degreeRank(degreeText),
    own = degreeRank(profile.education || profile.degree),
    soft =
      !!degreeText &&
      isSoftRequirement(
        text.includes(degreeText) ? text : degreeText,
        degreeText,
      );
  if (required !== null) {
    const status = soft
      ? "pass"
      : required === 0
        ? "pass"
        : own === null
          ? "unknown"
          : own >= required
            ? "pass"
            : "fail";
    checks.push(
      check(
        "degree",
        status,
        degreeText,
        degreeText,
        soft ? "学历优先条件" : "比较岗位接受的最低学历与已确认学历",
        { preferred: soft, required: !soft },
      ),
    );
  } else
    checks.push(
      check("degree", "unknown", null, null, "岗位未说明学历", {
        required: false,
      }),
    );
  if (target.degreePolicy === "minimum_requirement") {
    const floor = degreeRank(
      target.minDegree || profile.education || profile.degree,
    );
    checks.push(
      check(
        "degree_policy",
        required === null || floor === null
          ? "unknown"
          : required >= floor || required === 0
            ? "pass"
            : "fail",
        target.minDegree || profile.education,
        degreeText,
        "用户设置岗位学历要求下限",
        { required: true },
      ),
    );
  }
  const range = text.match(
    /(20\d{2})\s*(?:年)?\s*[-—~～至到]\s*(20\d{2})\s*(?:年)?\s*届/,
  );
  const yearMatches = [...text.matchAll(/(20\d{2})\s*(?:年)?\s*届/g)];
  let accepted = range
    ? Array.from(
        {
          length: Math.min(
            20,
            Math.max(0, Number(range[2]) - Number(range[1]) + 1),
          ),
        },
        (_, i) => Number(range[1]) + i,
      )
    : yearMatches.map((m) => Number(m[1]));
  if (!accepted.length && record.graduationYear)
    accepted = [Number(record.graduationYear)];
  if (accepted.length) {
    const year = Number(profile.graduationYear);
    checks.push(
      check(
        "graduation_year",
        year ? (accepted.includes(year) ? "pass" : "fail") : "unknown",
        accepted,
        range?.[0] ||
          yearMatches.map((m) => m[0]).join("、") ||
          String(record.graduationYear),
        "比较明确接受的毕业年份",
        { required: true },
      ),
    );
  }
  const types = target.jobTypes || [];
  if (types.length) {
    checks.push(
      check(
        "job_type",
        !record.jobType || record.jobType === "unknown"
          ? "unknown"
          : types.includes(record.jobType)
            ? "pass"
            : "fail",
        types,
        record.jobType,
        "与目标岗位类型比较",
        { required: true },
      ),
    );
  }
  const experienceText = [text, record.experience].filter(Boolean).join("\n");
  const exp = experienceText.match(
    /(\d+(?:\.\d+)?)\s*(?:[-至~]\s*\d+)?\s*年(?:以上)?(?:的)?(?:工作|相关|行业|开发)?经验/,
  );
  if (exp) {
    const preferred = isSoftRequirement(experienceText, exp[0]);
    const years = profile.experienceYears;
    checks.push(
      check(
        "experience",
        preferred
          ? "pass"
          : years == null
            ? "unknown"
            : Number(years) >= Number(exp[1])
              ? "pass"
              : "fail",
        Number(exp[1]),
        clauseAt(experienceText, exp.index, exp[0].length),
        preferred ? "经验优先条件" : "实习/项目不能自动视为正式工作年限",
        { preferred, required: !preferred },
      ),
    );
  }
  const certificates = [
    ...new Set([
      ...(record.requiredCertificates || [])
        .map((c) => (typeof c === "string" ? c : c.name))
        .filter(Boolean),
      // Certificate text is handled by evidence-aware conditions below.
    ]),
  ];
  for (const name of certificates) {
    const occurrence = termEvidence(text, name)[0];
    const evidence = occurrence
      ? clauseAt(text, occurrence.start, occurrence.end - occurrence.start)
      : name;
    const preferred = occurrence ? isSoftRequirement(text, name) : false;
    const has = (profile.certificates || []).some((c) =>
      String(typeof c === "string" ? c : c.name).includes(name),
    );
    const confirmed =
      profile.explicitFacts?.certificates === true ||
      profile.explicitFacts?.certificates?.confirmed === true;
    const status = has
      ? "pass"
      : preferred
        ? "pass"
        : confirmed
          ? "fail"
          : "unknown";
    checks.push(
      check(
        "certificate",
        status,
        name,
        evidence,
        has
          ? "已确认持有"
          : preferred
            ? "证书优先，不构成淘汰门槛"
            : confirmed
              ? "已确认未持有必需证书"
              : "简历未提及不等于没有，需确认",
        { preferred, required: !preferred },
      ),
    );
  }
  const relevant = checks.filter((c) => c.required !== false && !c.preferred);
  return {
    status: relevant.some((c) => c.status === "fail")
      ? "fail"
      : relevant.some((c) => c.status === "unknown") || !relevant.length
        ? "unknown"
        : "pass",
    checks,
  };
}
export function evaluateEvidenceQualification({
  profileSnapshot: profile,
  conditions = [],
  sourceEvidence = [],
  now = Date.now(),
}) {
  const checks = conditions.map((c) => {
    const evidence = (c.evidenceRefs || []).map((id) =>
      sourceEvidence.find((e) => e.evidenceId === id),
    );
    const supported =
      evidence.length > 0 &&
      evidence.every(
        (e) =>
          e?.status === "verified" &&
          e.sourceExcerpt &&
          !(e.confidence < 85) &&
          !e.ambiguous &&
          (!c.jobRowId ||
            e.appliesTo?.jobRowId === c.jobRowId ||
            e.appliesTo?.sharedCondition === true),
      );
    let status =
      c.preferred || c.required === false
        ? "pass"
        : !supported
          ? "unknown"
          : null;
    if (!status) {
      const values = c.values || [];
      if (c.type === "major") {
        const own = String(profile.major || "").normalize("NFKC");
        status = !own
          ? "unknown"
          : values.some((v) => own === String(v).normalize("NFKC"))
            ? "pass"
            : "fail";
      } else if (c.type === "certificate") {
        const certificates = (profile.certificates || []).map((v) =>
            typeof v === "string" ? { name: v } : v,
          ),
          confirmed =
            profile.explicitFacts?.certificates === true ||
            profile.explicitFacts?.certificates?.confirmed === true;
        const own = certificates.find(
          (v) =>
            values.some((name) => String(v.name || "").includes(name)) &&
            (!c.grade ||
              String(v.name || "").includes(c.grade) ||
              v.grade === c.grade),
        );
        status = !own
          ? confirmed
            ? "fail"
            : "unknown"
          : c.registrationRequired
            ? !own.registrationValidUntil
              ? "unknown"
              : Date.parse(own.registrationValidUntil) < Number(now)
                ? "fail"
                : Number.isFinite(Date.parse(own.registrationValidUntil))
                  ? "pass"
                  : "unknown"
            : "pass";
      } else if (c.type === "formal_experience") {
        const years = profile.formalExperienceYears ?? profile.experienceYears;
        status =
          years == null
            ? "unknown"
            : Number(years) >= Number(values[0])
              ? "pass"
              : "fail";
      } else if (c.type === "age") {
        let age = profile.age;
        if (
          age == null &&
          profile.birthDate &&
          Number.isFinite(Date.parse(profile.birthDate))
        ) {
          const birth = new Date(profile.birthDate),
            today = new Date(now);
          age =
            today.getUTCFullYear() -
            birth.getUTCFullYear() -
            (today.toISOString().slice(5, 10) < birth.toISOString().slice(5, 10)
              ? 1
              : 0);
        }
        status =
          age == null
            ? "unknown"
            : Number(age) <= Number(values[0])
              ? "pass"
              : "fail";
      } else if (c.type === "physical")
        status =
          profile.explicitFacts?.physicalQualified === true
            ? "pass"
            : profile.explicitFacts?.physicalQualified === false
              ? "fail"
              : "unknown";
      else status = "unknown";
    }
    return check(
      c.type,
      status,
      c.values,
      evidence
        .filter(Boolean)
        .map((e) => e.sourceExcerpt)
        .join("\n"),
      !supported
        ? "条件证据不完整或未确认对应岗位行"
        : c.preferred
          ? "优先条件，不是淘汰门槛"
          : "按明确岗位条件与本版本确认事实比较",
      {
        required: c.required !== false,
        preferred: c.preferred === true,
        evidenceRefs: c.evidenceRefs || [],
      },
    );
  });
  const required = checks.filter((c) => c.required && !c.preferred);
  return {
    status: required.some((c) => c.status === "fail")
      ? "fail"
      : required.some((c) => c.status === "unknown")
        ? "unknown"
        : "pass",
    checks,
  };
}
export function evaluateQualification(
  record,
  profile,
  target = {},
  options = {},
) {
  const extracted = extractRecruitmentConditions(record),
    legacy = evaluateLegacyQualification(
      { ...record, requiredCertificates: [] },
      profile,
      target,
    );
  const conditions = record.conditions?.length
    ? record.conditions
    : extracted.conditions;
  const checked = evaluateEvidenceQualification({
    profileSnapshot: profile,
    conditions,
    sourceEvidence: [
      ...(record.sourceEvidence || []),
      ...extracted.sourceEvidence,
    ],
    now: options.now,
  });
  const checks = [...legacy.checks, ...checked.checks],
    required = checks.filter((c) => c.required !== false && !c.preferred);
  return {
    status: required.some((c) => c.status === "fail")
      ? "fail"
      : required.some((c) => c.status === "unknown") || !required.length
        ? "unknown"
        : "pass",
    checks,
  };
}
