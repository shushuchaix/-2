import { officialEmailCandidate } from "../../domain/application-channels.mjs";
import { baseRecord } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
import { canonicalizeSourceUrl } from "../../domain/identity.mjs";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";
import {
  assessApplicationResponse,
  prepareApplicationCheck,
} from "../../domain/recruitment-evidence.mjs";
import { parseHTML } from "linkedom";
import { isVisibleHtmlElement } from "../../util/html-visibility.mjs";

const text = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
const fail = (code, message) => {
  throw Object.assign(Error(message), { code, retryable: false });
};

export function validateInlineOfficialJobTemplate(site) {
  const template = site.template;
  const bodyMode = Object.hasOwn(template || {}, "inlineBodyMode")
    ? template.inlineBodyMode
    : "target";
  const nativeHref =
    bodyMode === "row" && template?.nativeIdAttribute === "href";
  const applicationRules = [
    "applicationFormRule",
    "applicationJobIdRule",
    "applicationJobTitleRule",
  ];
  const deadlineRules = [
    "deadlineRule",
    "deadlineLabelRule",
    "deadlineLabelText",
  ];
  const hasDeadline = deadlineRules.some((key) =>
    Object.hasOwn(template || {}, key),
  );
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
    !["target", "row"].includes(bodyMode) ||
    !(bodyMode === "row"
      ? ["rel", "href"].includes(template.nativeIdAttribute)
      : template.nativeIdAttribute === "data-target") ||
    (nativeHref &&
      applicationRules.some(
        (key) => typeof template[key] !== "string" || !template[key].trim(),
      )) ||
    (hasDeadline &&
      (bodyMode !== "row" ||
        deadlineRules.some(
          (key) => typeof template[key] !== "string" || !template[key].trim(),
        ))) ||
    typeof template.nativeIdPattern !== "string" ||
    template.nativeIdPattern.length > 200 ||
    !template.nativeIdPattern.startsWith("^") ||
    !template.nativeIdPattern.endsWith("$") ||
    (bodyMode === "target" &&
      (!Array.isArray(template.requiredBodyRules) ||
        template.requiredBodyRules.length < 2 ||
        template.requiredBodyRules.some(
          (rule) => typeof rule !== "string" || !rule.trim(),
        ) ||
        new Set(template.requiredBodyRules.map((rule) => rule.trim())).size !==
          template.requiredBodyRules.length)) ||
    (bodyMode === "row" &&
      (!Array.isArray(template.requiredBodySections) ||
        template.requiredBodySections.length < 2 ||
        template.requiredBodySections.length > 8 ||
        template.requiredBodySections.some(
          (section) =>
            typeof section?.headingRule !== "string" ||
            !section.headingRule.trim() ||
            typeof section.headingText !== "string" ||
            !text(section.headingText) ||
            section.headingText.length > 160,
        ) ||
        new Set(
          template.requiredBodySections.map((section) =>
            text(section.headingText),
          ),
        ).size !== template.requiredBodySections.length))
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
  return {
    template,
    pattern,
    bodyMode,
    nativeHref,
    hasDeadline,
    listUrl: canonicalizeSourceUrl(url.href),
  };
}

function nativeHrefIdentity(value, config) {
  try {
    const url = validatePublicUrl(new URL(value, config.listUrl).href);
    if (url.origin !== new URL(config.listUrl).origin || url.search || url.hash)
      return null;
    const nativeId = url.pathname.match(config.pattern)?.[1];
    if (!/^[1-9][0-9]{0,19}$/.test(nativeId || "")) return null;
    return { nativeId, url: url.href };
  } catch {
    return null;
  }
}

