import { contentHash } from "../infrastructure/storage/repository.mjs";
import { classifyRecruitmentIntent } from "./social-intent.mjs";
export const contentKey = (r) =>
  contentHash([r.sourceId, r.identityScope, r.sourceRecordId || r.url]);
export function articleParts(text, size = 6000) {
  const parts = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + size / 2) end = newline;
    }
    parts.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - 300;
  }
  return parts;
}
/** Private queue lives in the owned root run, never in the global catalog. */
export function queueContentDraft(progress, unitId, records, now) {
  progress.pendingBodies ||= {};
  progress.pendingArticles ||= {};
  progress.articleCache ||= {};
  progress.pendingOfficialLinks ||= {};
  progress.officialLinkCache ||= {};
  for (const record of records) {
    const key = contentKey(record);
    for (const link of record.officialLinks || []) {
      const linkKey = contentHash([key, link.url]);
      if (
        !progress.pendingOfficialLinks[linkKey] &&
        !progress.officialLinkCache[linkKey]
      )
        progress.pendingOfficialLinks[linkKey] = {
          unitId,
          record: { ...structuredClone(record), officialLinks: [] },
          site: structuredClone(link.site),
          url: link.url,
          status: "pending",
          attempts: 0,
        };
    }
    if (
      record.retryEligible ||
      (record.bodyStatus && record.bodyStatus !== "complete")
    ) {
      const previous = progress.pendingBodies[key];
      progress.pendingBodies[key] = {
        unitId,
        record: structuredClone(record),
        attempts: previous?.attempts || 0,
        nextDueAt:
          record.retryAt ||
          record.nextDueAt ||
          new Date(now + 600000).toISOString(),
        serverCooldownUntil:
          record.retryAt ||
          record.nextDueAt ||
          previous?.serverCooldownUntil ||
          null,
        status: ["challenge_required", "login_required", "restricted"].includes(
          record.bodyStatus,
        )
          ? "waiting_for_auth"
          : "pending",
      };
      continue;
    }
    delete progress.pendingBodies[key];
    if (
      record.kind !== "recruitment_notice" ||
      !record.description ||
      (record.bodyStatus && record.bodyStatus !== "complete")
    )
      continue;
    const intent =
      record.intent ||
      classifyRecruitmentIntent({
        text: record.title + "\n" + record.description,
      }).intent;
    if (intent !== "employer_recruitment") continue;
    const parts = articleParts(record.description);
    const bodyHash = contentHash(record.description);
    for (const [partKey, pending] of Object.entries(progress.pendingArticles))
      if (
        contentKey(pending.record) === key &&
        pending.bodyHash &&
        pending.bodyHash !== bodyHash
      )
        delete progress.pendingArticles[partKey];
    for (const [partIndex, description] of parts.entries()) {
      const partKey = contentHash([
        key,
        record.parserVersion,
        "article-scope-4",
        description,
      ]);
      if (progress.articleCache[partKey] || progress.pendingArticles[partKey])
        continue;
      progress.pendingArticles[partKey] = {
        unitId,
        partIndex,
        partCount: parts.length,
        bodyHash,
        record: { ...structuredClone(record), description },
        status: "pending",
        attempts: 0,
      };
    }
  }
}
