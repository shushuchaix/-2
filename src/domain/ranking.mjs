import { RANKING_POLICY as config, RULE_VERSION } from "./ranking-policy.mjs";
import { evaluateQualification } from "./qualification.mjs";
import { findSkillEvidence, termEvidence, majorRoleFit } from "./skills.mjs";
import {
  assessRecruitmentEvidence,
  isVerifiedRecommendation,
} from "./recruitment-evidence.mjs";
export { RULE_VERSION };
export function evaluateRules(record, profile, target = {}, options = {}) {
  const qualification = evaluateQualification(record, profile, target, {
      now: options.now,
    }),
    description = String(record.description || ""),
    text = [record.title, description].join("\n"),
    skills = (profile.skills || [])
      .map((s) => (typeof s === "string" ? s : s.name))
      .filter(Boolean),
    evidence = findSkillEvidence(text, skills).filter(
      (e) => e.relation !== "related",
    );
  const matched = new Set(evidence.map((e) => e.skillId));
  const roles = target.roles || profile.targetRoles || [];
  const roleEvidence = roles.flatMap((role) =>
    termEvidence(record.title, role).map((e) => ({ ...e, role })),
  );
  const bodyRole = roles.some((role) => termEvidence(description, role).length);
  const major = majorRoleFit(profile, record);
  const cities =
    target.cityMode === "any"
      ? []
      : target.cityMode === "from_profile"
        ? profile.cities || profile.preferredCities || []
        : target.cities || [];
  const cityMatch =
    !cities.length ||
    record.cities?.some((c) =>
      cities.some((city) => c.includes(city) || city.includes(c)),
    );
  const components = {
    role: {
      score: roleEvidence.length
        ? config.weights.role
        : bodyRole
          ? Math.round((config.weights.role * 14) / 22)
          : 0,
      max: config.weights.role,
      evidence: roleEvidence,
    },
    skills: {
      score: Math.min(
        config.weights.skills,
        Math.round(
          (matched.size / Math.max(1, new Set(skills).size)) *
            config.weights.skills,
        ),
      ),
      max: config.weights.skills,
      evidence,
    },
    city: {
      score: cityMatch
        ? config.weights.city
        : record.cities?.length
          ? Math.round((config.weights.city * 3) / 15)
          : Math.round((config.weights.city * 8) / 15),
      max: config.weights.city,
      evidence: record.cities || [],
    },
    major: {
      score: major.status === "matched" ? config.weights.major : 0,
      max: config.weights.major,
      evidence: major.reasons,
    },
    eligibility: {
      score:
        qualification.status === "pass"
          ? config.weights.eligibility
          : qualification.status === "unknown"
            ? Math.round((config.weights.eligibility * 4) / 10)
            : 0,
      max: config.weights.eligibility,
      evidence: qualification.checks,
    },
  };
  let score = Math.min(
    100,
    Object.values(components).reduce((sum, c) => sum + c.score, 0),
  );
  if (qualification.status === "fail") score = Math.min(score, 49);
  const fields = {
    title: !!record.title,
    company: !!record.company,
    cities: !!record.cities?.length,
    description: description.trim().length >= config.minimumJdCharacters,
    url: !!record.url,
  };
  const completeness = {
    score:
      (fields.title ? 15 : 0) +
      (fields.company ? 10 : 0) +
      (fields.cities ? 10 : 0) +
      (fields.description ? 50 : 0) +
      (fields.url ? 15 : 0),
    fields,
    missing: Object.keys(fields).filter((k) => !fields[k]),
  };
  const insufficient = !fields.description || record.kind !== "job";
  const recruitmentEvidence = assessRecruitmentEvidence({
      record,
      now: options.now,
    }),
    verified = isVerifiedRecommendation({
      qualification,
      evidence: recruitmentEvidence,
    });
  const recommendation =
    qualification.status === "fail"
      ? "not_recommended"
      : insufficient || !verified
        ? "insufficient"
        : score >= config.thresholds.high && qualification.status === "pass"
          ? "high"
          : score >= config.thresholds.consider
            ? "consider"
            : "low";
  return {
    qualification,
    recruitmentEvidence,
    recommended: verified,
    score,
    ruleScore: score,
    components,
    evidence,
    gaps: qualification.checks
      .filter((c) => c.status !== "pass" && c.required !== false)
      .map((c) => c.reason),
    completeness,
    status: "rules",
    recommendation,
    ruleVersion: options.ruleVersion || RULE_VERSION,
  };
}