function rowDeadlineEvidence(document, row, nativeId, config) {
  if (!config.hasDeadline) return [];
  const { template, listUrl } = config;
  const labels = [...document.querySelectorAll(template.deadlineLabelRule)];
  const dates = [...row.querySelectorAll(template.deadlineRule)];
  const value = text(dates[0]?.textContent);
  const timestamp = /^20\d{2}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(value + "T00:00:00.000Z")
    : NaN;
  if (
    labels.length !== 1 ||
    !isVisibleHtmlElement(labels[0]) ||
    text(labels[0].textContent) !== template.deadlineLabelText ||
    dates.length !== 1 ||
    !isVisibleHtmlElement(dates[0]) ||
    dates[0].closest(template.rowRule) !== row ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  )
    return [];
  return [
    {
      field: "deadlineDate",
      value,
      status: "verified",
      sourceId: "official-announcements",
      sourceUrl: listUrl,
      sourceKind: "visible_native_deadline_date",
      sourceExcerpt: template.deadlineLabelText + "：" + value,
      confidence: 100,
      location: {
        selector: `${template.rowRule} ${template.deadlineRule}`,
        labelSelector: template.deadlineLabelRule,
        nativeIdSelector: `${template.rowRule} ${template.nativeIdRule}`,
      },
      appliesTo: { jobRowId: nativeId },
    },
  ];
}

function rowSectionsComplete(target, sections) {
  const headings = new Set(
    sections.map((section) => text(section.headingText)),
  );
  return sections.every((section) => {
    const matches = [...target.querySelectorAll(section.headingRule)].filter(
      (node) => text(node.textContent) === text(section.headingText),
    );
    if (matches.length !== 1 || matches[0].parentElement !== target)
      return false;
    let content = "";
    for (
      let next = matches[0].nextElementSibling;
      next;
      next = next.nextElementSibling
    ) {
      const label = text(next.textContent);
      if (
        headings.has(label) ||
        /^[\u3400-\u9fffA-Za-z ]{2,12}[：:]$/.test(label)
      )
        break;
      content += htmlToText(next.innerHTML).trim();
    }
    return content.length >= 15;
  });
}

/** Assess an already-read native application response without requests or run markers. */
export function assessInlineOfficialApplication(
  site,
  record,
  response,
  checkedAt,
) {
  const config = validateInlineOfficialJobTemplate(site);
  const nativeId = String(record.sourceRecordId || "");
  const identity = config.nativeHref
    ? nativeHrefIdentity(record.applyUrl, config)
    : null;
  if (
    !config.nativeHref ||
    site.providerId !== "official-announcements" ||
    record.kind !== "job" ||
    record.sourceRecordIdKind !== "authority" ||
    record.sourceId !== "official-announcements" ||
    record.siteId !== site.siteId ||
    record.identityScope !== site.siteId ||
    !text(record.title) ||
    identity?.nativeId !== nativeId ||
    record.applyUrl !== identity?.url ||
    record.url !== record.applyUrl ||
    (response.url && response.url !== record.applyUrl)
  )
    fail(
      "detail_identity_mismatch",
      "Native application record or response does not match its authority",
    );
  const { document: application } = parseHTML(String(response.text || ""));
  const forms = [
    ...application.querySelectorAll(config.template.applicationFormRule),
  ];
  if (forms.length) {
    const ids = [
      ...forms[0].querySelectorAll(config.template.applicationJobIdRule),
    ];
    const names = [
      ...forms[0].querySelectorAll(config.template.applicationJobTitleRule),
    ];
    if (
      forms.length !== 1 ||
      ids.length !== 1 ||
      names.length !== 1 ||
      ids[0].localName !== "input" ||
      ids[0].getAttribute("type") !== "hidden" ||
      ids[0].closest("form") !== forms[0] ||
      names[0].localName !== "input" ||
      names[0].closest("form") !== forms[0] ||
      ids[0].getAttribute("value") !== nativeId ||
      !names[0].hasAttribute("readonly") ||
      text(names[0].getAttribute("value")) !== text(record.title)
    )
      fail(
        "detail_identity_mismatch",
        "Native application form does not belong to the requested job",
      );
  }
  const verification = assessApplicationResponse(response, checkedAt);
  const nativeFormVerification = assessApplicationResponse(
    {
      ...response,
      text: `<html><body>${forms.length === 1 && isVisibleHtmlElement(forms[0]) ? forms[0].outerHTML : ""}</body></html>`,
    },
    checkedAt,
  );
  return {
    ...verification,
    formVerified:
      verification.formVerified && nativeFormVerification.formVerified,
    checkedUrl: record.applyUrl,
    nativeJobBinding: {
      contract: "inline-native-job-1",
      siteId: site.siteId,
      sourceRecordId: record.sourceRecordId,
      title: text(record.title),
      applyUrl: record.applyUrl,
    },
  };
}

