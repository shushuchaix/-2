import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { baseRecord, extractApplicationLinks } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { isVisibleHtmlElement } from "../../util/html-visibility.mjs";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";
import { degreeRank } from "../../domain/qualification.mjs";
import { isSoftRequirement } from "../../match/requirements.mjs";
import {
  assessApplicationResponse,
  prepareRecruitmentRecord,
} from "../../domain/recruitment-evidence.mjs";

const origin = "https://job.nju.edu.cn";
const portal = "nju-public-career-1";
const listPath = "/api/career/job/recruitments";
const listUrl = origin + listPath + "?page=0&size=50";
const viewPath = "/career/jobs-v2";
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const clean = (value) => (typeof value === "string" ? value.trim() : "");
const nativeId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const orphanRow = (row) =>
  row.position === null ||
  (!Object.hasOwn(row, "position") &&
    Object.keys(row).every((key) => ["id", "updatedAt"].includes(key)) &&
    (row.updatedAt == null || typeof row.updatedAt === "string"));
const fail = (code, message = code) => {
  throw Object.assign(Error(message), { code, retryable: false });
};

export function isNjuPublicTemplateConfigured(site) {
  let url;
  try {
    url = new URL(site?.origin);
  } catch {
    /* Exact public origin required. */
  }
  return Boolean(
    site?.siteId === "official-nju" &&
      site.providerId === "official-announcements" &&
      url?.href === origin + "/" &&
      site.template?.nativePortal === portal &&
      site.template.listUrl === listUrl &&
      Array.isArray(site.allowedDomains) &&
      site.allowedDomains.includes("job.nju.edu.cn"),
  );
}

function config(site) {
  if (!isNjuPublicTemplateConfigured(site))
    fail(
      "template_not_configured",
      "Verified NJU native portal contract required",
    );
}

function viewUrl(id, isNotice = false) {
  const url = new URL(viewPath, origin);
  url.searchParams.set(isNotice ? "recruitmentId" : "jobId", id);
  return url.href;
}

function json(response, expectedUrl) {
  if ([401, 403].includes(response.status)) fail("restricted");
  if (response.status !== 200) {
    const error = Object.assign(Error("NJU public endpoint HTTP failure"), {
      code: "http_error",
      status: response.status,
      retryable: false,
    });
    throw error;
  }
  if (response.url && response.url !== expectedUrl)
    fail("detail_identity_mismatch");
  try {
    return JSON.parse(response.text);
  } catch {
    if (assessApplicationResponse(response, null).challenge) fail("captcha");
    fail("parse_error", "NJU public endpoint must return native JSON");
  }
}

function visibleIntro(value) {
  if (!clean(value)) return { text: "", html: "" };
  const { document } = parseHTML("<article>" + value + "</article>");
  const root = document.querySelector("article");
  if (!root) return { text: "", html: "" };
  for (const node of [...root.querySelectorAll("*")])
    if (!isVisibleHtmlElement(node)) node.remove();
  return { text: htmlToText(root.innerHTML).trim(), html: root.innerHTML };
}

function sectionCompleteness(intro, ambiguous) {
  const headings = [
    ...intro.matchAll(
      /(?:^|\n)\s*(?:[一二三四五六七八九十\d]+[、.．]\s*)?(岗位职责|工作职责|主要职责|任职要求|任职资格|招聘条件|资格要求|岗位要求)\s*[：:]\s*/g,
    ),
  ];
  const duties = [],
    qualifications = [];
  for (const [i, heading] of headings.entries()) {
    const text = intro
      .slice(
        heading.index + heading[0].length,
        headings[i + 1]?.index ?? intro.length,
      )
      .trim();
    (/职责/.test(heading[1]) ? duties : qualifications).push(text);
  }
  return {
    ownIntro: !!intro,
    duties: duties.length === 1 && duties[0].length >= 15,
    qualification:
      qualifications.length === 1 && qualifications[0].length >= 15,
    aggregate: ambiguous,
    qualificationText: qualifications.length === 1 ? qualifications[0] : "",
  };
}

