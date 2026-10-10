import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { clauseAt, isSoftRequirement } from "../match/requirements.mjs";
const digest = (v) =>
  createHash("sha256")
    .update(String(v || ""))
    .digest("hex");
const time = (v) => {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
const literal = (text, value) =>
  typeof value === "string" && !!value && text.includes(value);
export function assessApplicationResponse(response, checkedAt) {
  const text = String(response.text || ""),
    challenge = /验证码|人机验证|访问过于频繁|captcha|验证后访问/i.test(
      text.slice(0, 3000),
    );
  let formVerified = false,
    loginRequired = false;
  if (response.status === 200 && !challenge) {
    const { document } = parseHTML(text);
    for (const n of document.querySelectorAll(
      'script,style,[hidden],[aria-hidden="true"]',
    ))
      n.remove();
    loginRequired =
      !!document.querySelector('input[type="password"]') ||
      /请先登录|登录后(?:报名|投递|申请)/.test(
        document.documentElement.textContent,
      );
    formVerified =
      !loginRequired &&
      [...document.querySelectorAll("form")].some(
        (form) =>
          !/display\s*:\s*none|visibility\s*:\s*hidden/i.test(
            form.getAttribute("style") || "",
          ) && /投递|报名|应聘|申请职位|提交申请/.test(form.textContent),
      );
  }
  return {
    status: loginRequired ? "login_required" : response.status,
    checkedAt,
    challenge,
    formVerified,
  };
}
export function readJobPostingEvidence(html, record) {
  const { document } = parseHTML(html),
    facts = [],
    conflicts = [],
    visible = String(record.description || "");
  for (const node of [
    ...document.querySelectorAll('script[type="application/ld+json"]'),
  ].slice(0, 20)) {
    if (node.textContent.length > 65536) continue;
    let parsed;
    try {
      parsed = JSON.parse(node.textContent);
    } catch {
      continue;
    }
    const nodes = Array.isArray(parsed)
      ? parsed
      : parsed?.["@graph"] || [parsed];
    if (!Array.isArray(nodes)) continue;
    for (const p of nodes.slice(0, 100)) {
      if (
        p?.["@type"] !== "JobPosting" ||
        typeof p.title !== "string" ||
        (!visible.includes(p.title) && record.title !== p.title)
      )
        continue;
      const values = {
        title: p.title,
        company: p.hiringOrganization?.name,
        degree:
          typeof p.educationRequirements === "string"
            ? p.educationRequirements
            : null,
        deadlineAt: p.validThrough,
      };
      for (const [field, value] of Object.entries(values)) {
        if (typeof value !== "string" || !value) continue;
        const verified =
          visible.includes(value) ||
          (field === "title" && record.title === value) ||
          (field === "deadlineAt" && visible.includes(value.slice(0, 10)));
        facts.push({
          evidenceId: "ld-" + digest(record.url + field + value).slice(0, 24),
          field,
          value,
          status: verified ? "verified" : "unknown",
          sourceId: record.sourceId,
          sourceUrl: record.url,
          sourceKind: "JobPosting",
          sourceExcerpt: value,
          location: { jsonPath: field },
          parserVersion: "jobposting-1",
          contentHash: digest(node.textContent),
          confidence: 100,
        });
        if (
          (field === "degree" && record.degree && record.degree !== value) ||
          (field === "company" && record.company && record.company !== value) ||
          (field === "deadlineAt" &&
            record.deadlineAt &&
            String(record.deadlineAt).slice(0, 10) !== value.slice(0, 10))
        )
          conflicts.push({ field, code: "visible_structured_conflict" });
      }
    }
  }
  return {
    sourceEvidence: [...(record.sourceEvidence || []), ...facts],
    evidenceConflicts: [...(record.evidenceConflicts || []), ...conflicts],
  };
}
const knownCertificates = [
  "注册消防工程师",
  "注册安全工程师",
  "消防设施操作员",
  "法律职业资格",
  "初级会计",
  "CPA",
  "ACCA",
  "CET-6",
  "CET-4",
  "英语六级",
  "英语四级",
];
export const CONDITIONS_PARSER_VERSION = "conditions-2";
export function extractRecruitmentConditions(record) {
  const text = String(record.description || ""),
    conditions = [],
    sourceEvidence = [];
  const add = (type, values, m, extra = {}) => {
    const excerpt = m[0],
      start = m.index ?? text.indexOf(excerpt),
      evidenceId =
        "e-" +
        digest(
          [
            record.url,
            type,
            start,
            excerpt,
            JSON.stringify(values),
            JSON.stringify(extra),
          ].join("|"),
        ).slice(0, 24);
    const preferred = isSoftRequirement(text, excerpt);
    const supplied = (record.sourceEvidence || []).find(
      (e) =>
        e.field === "description" &&
        e.status === "verified" &&
        literal(e.sourceExcerpt, excerpt),
    );
    sourceEvidence.push({
      evidenceId,
      origin: "local_parser",
      conditionsParserVersion: CONDITIONS_PARSER_VERSION,
      field: type,
      value: values,
      status:
        record.rowAmbiguous || supplied?.ambiguous ? "unknown" : "verified",
      sourceId: record.sourceId,
      sourceUrl: record.url,
      sourceKind: record.sourceKind || record.sourceId,
      sourceExcerpt: excerpt,
      location: { start, end: start + excerpt.length, ...supplied?.location },
      parserVersion: record.parserVersion || "evidence-1",
      contentHash: digest(text),
      observedAt: record.retrievedAt || null,
      confidence: supplied?.confidence ?? record.ocrConfidence ?? 100,
      appliesTo: {
        jobRowId: record.jobRowId || supplied?.appliesTo?.jobRowId || null,
        sharedCondition: record.sharedCondition === true,
      },
    });
    conditions.push({
      type,
      origin: "local_parser",
      conditionsParserVersion: CONDITIONS_PARSER_VERSION,
      operator: "any",
      values,
      required: !preferred,
      preferred,
      evidenceRefs: [evidenceId],
      jobRowId: record.jobRowId || null,
      ...extra,
    });
  };
  const certificateClauses = new Map();
  for (const name of knownCertificates)
    for (const match of text.matchAll(new RegExp(name, "g"))) {
      const clause = clauseAt(text, match.index, name.length),
        start = text.lastIndexOf(clause, match.index);
      if (
        /公司(?:现有|拥有)|团队|企业资质|资质等级/.test(clause) ||
        !/须|必须|要求|应具备|持有|取得|证书|资格|优先/.test(clause)
      )
        continue;
      const commonRegistration =
        text
          .slice(start + clause.length)
          .match(
            /^[，,]\s*注册(?:须|必须|应|需)[^。；\n]{0,35}(?:有效期|有效)[^。；\n]*/,
          )?.[0] || "";
      certificateClauses.set(start, {
        clause: clause + commonRegistration,
        commonRegistration: !!commonRegistration,
      });
    }
  for (const [start, { clause, commonRegistration }] of certificateClauses) {
    const found = knownCertificates
      .filter((name) => clause.includes(name))
      .sort((a, b) => clause.indexOf(a) - clause.indexOf(b));
    const options = found.map((name, i) => {
      const at = clause.indexOf(name),
        end =
          i + 1 < found.length ? clause.indexOf(found[i + 1]) : clause.length;
      return {
        name,
        grade:
          clause.slice(0, at).match(/(?:一级|二级|初级|中级|高级)$/)?.[0] ||
          null,
        registrationRequired:
          commonRegistration ||
          /(?:注册须|注册有效|注册.*有效期)/.test(clause.slice(at, end)),
      };
    });
    const connectors = found
      .slice(1)
      .map((name, i) =>
        clause.slice(
          clause.indexOf(found[i]) + found[i].length,
          clause.indexOf(name),
        ),
      );
    const any = connectors.some((s) => /或|任选|任一/.test(s));
    const all = connectors.some((s) => /和|且|以及|及|、/.test(s));
    add(
      "certificate",
      found,
      { 0: clause, index: start },
      {
        operator: any ? "any" : "all",
        certificateOptions: options,
        grade: options.length === 1 ? options[0].grade : null,
        registrationRequired:
          options.length === 1 && options[0].registrationRequired,
        ...(any && all ? { migrationStatus: "needs_review" } : {}),
      },
    );
  }
  for (const c of record.requiredCertificates || []) {
    const name = typeof c === "string" ? c : c.name;
    if (
      !name ||
      conditions.some(
        (x) => x.type === "certificate" && x.values.includes(name),
      )
    )
      continue;
    // A structured required field is retained as an unknown condition until its source is supported.
    conditions.push({
      type: "certificate",
      operator: "all",
      values: [name],
      required: typeof c === "string" || c.required !== false,
      preferred: c.preferred === true,
      evidenceRefs: (record.sourceEvidence || [])
        .filter(
          (e) => e.field === "requiredCertificates" && e.status === "verified",
        )
        .map((e) => e.evidenceId),
      grade: c.grade || null,
      registrationRequired: c.registrationRequired === true,
    });
  }
  const majors = text.match(
    /(?:专业要求|要求专业|专业[：:]|限(?:定)?专业[：:]?)\s*([^。；\n，]{2,100})/,
  );
  if (majors) {
    const values = majors[1]
      .replace(/(?:等相关)?专业(?:者)?(?:优先)?$/, "")
      .split(/或|、|\/|以及/)
      .map((s) => s.trim())
      .filter(Boolean);
    add("major", values, majors);
  } else if (record.major && record.majorRequired !== false) {
    const values = Array.isArray(record.major) ? record.major : [record.major];
    conditions.push({
      type: "major",
      operator: "any",
      values,
      required: true,
      evidenceRefs: (record.sourceEvidence || [])
        .filter((e) => e.field === "major" && e.status === "verified")
        .map((e) => e.evidenceId),
    });
  }
  const experience = text.match(
    /(?:至少|要求|须具备)?\s*(\d+(?:\.\d+)?)\s*年(?:以上)?(?:的)?(?:正式)?(?:工作|相关工作|行业工作)经验/,
  );
  if (experience)
    add("formal_experience", [Number(experience[1])], experience, {
      operator: "minimum",
    });
  const ageMention = text.search(/年龄|年纪|周岁/);
  if (ageMention >= 0) {
    const clause = clauseAt(text, ageMention, 2),
      start = text.indexOf(clause);
    const range = clause.match(
      /(\d{1,2})\s*(?:周岁|岁)?\s*[-—~～至到]\s*(\d{1,2})\s*(?:周岁|岁)/,
    );
    if (range)
      add(
        "age",
        [Number(range[1]), Number(range[2])],
        { 0: clause, index: start },
        { operator: "range", minimumInclusive: true, maximumInclusive: true },
      );
    else {
      const age = clause.match(
        /(不超过|不大于|不高于|不得超过|最多|不满|未满|小于|大于|超过|至少|不低于|不小于|不得低于|满)?\s*(\d{1,2})\s*(?:周岁|岁)(及以上|以上|及以下|以下|以内)?/,
      );
      if (age) {
        const direction = age[1] || age[3] || "",
          minimum =
            /大于|超过|至少|不低于|不小于|不得低于|满|以上/.test(direction) &&
            !/不超过|不得超过|不满|未满/.test(direction);
        const maximum =
          /不超过|不大于|不高于|不得超过|最多|小于|不满|未满|以下|以内/.test(
            direction,
          );
        add(
          "age",
          [Number(age[2])],
          { 0: clause, index: start },
          {
            operator: minimum ? "minimum" : maximum ? "maximum" : "exact",
            minimumInclusive: !["大于", "超过"].includes(direction),
            maximumInclusive: !["小于", "不满", "未满"].includes(direction),
            ...(!direction ? { migrationStatus: "needs_review" } : {}),
          },
        );
      }
    }
  }
  const physical = text.match(
    /(?:须|必须|要求)[^。；\n]{0,12}(?:通过体能测试|体能测试合格|体检合格)/,
  );
  if (physical) add("physical", ["qualified"], physical, { operator: "exact" });
  return { conditions, sourceEvidence };
}
/** Rebuild local parse output; unknown legacy constraints are retained for review. */
export function resolveRecruitmentConditions(record) {
  const extracted = extractRecruitmentConditions(record),
    text = String(record.description || "");
  const evidenceById = new Map(
    (record.sourceEvidence || []).map((e) => [e.evidenceId, e]),
  );
  const isDerived = (c) =>
    c.origin === "local_parser" ||
    (c.evidenceRefs || []).some((id) => {
      const e = evidenceById.get(id);
      return (
        e?.origin === "local_parser" ||
        (e?.sourceExcerpt &&
          e.location?.start !== undefined &&
          id ===
            "e-" +
              digest(
                [record.url, c.type, e.location.start, e.sourceExcerpt].join(
                  "|",
                ),
              ).slice(0, 24) &&
          text.includes(e.sourceExcerpt))
      );
    });
  const preserved = (record.conditions || [])
    .filter((c) => !isDerived(c))
    .map((c) =>
      ["manual", "structured_source"].includes(c.origin) ||
      c.conditionsParserVersion === CONDITIONS_PARSER_VERSION
        ? structuredClone(c)
        : { ...structuredClone(c), migrationStatus: "needs_review" },
    );
  const sourceEvidence = (record.sourceEvidence || []).filter(
    (e) =>
      e.origin !== "local_parser" &&
      !(record.conditions || []).some(
        (c) => isDerived(c) && (c.evidenceRefs || []).includes(e.evidenceId),
      ),
  );
  return {
    conditions: [...preserved, ...extracted.conditions],
    sourceEvidence: [...sourceEvidence, ...extracted.sourceEvidence].filter(
      (e, i, a) =>
        a.findIndex(
          (x) =>
            x.evidenceId === e.evidenceId &&
            x.field === e.field &&
            x.sourceExcerpt === e.sourceExcerpt,
        ) === i,
    ),
    conditionsParserVersion: CONDITIONS_PARSER_VERSION,
  };
}
export function prepareRecruitmentRecord(record, now) {
  const r = structuredClone(record),
    text = String(r.description || "");
  Object.assign(r, resolveRecruitmentConditions(r));
  const deadline =
    text.match(
      /(?:报名|投递|申请)?(?:截止(?:时间|日期)?|截至)[：:\s]*(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})(?:日)?(?:\s*(\d{1,2})[:：](\d{2}))?/,
    ) ||
    text.match(
      /报名时间[^。；\n]{0,55}?(?:至|到|—|－|~|～)\s*(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})(?:日)?(?:\s*(\d{1,2})[:：](\d{2}))?/,
    );
  if (deadline) {
    const d = `${deadline[1]}-${deadline[2].padStart(2, "0")}-${deadline[3].padStart(2, "0")}`;
    if (time(d) !== null) {
      if (r.deadlineAt && String(r.deadlineAt).slice(0, 10) !== d)
        r.evidenceConflicts = [
          ...(r.evidenceConflicts || []),
          { field: "deadlineAt", code: "visible_structured_conflict" },
        ];
      else {
        const hour = deadline[4] === undefined ? 23 : Number(deadline[4]),
          minute = deadline[5] === undefined ? 59 : Number(deadline[5]);
        const value = new Date(
          Date.UTC(
            Number(deadline[1]),
            Number(deadline[2]) - 1,
            Number(deadline[3]),
            hour - 8,
            minute,
            deadline[4] === undefined ? 59 : 0,
            deadline[4] === undefined ? 999 : 0,
          ),
        );
        const local = new Date(value.getTime() + 8 * 3600000);
        if (
          hour <= 23 &&
          minute <= 59 &&
          local.toISOString().slice(0, 10) === d
        )
          r.deadlineAt = value.toISOString();
      }
    }
  }
  if (/长期招聘|常年招聘|长期有效/.test(text)) r.longTermRecruiting = true;
  r.recruitmentCategory = /国家综合性消防救援队伍/.test(text)
    ? "state_firefighter"
    : /专职消防员/.test([r.title, text].join(" "))
      ? "dedicated_firefighter"
      : /消防|防火|消防设施/.test(r.title || "")
        ? "fire_technical"
        : /机场|航空|民航/.test([r.title, r.company].join(" "))
          ? "aviation_related"
          : "unknown";
  r.recruitmentEvidence = assessRecruitmentEvidence({
    record: r,
    now: now ?? time(r.retrievedAt) ?? Date.now(),
  });
  return r;
}
export function assessRecruitmentEvidence({ record, now = Date.now() }) {
  const r = record || {},
    text = String(r.description || ""),
    conflicts = [...(r.evidenceConflicts || [])];
  const bodyVerified =
    !/^article-literal-[23]$/.test(r.parserVersion || "") &&
    !!text.trim() &&
    !r.bodyIncomplete &&
    !r.rowAmbiguous &&
    !["discovery_only", "pending", "restricted"].includes(r.detailStatus) &&
    (r.detailStatus === "complete" ||
      r.bodyStatus === "complete" ||
      r.sourceEvidence?.some(
        (e) =>
          e.field === "description" &&
          e.status === "verified" &&
          literal(text, e.sourceExcerpt) &&
          !(e.confidence < 85),
      ));
  const verification = r.applicationVerification || {},
    checked = time(verification.checkedAt),
    fresh =
      checked !== null &&
      checked <= Number(now) &&
      Number(now) - checked <= 72 * 3600000;
  const applicationStatus =
    [401, 403].includes(verification.status) ||
    verification.status === "login_required"
      ? "login_required"
      : [404, 410].includes(verification.status) ||
          verification.status === "invalid"
        ? "invalid"
        : verification.challenge
          ? "unknown"
          : r.applyUrl &&
              verification.status === 200 &&
              verification.formVerified === true &&
              fresh
            ? "available"
            : "unknown";
  const deadline = time(r.deadlineAt || r.deadline),
    historical =
      /拟录用|拟聘用|录用人员公示|招聘结果|招聘工作总结|面试结果/.test(
        [r.title, text.slice(0, 160)].join(" "),
      );
  let openingStatus = historical
    ? "historical"
    : r.closed === true || r.openingStatus === "closed"
      ? "closed"
      : deadline !== null && deadline < Number(now)
        ? "expired"
        : conflicts.length || !bodyVerified
          ? "unknown"
          : deadline !== null && deadline >= Number(now)
            ? "open"
            : r.longTermRecruiting === true &&
                /长期招聘|常年招聘|长期有效/.test(text) &&
                applicationStatus === "available"
              ? "open"
              : "unknown";
  const missing = [
    ...(!bodyVerified ? ["body"] : []),
    ...(openingStatus === "unknown" ? ["opening"] : []),
    ...(applicationStatus !== "available" ? ["application"] : []),
  ];
  return {
    bodyVerified,
    openingStatus,
    applicationStatus,
    applicationCheckedAt: verification.checkedAt || null,
    missing,
    conflicts,
  };
}
export function prepareApplicationCheck(record, now = Date.now()) {
  const prepared = prepareRecruitmentRecord(record, now),
    evidence = prepared.recruitmentEvidence;
  return {
    evidence,
    applyUrl: prepared.applyUrl || null,
    shouldRequest: Boolean(
      prepared.applyUrl &&
        evidence.bodyVerified &&
        ["open", "unknown"].includes(evidence.openingStatus) &&
        evidence.conflicts.length === 0,
    ),
  };
}
export const isVerifiedRecommendation = ({ qualification, evidence }) =>
  qualification?.status === "pass" &&
  evidence?.bodyVerified === true &&
  evidence.openingStatus === "open" &&
  evidence.applicationStatus === "available" &&
  !evidence.conflicts?.length;
export function gateRecommendation(evaluation, record, now) {
  if (!evaluation) return null;
  const evidence = assessRecruitmentEvidence({ record, now });
  return {
    ...evaluation,
    recruitmentEvidence: evidence,
    recommended: isVerifiedRecommendation({
      qualification: evaluation.qualification,
      evidence,
    }),
    recommendation:
      evaluation.qualification?.status === "fail"
        ? "not_recommended"
        : isVerifiedRecommendation({
              qualification: evaluation.qualification,
              evidence,
            })
          ? evaluation.recommendation
          : "insufficient",
  };
}