function rowEmailCandidates(row,{site,nativeId,listUrl,observedAt}) {
  const record = {sourceId:'official-announcements',siteId:site.siteId,identityScope:site.siteId,
    sourceRecordId:nativeId,sourceRecordIdKind:'authority',kind:'job'};
  const channels = new Map();
  for (const meta of [...row.querySelectorAll('.career-meta-row')].slice(0,20)) {
    if (!isVisibleHtmlElement(meta)) continue;
    const inMeta = node => node.closest('.career-meta-row') === meta;
    const labels = [...meta.querySelectorAll('.career-meta-label')].filter(inMeta);
    const values = [...meta.querySelectorAll('.career-meta-value')].filter(inMeta);
    if (labels.length !== 1 || values.length !== 1 ||
        !isVisibleHtmlElement(labels[0]) || !isVisibleHtmlElement(values[0])) continue;
    // textContent includes hidden descendants. Use only explicitly visible text
    // without executing CSS/JS or turning ordinary contact text into instructions.
    const visibleLabel = labels[0].cloneNode(true);
    for (const node of [...visibleLabel.querySelectorAll('*')])
      if (!isVisibleHtmlElement(node)) node.remove();
    const label = text(visibleLabel.textContent).replace(/[:：]$/,'');
    if (!/^(?:简历(?:投递|接收)邮箱|报名邮箱|投递邮箱|Apply Now)$/i.test(label)) continue;
    for (const anchor of [...values[0].querySelectorAll('a[href]')].slice(0,8)) {
      if (!inMeta(anchor) || anchor.closest('.career-meta-value') !== values[0] ||
          !isVisibleHtmlElement(anchor)) continue;
      const href = anchor.getAttribute('href');
      if (!href?.startsWith('mailto:')) continue;
      const candidate = officialEmailCandidate({record,address:href,sourceUrl:listUrl,observedAt,
        instructionExcerpt:label,selector:'.career-meta-row .career-meta-value a[href]'});
      if (candidate) channels.set(candidate.channelId,candidate);
    }
  }
  return {applicationChannels:[...channels.values()].slice(0,4),applicationChannelOverflow:channels.size > 4};
}
function readRows(site, document, config, observedAt) {
  const { template, pattern, bodyMode, nativeHref, listUrl } = config;
  const rows = [...document.querySelectorAll(template.rowRule)].filter(
    (row) => bodyMode !== "row" || isVisibleHtmlElement(row),
  );
  if (!rows.length) fail("parse_error", "Inline job row selector missing");
  const records = [],
    seen = new Set();
  for (const row of rows) {
    const titles = [...row.querySelectorAll(template.titleRule)];
    const identities = [...row.querySelectorAll(template.nativeIdRule)];
    const bodies = [...row.querySelectorAll(template.bodyRule)];
    const title = text(titles[0]?.textContent);
    const nativeValue = identities[0]?.getAttribute(template.nativeIdAttribute);
    const hrefIdentity = nativeHref
      ? nativeHrefIdentity(nativeValue, config)
      : null;
    const nativeId = nativeHref ? hrefIdentity?.nativeId : nativeValue;
    if (
      titles.length !== 1 ||
      !title ||
      identities.length !== 1 ||
      !nativeId ||
      !(
        bodyMode === "row" ? /^[1-9][0-9]{0,19}$/ : /^[A-Za-z][A-Za-z0-9_-]*$/
      ).test(nativeId) ||
      (!nativeHref && !pattern.test(nativeId)) ||
      seen.has(nativeId) ||
      titles[0]?.closest(template.rowRule) !== row ||
      identities[0]?.closest(template.rowRule) !== row
    )
      fail(
        "parse_error",
        "Inline job title or native identity is missing, invalid or duplicated",
      );
    const target =
      bodyMode === "row" ? bodies[0] : document.getElementById(nativeId);
    const idMatches =
      bodyMode === "row"
        ? [target].filter(Boolean)
        : [...document.querySelectorAll("[id]")].filter(
            (node) => node.id === nativeId,
          );
    if (
      bodies.length !== 1 ||
      target !== bodies[0] ||
      idMatches.length !== 1 ||
      target.closest(template.rowRule) !== row
    )
      fail(
        "parse_error",
        "Inline native identity does not locate exactly one row body",
      );
    seen.add(nativeId);
    // Row contracts use visible role sections. Legacy modal bodies retain their
    // explicit popup contract because their containers are hidden until opened.
    const visibleTarget = bodyMode === "row" ? target.cloneNode(true) : target;
    if (bodyMode === "row")
      for (const node of [...visibleTarget.querySelectorAll("*")])
        if (!isVisibleHtmlElement(node)) node.remove();
    const description =
      bodyMode === "row" && !isVisibleHtmlElement(target)
        ? ""
        : htmlToText(visibleTarget.innerHTML).trim();
    const incomplete =
      description.length < 30 ||
      (bodyMode === "row"
        ? !rowSectionsComplete(visibleTarget, template.requiredBodySections)
        : template.requiredBodyRules.some((rule) => {
            const nodes = [...row.querySelectorAll(rule)];
            return (
              nodes.length !== 1 ||
              !target.contains(nodes[0]) ||
              !htmlToText(nodes[0].innerHTML).trim()
            );
          }));
    const url = new URL(nativeHref ? hrefIdentity.url : listUrl);
    if (!nativeHref) url.hash = nativeId;
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
        urlKind: nativeHref
          ? "job_apply"
          : bodyMode === "row"
            ? "listing"
            : "job_detail",
        applyUrl: nativeHref ? url.href : null,
        company: site.name,
        jobType: "unknown",
        description,
        publishedAt,
        ...rowEmailCandidates(row,{site,nativeId,listUrl,observedAt}),
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
          {
            field: "description",
            url: listUrl,
            selector: `${template.rowRule} ${template.bodyRule}`,
          },
          {
            field: "publishedAt",
            source: "visible_publication_date",
            url: listUrl,
            selector: template.dateRule,
            value: publishedAt,
          },
        ],
        sourceEvidence: [
          ...rowDeadlineEvidence(document, row, nativeId, config),
          ...(nativeHref
            ? [
                {
                  field: "applyUrl",
                  value: url.href,
                  status: "unknown",
                  sourceId: "official-announcements",
                  sourceUrl: listUrl,
                  sourceKind: "public_anchor",
                  sourceExcerpt: text(identities[0].textContent),
                  location: {
                    selector: `${template.rowRule} ${template.nativeIdRule}`,
                  },
                  appliesTo: { jobRowId: nativeId },
                },
              ]
            : []),
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
  const records = readRows(site, document, config, new Date(ctx.clock?.now?.() ?? Date.now()).toISOString());
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
    (config.nativeHref
      ? nativeHrefIdentity(actualUrl, config)?.nativeId !== nativeId ||
        record.applyUrl !== actualUrl
      : !config.pattern.test(nativeId) || actualUrl !== expectedUrl.href) ||
    record.sourceRecordIdKind !== "authority" ||
    record.sourceId !== "official-announcements" ||
    record.siteId !== site.siteId ||
    record.identityScope !== site.siteId
  )
    fail(
      "detail_identity_mismatch",
      "Inline job URL does not match its authority",
    );
  const document = readDocument(
    await ctx.request(config.listUrl, { signal: ctx.signal }),
  );
  const fresh = readRows(site, document, config, new Date(ctx.clock?.now?.() ?? Date.now()).toISOString()).find(
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
  if (config.nativeHref) {
    if (fresh.url !== actualUrl)
      fail(
        "detail_identity_mismatch",
        "Fresh native job URL does not match the requested record",
      );
    const checkedAt = ctx.clock?.now?.() ?? Date.now();
    if (!prepareApplicationCheck(fresh, checkedAt).shouldRequest)
      return { ...record, ...fresh };
    const response = await ctx.request(fresh.applyUrl, {
      signal: ctx.signal,
      maxBytes: 1048576,
      maxRetries: 0,
    });
    return {
      ...record,
      ...fresh,
      applicationVerification: {
        ...assessInlineOfficialApplication(
          site,
          fresh,
          response,
          new Date(ctx.clock?.now?.() ?? Date.now()).toISOString(),
        ),
        ...(typeof ctx.runId === "string" && ctx.runId.trim()
          ? { checkedInRunId: ctx.runId }
          : {}),
      },
    };
  }
  return { ...record, ...fresh };
}