const aggregateTitle = (title) =>
  /[、，,;；]|\s[/／]\s|(?:研发|营销|工程|技术|管理|安全|消防|机场)[/／](?:研发|营销|工程|技术|管理|安全|消防|机场)|(?:多个|多类|各类|各个|不同|等)(?:岗位|职位|方向)/.test(
    title,
  );

function deadlineAt(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(clean(value))) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) return null;
  return new Date(
    Date.UTC(year, month - 1, day, 15, 59, 59, 999),
  ).toISOString();
}

function validateRecruitments(entries, code = "parse_error") {
  if (!Array.isArray(entries) || entries.length > 50) fail(code);
  const parents = new Set(),
    rows = new Set();
  for (const entry of entries) {
    if (
      !plain(entry) ||
      !nativeId(entry.id) ||
      parents.has(entry.id) ||
      !plain(entry.company) ||
      !nativeId(entry.company.id) ||
      !clean(entry.company.name) ||
      !clean(entry.theme) ||
      !Array.isArray(entry.positions) ||
      entry.positions.length > 1000 ||
      (entry.intro != null && typeof entry.intro !== "string") ||
      (entry.deadline != null && typeof entry.deadline !== "string")
    )
      fail(code);
    parents.add(entry.id);
    for (const row of entry.positions) {
      if (!plain(row) || !nativeId(row.id) || rows.has(row.id)) fail(code);
      if (
        ["recruitmentCondition", "otherRequirement", "ageRequirement"].some(
          (key) => row[key] != null && typeof row[key] !== "string",
        )
      )
        fail(code);
      rows.add(row.id);
      // Public page-one JSON has orphan rows containing only id/updatedAt without position.
      // They provide no role definition and can contribute only a parent notice.
      if (orphanRow(row)) continue;
      if (
        !plain(row.position) ||
        !nativeId(row.position.id) ||
        !clean(row.position.name) ||
        (row.position.intro != null &&
          typeof row.position.intro !== "string") ||
        (row.position.fullTime != null &&
          typeof row.position.fullTime !== "boolean")
      )
        fail(code);
    }
  }
}

function evidence(
  field,
  value,
  entry,
  row,
  endpoint,
  jsonPath,
  sourceKind = "public_api_job_row",
) {
  return {
    field,
    value,
    sourceId: "official-announcements",
    sourceUrl: endpoint,
    sourceKind,
    sourceExcerpt: String(value ?? "").slice(0, 600),
    status: "verified",
    confidence: 100,
    location: { jsonPath },
    appliesTo: { recruitmentId: entry.id, jobRowId: row?.id || null },
  };
}

function sharedMandatoryRequirements(common, own, html) {
  const scope =
    /^\s*(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:本次招聘(?:中|的)?|本公告(?:中|的)?|基本(?:应聘|招聘)?条件[：:]\s*)?(?:(?:所有|全部|各)(?:岗位|职位)|(?:所有|全部|全体)(?:应聘人员|应聘者|申请人)|(?:应聘人员|应聘者|申请人)均)/;
  const mandatory =
    /必须|(?<![不无])须(?!知)|(?<!不)要求|(?<![不无])需(?:要)?(?:持有|具有|具备|取得|满足|符合)|(?:仅|只)(?:接受|招收|面向|限|招)|(?<!不)(?:应|应当)(?:持有|具有|具备|取得|满足|符合|为)|不得/;
  const qualification =
    /证书|资格|经验|届|毕业|年龄|周岁|\d+岁|专业|学历|学位|本科|硕士|博士|身体|体检|视力|身高|国籍|党员|政治|犯罪|违法/;
  const normalize = (value) => value.replace(/\s+/g, "");
  // Preserve native list structure while carrying only an explicit universal heading.
  const listed = htmlToText(html.replace(/<li\b[^>]*>/gi, "$&• "));
  const clauses = listed
    .split(/[。；;\r\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const results = [];
  let heading = null;
  for (const clause of clauses) {
    if (
      scope.test(clause) &&
      mandatory.test(clause) &&
      /(?:以下|下列|如下)(?:基本|应聘|任职|招聘|资格)?条件\s*[：:]?\s*$/.test(
        clause,
      )
    ) {
      heading = clause;
      continue;
    }
    const numbered =
      /^(?:\d+[、.．)）]|[一二三四五六七八九十]+[、.．)）]|[•·])\s*/.test(
        clause,
      );
    if (!numbered || /[：:]$/.test(clause)) heading = null;
    const shared = scope.test(clause) && mandatory.test(clause);
    const inherited =
      heading && numbered && !/不要求|无需|无须|不必|不需要/.test(clause);
    if (
      (shared || inherited) &&
      qualification.test(clause) &&
      !isSoftRequirement(listed, clause) &&
      !normalize(own).includes(normalize(clause))
    )
      results.push(inherited ? heading + "\n" + clause : clause);
  }
  return [...new Set(results)];
}

