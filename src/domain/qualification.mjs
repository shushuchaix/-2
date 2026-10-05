import { clauseAt, isSoftRequirement } from "../match/requirements.mjs";
import { termEvidence } from "./skills.mjs";
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
export function evaluateQualification(record, profile, target = {}) {
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
      ...knownCertificates.filter((c) => termEvidence(text, c).length),
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
