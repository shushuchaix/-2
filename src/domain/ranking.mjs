import fs from "node:fs";
import { evaluateQualification } from "./qualification.mjs";
import { findSkillEvidence, termEvidence, majorRoleFit } from "./skills.mjs";
import {
  assessRecruitmentEvidence,
  isVerifiedRecommendation,
} from "./recruitment-evidence.mjs";
const config = JSON.parse(
  fs.readFileSync(new URL("./ranking-config.json", import.meta.url), "utf8"),
);
export const RULE_VERSION = config.ruleVersion;
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
      score: roleEvidence.length ? 22 : bodyRole ? 14 : 0,
      max: 22,
      evidence: roleEvidence,
    },
    skills: {
      score: Math.min(
        45,
        Math.round((matched.size / Math.max(1, new Set(skills).size)) * 45),
      ),
      max: 45,
      evidence,
    },
    city: {
      score: cityMatch ? 15 : record.cities?.length ? 3 : 8,
      max: 15,
      evidence: record.cities || [],
    },
    major: {
      score: major.status === "matched" ? 8 : 0,
      max: 8,
      evidence: major.reasons,
    },
    eligibility: {
      score:
        qualification.status === "pass"
          ? 10
          : qualification.status === "unknown"
            ? 4
            : 0,
      max: 10,
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