function recordFor(site, entry, row, endpoint, now) {
  const role = row?.position,
    title = clean(role?.name || entry.theme);
  const unresolvedRows = row ? [] : entry.positions.filter(orphanRow);
  const ambiguous = row ? aggregateTitle(title) : unresolvedRows.length > 0;
  const kind = !row || ambiguous ? "recruitment_notice" : "job";
  const own = visibleIntro(row ? role.intro : entry.intro),
    common = visibleIntro(entry.intro);
  const sections = sectionCompleteness(own.text, ambiguous),
    conflicts = [],
    conditions = [];
  const unresolvedShared = row
    ? sharedMandatoryRequirements(common.text, own.text, common.html)
    : [];
  if (unresolvedShared.length)
    conflicts.push({
      field: "qualification",
      code: "nju_shared_conditions_unresolved",
    });
  if (entry.enabled !== true || entry.status !== "PUBLISHED")
    conflicts.push({
      field: "publicationState",
      code: "nju_publication_state_unresolved",
    });
  const nativeDeadline = deadlineAt(entry.deadline);
  const commonConditions = prepareRecruitmentRecord(
    {
      kind: "recruitment_notice",
      title: entry.theme,
      description: common.text,
      deadlineAt: nativeDeadline,
    },
    now,
  );
  const deadline = commonConditions.deadlineAt || nativeDeadline;
  if (commonConditions.evidenceConflicts?.some((e) => e.field === "deadlineAt"))
    conflicts.push({
      field: "deadlineAt",
      code: "nju_parent_conditions_conflict",
    });
  const commonDegree = common.text.match(
    /(?:所有岗位|全部岗位|各岗位|应聘人员均|应聘者均)[^。；\n]{0,100}?(博士|硕士|本科|专科|大专)[^。；\n]{0,30}(?:学历|学位)/,
  );
  const rowDegree = degreeRank(role?.education),
    parentDegree = degreeRank(commonDegree?.[1]);
  if (
    row &&
    rowDegree !== null &&
    parentDegree !== null &&
    parentDegree > rowDegree
  )
    conflicts.push({ field: "degree", code: "nju_parent_conditions_conflict" });
  const ownDegree = degreeRank(sections.qualificationText);
  if (
    row &&
    rowDegree !== null &&
    ownDegree !== null &&
    ownDegree !== rowDegree
  )
    conflicts.push({ field: "degree", code: "nju_row_conditions_conflict" });
  const incomplete =
    !row ||
    ambiguous ||
    !sections.duties ||
    !sections.qualification ||
    !!conflicts.length;
  const id = row?.id || entry.id,
    url = viewUrl(id, !row);
  const sourceEvidence = [
    evidence(
      "sourceRecordId",
      id,
      entry,
      row,
      endpoint,
      row ? "positions[].id" : "id",
    ),
    evidence(
      "title",
      title,
      entry,
      row,
      endpoint,
      row ? "positions[].position.name" : "theme",
    ),
    evidence(
      "description",
      own.text,
      entry,
      row,
      endpoint,
      row ? "positions[].position.intro" : "intro",
    ),
  ];
  if (row) {
    sourceEvidence.push(
      evidence(
        "announcementText",
        common.text,
        entry,
        null,
        endpoint,
        "intro",
        "public_api_announcement",
      ),
    );
    for (const [field, value] of [
      ["degree", role.education],
      ["major", role.major],
    ])
      if (clean(value))
        sourceEvidence.push(
          evidence(
            field,
            value,
            entry,
            row,
            endpoint,
            "positions[].position." +
              (field === "degree" ? "education" : field),
          ),
        );
    for (const [field, key] of [
      ["rowRequirements", "recruitmentCondition"],
      ["rowRequirements", "otherRequirement"],
      ["ageRequirement", "ageRequirement"],
    ]) {
      const value = visibleIntro(row[key]).text;
      if (value)
        sourceEvidence.push(
          evidence(field, value, entry, row, endpoint, "positions[]." + key),
        );
    }
  }
  for (const clause of unresolvedShared) {
    const evidenceId =
      "nju-shared-" +
      createHash("sha256")
        .update(JSON.stringify([entry.id, row.id, clause]))
        .digest("hex")
        .slice(0, 24);
    sourceEvidence.push({
      ...evidence(
        "sharedRequirements",
        clause,
        entry,
        row,
        endpoint,
        "intro",
        "public_api_shared_requirement",
      ),
      evidenceId,
      appliesTo: {
        recruitmentId: entry.id,
        jobRowId: row.id,
        sharedCondition: true,
      },
    });
    // The literal parent-wide restriction is real; its interpretation against this row
    // remains unresolved. Keep it outside the role body and preserve it through reparse.
    conditions.push({
      type: "shared_requirements",
      origin: "structured_source",
      operator: "unknown",
      values: [clause],
      required: true,
      preferred: false,
      jobRowId: row.id,
      evidenceRefs: [evidenceId],
      migrationStatus: "needs_review",
    });
  }
  for (const field of ["enabled", "status"])
    if (Object.hasOwn(entry, field))
      sourceEvidence.push(
        evidence(
          "publicationState",
          entry[field],
          entry,
          row,
          endpoint,
          field,
          "public_api_publication_state",
        ),
      );
  if (unresolvedRows.length)
    sourceEvidence.push(
      evidence(
        "unresolvedJobRows",
        unresolvedRows.map((r) => r.id),
        entry,
        null,
        endpoint,
        "positions[?missing(position)||position=null].id",
      ),
    );
  if (nativeDeadline)
    sourceEvidence.push(
      evidence(
        "deadlineAt",
        nativeDeadline,
        entry,
        row,
        endpoint,
        "deadline",
        "public_api_recruitment_deadline",
      ),
    );
  if (deadline && deadline !== nativeDeadline)
    sourceEvidence.push(
      evidence(
        "deadlineAt",
        deadline,
        entry,
        null,
        endpoint,
        "intro",
        "public_api_recruitment_deadline_text",
      ),
    );
  const commonApplications = extractApplicationLinks(common.html, {
    baseUrl: url,
    record: { sourceId: "official-announcements" },
  });
  const applications = row
    ? extractApplicationLinks(own.html, {
        baseUrl: url,
        record: { sourceId: "official-announcements" },
      })
    : { applyUrl: null, sourceEvidence: [] };
  sourceEvidence.push(
    ...commonApplications.sourceEvidence.map((e) => ({
      ...e,
      sourceUrl: endpoint,
      sourceKind: "native_announcement_application_candidate",
      appliesTo: { recruitmentId: entry.id },
    })),
    ...applications.sourceEvidence.map((e) => ({
      ...e,
      sourceUrl: endpoint,
      sourceKind: "native_job_application_candidate",
      appliesTo: { recruitmentId: entry.id, jobRowId: row.id },
    })),
  );
  // A website value alone may be a company homepage; it remains only a candidate.
  const applicationCandidates = [
    ...new Set(
      [
        ...commonApplications.sourceEvidence,
        ...applications.sourceEvidence,
      ].map((e) => e.value),
    ),
  ];
  if (clean(entry.website)) {
    try {
      const candidate = validatePublicUrl(entry.website).href;
      if (
        !/[?&](?:token|password|session|auth|secret|ticket)=/i.test(
          candidate,
        ) &&
        !applicationCandidates.includes(candidate)
      )
        applicationCandidates.push(candidate);
    } catch {
      /* Keep unavailable or private entry URLs out of candidate metadata. */
    }
  }
  const fields = row
    ? [
        clean(role.education) && "学历：" + role.education,
        clean(role.major) && "专业：" + role.major,
        visibleIntro(row.recruitmentCondition).text,
        visibleIntro(row.otherRequirement).text,
        visibleIntro(row.ageRequirement).text,
      ].filter(Boolean)
    : [];
  const record = baseRecord({
    id,
    sourceRecordIdKind: "authority",
    sourceId: "official-announcements",
    siteId: site.siteId,
    scope: site.siteId,
    url,
    urlKind: row ? "job_detail" : "notice_detail",
    kind,
    title,
    company: entry.company.name,
    cities: row
      ? [clean(row.region?.city || row.region?.province)].filter(Boolean)
      : [],
    jobType:
      role?.fullTime === false
        ? "internship"
        : /校园|校招|高校毕业生/.test(entry.theme)
          ? "campus"
          : "unknown",
    description: [...new Set([own.text, ...fields].filter(Boolean))].join("\n"),
    degree: clean(role?.education) || null,
    major: clean(role?.major) || null,
    salary: clean(row?.salary) || null,
    publishedAt: null,
    deadlineAt: conflicts.some((c) => c.field === "deadlineAt")
      ? null
      : deadline,
    applyUrl: applications.applyUrl,
    applicationCandidates,
    sourceEvidence,
    evidenceConflicts: conflicts,
    conditions,
    bodyStatus: incomplete ? "incomplete" : "complete",
    detailStatus: incomplete ? "incomplete" : "complete",
    bodyIncomplete: incomplete,
    rowAmbiguous: ambiguous,
    unresolvedRowCount: unresolvedRows.length,
    sectionCompleteness: {
      ownIntro: sections.ownIntro,
      duties: sections.duties,
      qualification: sections.qualification,
      aggregate: ambiguous,
    },
    parserVersion: portal,
    attachments: [],
    attachmentBodyPending: false,
    nativeRecruitmentBinding: {
      portal,
      siteId: site.siteId,
      origin,
      recruitmentId: entry.id,
      jobRowId: row?.id || null,
      positionId: role?.id || null,
      companyId: entry.company.id,
      title,
    },
  });
  // Current explicit role deadline conflicts are detected without borrowing common prose.
  const prepared = prepareRecruitmentRecord(record, now);
  if (prepared.evidenceConflicts?.some((c) => c.field === "deadlineAt")) {
    record.evidenceConflicts = prepared.evidenceConflicts;
    record.deadlineAt = null;
    record.bodyIncomplete = true;
    record.bodyStatus = record.detailStatus = "incomplete";
  }
  return record;
}

