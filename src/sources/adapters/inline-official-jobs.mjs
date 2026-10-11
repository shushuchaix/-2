import { baseRecord } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
import { canonicalizeSourceUrl } from "../../domain/identity.mjs";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";

const text = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
const fail = (code, message) => {
  throw Object.assign(Error(message), { code, retryable: false });
};

export function validateInlineOfficialJobTemplate(site) {
  const template = site.template;
  const rules = [
    "listUrl",
    "rowRule",
    "titleRule",
    "nativeIdRule",
    "bodyRule",
    "dateRule",
  ];
  if (
    template?.inlineJob !== true ||
    template.recordKind !== "job" ||
    rules.some(
      (key) => typeof template[key] !== "string" || !template[key].trim(),
    ) ||
    template.nativeIdAttribute !== "data-target" ||
    typeof template.nativeIdPattern !== "string" ||
    template.nativeIdPattern.length > 200 ||
    !template.nativeIdPattern.startsWith("^") ||
    !template.nativeIdPattern.endsWith("$") ||
    !Array.isArray(template.requiredBodyRules) ||
    template.requiredBodyRules.length < 2 ||
    template.requiredBodyRules.some(
      (rule) => typeof rule !== "string" || !rule.trim(),
    ) ||
    new Set(template.requiredBodyRules.map((rule) => rule.trim())).size !==
      template.requiredBodyRules.length
  )
    fail(
      "template_not_configured",
      "Explicit inline job identity and body rules required",
    );
  let pattern;
  try {
    pattern = new RegExp(template.nativeIdPattern);
  } catch {
    fail("template_not_configured", "Inline job identity pattern invalid");
  }
  const url = validatePublicUrl(template.listUrl);
  if (url.origin !== new URL(site.origin).origin || url.hash)
    fail(
      "template_not_configured",
      "Inline job list must use the configured public origin without a fragment",
    );
  return { template, pattern, listUrl: canonicalizeSourceUrl(url.href) };
}

function readRows(site, document, config) {
  const { template, pattern, listUrl } = config;
  const rows = [...document.querySelectorAll(template.rowRule)];
  if (!rows.length) fail("parse_error", "Inline job row selector missing");
  const records = [],
    seen = new Set();
  for (const row of rows) {
    const titles = [...row.querySelectorAll(template.titleRule)];
    const identities = [...row.querySelectorAll(template.nativeIdRule)];
    const bodies = [...row.querySelectorAll(template.bodyRule)];
    const title = text(titles[0]?.textContent);
    const nativeId = identities[0]?.getAttribute(template.nativeIdAttribute);
    if (
      titles.length !== 1 ||
      !title ||
      identities.length !== 1 ||
      !nativeId ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(nativeId) ||
      !pattern.test(nativeId) ||
      seen.has(nativeId)
    )
      fail(
        "parse_error",
        "Inline job title or native identity is missing, invalid or duplicated",
      );
    const target = document.getElementById(nativeId);
    const idMatches = [...document.querySelectorAll("[id]")].filter(
      (node) => node.id === nativeId,
    );
    if (bodies.length !== 1 || target !== bodies[0] || idMatches.length !== 1)
      fail(
        "parse_error",
        "Inline native identity does not locate exactly one row body",
      );
    seen.add(nativeId);
    const description = htmlToText(target.innerHTML).trim();
    const incomplete =
      description.length < 30 ||
      template.requiredBodyRules.some((rule) => {
        const nodes = [...row.querySelectorAll(rule)];
        return (
          nodes.length !== 1 ||
          !target.contains(nodes[0]) ||
          !htmlToText(nodes[0].innerHTML).trim()
        );
      });
    const url = new URL(listUrl);
    url.hash = nativeId;
    const publishedAt = explicitDate(
      row.querySelector(template.dateRule)?.textContent,
    );
    records.push(
      baseRecord({
        id: nativeId,
        sourceRecordIdKind: "authority",
        sourceId: "official-announcements",
        siteId: site.siteId,
        scope: site.siteId,
        kind: "job",
        title,
        url: canonicalizeSourceUrl(url.href),
        urlKind: "job_detail",
        company: site.name,
        jobType: "unknown",
        description,
        publishedAt,
        attachments: [],
        detailStatus: incomplete ? "incomplete" : "complete",
        bodyStatus: incomplete ? "incomplete" : "complete",
        bodyIncomplete: incomplete,
        attachmentBodyPending: false,
        retryEligible: false,
        evidence: [
          {
            field: "sourceRecordId",
            url: listUrl,
            selector: `${template.rowRule} ${template.nativeIdRule}`,
            attribute: template.nativeIdAttribute,
            value: nativeId,
          },
          {
            field: "title",
            url: listUrl,
            selector: `${template.rowRule} ${template.titleRule}`,
          },
          { field: "description", url: url.href, selector: template.bodyRule },
          {
            field: "publishedAt",
            source: "visible_publication_date",
            url: url.href,
            selector: template.dateRule,
            value: publishedAt,
          },
        ],
      }),
    );
  }
  return records;
}

export async function collectInlineOfficialJobs(site, page, ctx, readDocument) {
  const config = validateInlineOfficialJobTemplate(site);
  const limited = {
    hasMore: false,
    nextCursor: null,
    coverageScope: "limited",
    truncationReason: "listing_only",
  };
  if (page > 1) return { records: [], raw: 0, ...limited };
  const document = readDocument(
    await ctx.request(config.listUrl, { signal: ctx.signal }),
  );
  const records = readRows(site, document, config);
  return { records, raw: records.length, ...limited };
}

export async function fetchInlineOfficialJob(site, record, ctx, readDocument) {
  const config = validateInlineOfficialJobTemplate(site);
  const nativeId = String(record.sourceRecordId || "");
  const expectedUrl = new URL(config.listUrl);
  expectedUrl.hash = nativeId;
  let actualUrl;
  try {
    actualUrl = canonicalizeSourceUrl(record.url);
  } catch {
    fail(
      "detail_identity_mismatch",
      "Inline job URL does not match its authority",
    );
  }
  if (
    !config.pattern.test(nativeId) ||
    record.sourceRecordIdKind !== "authority" ||
    record.sourceId !== "official-announcements" ||
    record.siteId !== site.siteId ||
    record.identityScope !== site.siteId ||
    actualUrl !== expectedUrl.href
  )
    fail(
      "detail_identity_mismatch",
      "Inline job URL does not match its authority",
    );
  const document = readDocument(
    await ctx.request(config.listUrl, { signal: ctx.signal }),
  );
  const fresh = readRows(site, document, config).find(
    (row) => row.sourceRecordId === nativeId,
  );
  if (!fresh)
    fail(
      "detail_identity_mismatch",
      "Requested inline job identity is absent from the fresh page",
    );
  if (fresh.title !== text(record.title))
    fail(
      "detail_title_mismatch",
      "Inline job title does not match the requested record",
    );
  return { ...record, ...fresh };
}
