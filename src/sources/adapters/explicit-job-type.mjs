const conflictCode = "explicit_job_type_conflict";
const exactTypes = [
  ["internship", /^(?:实习(?:生|岗(?:位)?)?|intern(?:ship)?)$/i],
  ["campus", /^(?:校园招聘|校园招募|校招|应届(?:生|毕业生)?(?:招聘|招募)?)$/],
  ["social", /^(?:社会招聘|社会招募|社招)$/],
];
const exactType = (text) =>
  exactTypes.find(([, pattern]) => pattern.test(text.trim()))?.[0];
const knownTypes = new Set(exactTypes.map(([type]) => type));
const titleLabelType = (text) => {
  const type = exactType(text);
  return type === "campus" && !/招聘|招募|校招/.test(text) ? null : type;
};
const negated = (text, index) =>
  /(?:不(?:接受|招收|招聘|招募|招|是|属于|提供|含|面向)?|非|无需|无须|谢绝|禁止|拒绝)\s*(?:任何|在校(?:学生)?|应届|短期|长期)?\s*$/i.test(
    text.slice(Math.max(0, index - 24), index),
  ) ||
  /\b(?:not|no|non[- ]?)\s*$/i.test(text.slice(Math.max(0, index - 16), index));

// These are predicates about qualifications, supervision or acceptance, rather
// than a noun naming this position. Apply the same boundary in both languages.
const narrativeContext = (text) =>
  /(?:具备|具有|要求|资格|经验|经历|优先|不限|限制|接受|接收|欢迎|指导|带教|辅导|培养|培训|服务|咨询|面向|适合|接纳|是否|需要|可以)/.test(
    text,
  ) ||
  /\b(?:experience|experienced|require|requires|required|requirement|requirements|prefer|preferred|preference|welcome|welcoming|mentor|mentoring|supervise|supervising|supervision|guide|guidance|coach|coaching|train|training|eligible|eligibility|accept|accepting|support|supports)\b/i.test(
    text,
  );

// A continuous channel prefix needs an actual role phrase after it. Generic
// recruitment functions and qualification prose do not identify its audience.
function rolePhrase(text) {
  const role = text.replace(/^[\s:：—–-]+/, "").trim();
  return (
    role.length >= 3 &&
    !narrativeContext(role) &&
    !/^(?:人力资源|HR|招聘|招募)/i.test(role) &&
    !/^(?:高级|资深|初级|中级)?(?:专员|经理|主管|负责人|顾问|助理|实习生)$/.test(
      role,
    ) &&
    /(?:工程师|技术员|助理|专员|分析师|研究员|开发|设计师|顾问|教师|经理|主管|岗位|职位|员|岗|\b(?:Engineer|Assistant|Analyst|Developer|Technician|Researcher|Officer|Designer|Specialist))$/i.test(
      role,
    )
  );
}

// A suffix such as 实习生/Intern needs a nominal profession before it; a verb
// phrase ending in that word (指导实习生, welcomes interns) is not a role.
function roleStem(text) {
  const stem = text
    .replace(/校园招聘|校园招募|校招|社会招聘|社会招募|社招|招聘|招募/g, "")
    .trim();
  return (
    !!stem &&
    !narrativeContext(stem) &&
    (rolePhrase(stem) ||
      /(?:工程|技术|安全|消防|研发|建筑|设计|开发|测试|运营|运维|财务|市场|产品|设备|项目|实验室|会计|审计|策划|数据|软件|硬件|机械|电气|化工|人力资源|行政|法务|商务|业务|销售|采购|质量|土木|航空|空乘|管理|\b(?:Engineering|Laboratory|Safety|Software|Development|Technology|Design|Research|Finance|Marketing|Operations|Data|Accounting|Audit|Sales|Procurement|Quality|Aviation|Management))$/i.test(
        stem,
      ))
  );
}

// Reuse exactly the accepted internship-role grammar when another explicit
// channel label qualifies that role; accepting a role must not erase its channel.
function internshipRole(text) {
  const part = text.trim();
  if (narrativeContext(part)) return false;
  const suffix = part.match(
    /(?:实习生|实习岗(?:位)?)(?:招聘(?:公告|启事)?|招募(?:公告|启事)?|公告|启事)?$|(?:^|\s)实习$|\bintern(?:ship)?$/i,
  );
  if (
    suffix &&
    !negated(part, suffix.index) &&
    roleStem(part.slice(0, suffix.index))
  )
    return true;
  const prefix = part.match(
    /^(?:实习(?:生)?|intern(?:ship)?)\s*(?:[-—–:：]\s*)?(.+)$/i,
  );
  return !!prefix && rolePhrase(prefix[1]);
}