/** One anonymous native API page; this helper never recursively requests pages. */
export async function collectNjuPublicJobs(site, page, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const cursor = ctx.cursor;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 20 ||
    (cursor &&
      (cursor.page !== page ||
        cursor.nju?.origin !== origin ||
        cursor.nju.siteId !== site.siteId ||
        !Array.isArray(cursor.nju.seenPages) ||
        cursor.nju.seenPages.length !== page - 1 ||
        cursor.nju.seenPages.some((v) => !/^[a-f0-9]{64}$/.test(v)))) ||
    (page > 1 && !cursor)
  )
    fail("collection_cursor_invalid");
  const url = origin + listPath + `?page=${page - 1}&size=50`;
  const data = json(await ctx.request(url, { signal: ctx.signal }), url);
  ctx.signal?.throwIfAborted();
  const p = data?.page;
  if (
    !plain(data) ||
    !plain(p) ||
    p.number !== page - 1 ||
    p.size !== 50 ||
    !Number.isSafeInteger(p.totalElements) ||
    p.totalElements < 0 ||
    !Number.isSafeInteger(p.totalPages) ||
    p.totalPages < 0 ||
    p.totalPages !== Math.ceil(p.totalElements / p.size) ||
    !Array.isArray(data.content) ||
    data.content.length !==
      Math.min(50, Math.max(0, p.totalElements - p.number * 50))
  )
    fail("parse_error", "NJU native page schema or page number mismatch");
  validateRecruitments(data.content);
  const signature = createHash("sha256")
    .update(
      JSON.stringify(
        data.content
          .map((e) => [e.id, e.positions.map((p) => p.id).sort()])
          .sort((a, b) => a[0].localeCompare(b[0])),
      ),
    )
    .digest("hex");
  const seenPages = cursor?.nju?.seenPages || [];
  if (seenPages.includes(signature)) fail("pagination_loop");
  const records = data.content.flatMap((entry) => {
    const roles = entry.positions.filter((row) => !orphanRow(row));
    const rows = roles.map((row) =>
      recordFor(site, entry, row, url, ctx.clock?.now?.() ?? Date.now()),
    );
    if (!entry.positions.length || entry.positions.some(orphanRow))
      rows.push(
        recordFor(site, entry, null, url, ctx.clock?.now?.() ?? Date.now()),
      );
    return rows;
  });
  const capped = page === 20 && p.number + 1 < p.totalPages;
  const hasMore = !capped && p.number + 1 < p.totalPages;
  return {
    records,
    issues: [],
    hasMore,
    coverageScope: capped ? "limited" : "query",
    ...(capped ? { truncationReason: "page_limit" } : {}),
    nextCursor: hasMore
      ? {
          page: page + 1,
          nju: {
            siteId: site.siteId,
            origin,
            seenPages: [...seenPages, signature],
          },
        }
      : null,
    parserVersion: portal,
  };
}

