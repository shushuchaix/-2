import { contentHash } from "../infrastructure/storage/repository.mjs";
import { classifyRecruitmentIntent } from "./social-intent.mjs";
import { articleCacheIdentity } from "../llm/prompt-registry.mjs";
const articlePartKey = (pending) =>
  contentHash([
    contentKey(pending.record),
    pending.record.parserVersion,
    pending.cacheIdentity,
    pending.record.description,
  ]);
const cacheMatches = (cached, identity) =>
  cached && Object.keys(identity).every((k) => cached[k] === identity[k]);
/** Re-key persisted chunks in place; keep the original full-body hash and tail. */
export function refreshArticleQueue(
  progress,
  identity = articleCacheIdentity(),
) {
  progress.pendingArticles ||= {};
  progress.articleCache ||= {};
  for (const [key, cached] of Object.entries(progress.articleCache)) {
    if (cached.record && !cacheMatches(cached, identity)) {
      progress.pendingArticles[key] = {
        unitId: cached.unitId,
        partIndex: cached.partIndex,
        partCount: cached.partCount,
        bodyHash: cached.bodyHash,
        record: structuredClone(cached.record),
        status: "pending",
        attempts: 0,
      };
      delete progress.articleCache[key];
    }
  }
  for (const [oldKey, previous] of Object.entries(progress.pendingArticles)) {
    const pending = {
      ...previous,
      cacheIdentity: {
        ...identity,
        bodyHash: previous.bodyHash || contentHash(previous.record.description),
      },
    };
    const key = articlePartKey(pending);
    delete progress.pendingArticles[oldKey];
    if (!cacheMatches(progress.articleCache[key], pending.cacheIdentity))
      progress.pendingArticles[key] = pending;
  }
}
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
export function queueContentDraft(
  progress,
  unitId,
  records,
  now,
  identity = articleCacheIdentity(),
) {
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
      record.retryEligible !== false &&
      (record.retryEligible ||
        (record.bodyStatus && record.bodyStatus !== "complete"))
    ) {
      const previous = progress.pendingBodies[key];
      progress.pendingBodies[key] = {
        unitId,
        record: structuredClone(record),
        attempts: previous?.attempts || 0,
        automaticAttempts: previous?.automaticAttempts || 0,
        riskBlocked: previous?.riskBlocked || false,
        nextDueAt:
          record.retryAt ||
          record.nextDueAt ||
          new Date(now + 600000).toISOString(),
        serverCooldownUntil:
          record.retryAt ||
          record.nextDueAt ||
          previous?.serverCooldownUntil ||
          null,
        status:
          previous?.automaticAttempts >= 3
            ? "needs_review"
            : ["challenge_required", "login_required", "restricted"].includes(
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
      const cacheIdentity = { ...identity, bodyHash };
      const partKey = articlePartKey({
        record: { ...record, description },
        cacheIdentity,
      });
      if (
        cacheMatches(progress.articleCache[partKey], cacheIdentity) ||
        progress.pendingArticles[partKey]
      )
        continue;
      progress.pendingArticles[partKey] = {
        unitId,
        partIndex,
        partCount: parts.length,
        bodyHash,
        cacheIdentity,
        record: { ...structuredClone(record), description },
        status: "pending",
        attempts: 0,
      };
    }
  }
}