function titleTypes(title) {
  const types = new Set();
  const annotations = [];
  // Parentheses are qualifications/location metadata unless their whole value is
  // an explicit type label. "具备 Internship 经验" must not describe this role.
  const main = title
    .replace(
      /（[^（）]*）|\([^()]*\)|【[^【】]*】|\[[^\[\]]*\]/g,
      (annotation, offset) => {
        const type = titleLabelType(annotation.slice(1, -1));
        if (type && !negated(title, offset)) annotations.push(type);
        return " ";
      },
    )
    .trim();
  // Adjacent complete labels share the same actual role, independent of order.
  // Qualification prose left outside parentheses still fails that role grammar.
  if (roleStem(main) || internshipRole(main))
    for (const type of annotations) types.add(type);
  const parts = main.split(/[，,；;|｜]/);
  for (const [index, raw] of parts.entries()) {
    const part = raw.trim();
    const exact = titleLabelType(part);
    // Notes after a comma/pipe are not a second role. Only an independent whole
    // label next to one actual role may qualify it (工程师，实习).
    if (index > 0) {
      if (parts.length === 2 && exact && roleStem(parts[0])) types.add(exact);
      continue;
    }
    if (exact) types.add(exact);
    if (narrativeContext(part)) continue;
    if (internshipRole(part)) types.add("internship");
    for (const [type, pattern] of [
      ["campus", /校园招聘|校园招募|校招|应届(?:生|毕业生)?(?:招聘|招募)/g],
      ["social", /社会招聘|社会招募|社招/g],
    ]) {
      for (const match of part.matchAll(pattern)) {
        const after = part.slice(match.index + match[0].length).trim();
        if (
          !negated(part, match.index) &&
          (/^(?:公告|启事|通知|计划)?$/.test(after) ||
            rolePhrase(after) ||
            internshipRole(after))
        )
          types.add(type);
      }
    }
  }
  return [...types];
}

/** Role-name grammar and complete nature values supply type evidence; experience and audience prose do not. */
export function withExplicitJobType(
  record,
  { titleField = "title", descriptionField = "description" } = {},
) {
  const title = String(record.title || "");
  const observed = titleTypes(title).map((type) => ({
    type,
    text: title,
    sourceField: titleField,
  }));
  for (const match of String(record.description || "").matchAll(
    /(?:^|[\n。；;])\s*(?:岗位性质|职位性质|工作性质|招聘性质|招聘类型)\s*[：:]\s*([^\n。；;，,]+)/g,
  )) {
    const text = match[1].trim(),
      type = exactType(text);
    if (type) observed.push({ type, text, sourceField: descriptionField });
  }
  const inputEvidence = record.evidence || [];
  const ownsTypeEvidence = (item) =>
    item.field === "jobType" &&
    (item.source === "explicit_job_type" ||
      // Compatibility with this helper's first, unmarked inference shape. An
      // independent public-list/API source or verification status is not ours.
      (!item.source &&
        !item.sourceKind &&
        !item.status &&
        [titleField, descriptionField].includes(item.sourceField) &&
        typeof item.sourceExcerpt === "string" &&
        knownTypes.has(item.value)));
  const hadOwnInference =
    inputEvidence.some(ownsTypeEvidence) ||
    (record.evidenceConflicts || []).some((item) => item.code === conflictCode);
  const types = new Set(observed.map((item) => item.type));
  // Sparse detail is not contrary evidence: preserve incoming normalized list
  // facts unless they were this helper's inference. No new proof is fabricated.
  if (!hadOwnInference && knownTypes.has(record.jobType))
    types.add(record.jobType);
  for (const item of inputEvidence)
    if (
      item.field === "jobType" &&
      !ownsTypeEvidence(item) &&
      knownTypes.has(item.value)
    )
      types.add(item.value);
  // A campus internship is an internship; a social/campus or social/internship claim needs review.
  const conflict = types.has("social") && types.size > 1;
  const jobType = conflict
    ? "unknown"
    : types.has("internship")
      ? "internship"
      : [...types][0] || "unknown";
  const conflicts = (record.evidenceConflicts || []).filter(
    (item) => item.code !== conflictCode,
  );
  if (conflict)
    conflicts.push({
      field: "jobType",
      code: conflictCode,
      values: [...types],
    });
  // Refresh our own earlier inferences rather than retaining a disproven type
  // when an old list record is read again through the corrected detail parser.
  const evidence = inputEvidence.filter((item) => !ownsTypeEvidence(item));
  for (const item of observed) {
    if (
      evidence.some(
        (existing) =>
          existing.field === "jobType" &&
          existing.sourceField === item.sourceField &&
          existing.value === item.type &&
          existing.sourceExcerpt === item.text,
      )
    )
      continue;
    evidence.push({
      field: "jobType",
      source: "explicit_job_type",
      sourceField: item.sourceField,
      value: item.type,
      sourceExcerpt: item.text,
      url: record.url,
    });
  }
  return {
    ...record,
    jobType,
    evidence,
    ...(conflicts.length || record.evidenceConflicts
      ? { evidenceConflicts: conflicts }
      : {}),
  };
}