/** Read the proven parent recruitment API and bind exactly one existing native row. */
export async function fetchNjuPublicJob(site, record, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const binding = record.nativeRecruitmentBinding;
  const rowMode = binding?.jobRowId !== null;
  if (
    !binding ||
    binding.portal !== portal ||
    binding.siteId !== site.siteId ||
    binding.origin !== origin ||
    !nativeId(binding.recruitmentId) ||
    !nativeId(binding.companyId) ||
    binding.title !== record.title ||
    record.sourceId !== "official-announcements" ||
    record.siteId !== site.siteId ||
    record.identityScope !== site.siteId ||
    record.sourceRecordIdKind !== "authority" ||
    (rowMode &&
      (!nativeId(binding.jobRowId) || !nativeId(binding.positionId))) ||
    record.sourceRecordId !==
      (rowMode ? binding.jobRowId : binding.recruitmentId) ||
    record.url !== viewUrl(record.sourceRecordId, !rowMode)
  )
    fail("detail_identity_mismatch");
  const endpoint =
    origin + listPath + "/" + encodeURIComponent(binding.recruitmentId);
  const entry = json(
    await ctx.request(endpoint, { signal: ctx.signal }),
    endpoint,
  );
  ctx.signal?.throwIfAborted();
  validateRecruitments([entry], "detail_identity_mismatch");
  if (
    entry.id !== binding.recruitmentId ||
    entry.company.id !== binding.companyId ||
    entry.company.name !== record.company
  )
    fail("detail_identity_mismatch");
  const row = rowMode
    ? entry.positions.find((row) => row.id === binding.jobRowId)
    : null;
  if (
    rowMode
      ? !row ||
        orphanRow(row) ||
        row.position.id !== binding.positionId ||
        clean(row.position.name) !== binding.title
      : clean(entry.theme) !== binding.title
  )
    fail("detail_identity_mismatch");
  const result = recordFor(
    site,
    entry,
    row,
    endpoint,
    ctx.clock?.now?.() ?? Date.now(),
  );
  if (result.kind !== record.kind) fail("detail_identity_mismatch");
  // Old application checks are never inherited from a list or a previous response.
  const refreshed = { ...record, ...result };
  delete refreshed.applicationVerification;
  return refreshed;
}
