import {
  prepareApplicationCheck,
  assessApplicationResponse,
} from "../domain/recruitment-evidence.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";

/** Complete public record evidence using the caller-owned request and attachments. */
export function createRecordEnrichment({
  clock,
  diagnostics,
  officialSites = [],
  getAttachmentService = () => undefined,
}) {
  const at = () => new Date(clock.now()).toISOString();
  return async function enrichRecord(record, context) {
    const applicationCheck = prepareApplicationCheck(record, clock.now()),
      evidence = applicationCheck.evidence;
    await recordDiagnostic(diagnostics, {
      operation: "collection.body",
      runId: context.runId,
      counts: {
        bodyVerified: evidence.bodyVerified ? 1 : 0,
        bodyMissing: evidence.bodyVerified ? 0 : 1,
      },
      outcome: evidence.bodyVerified ? "success" : "insufficient",
    });
    if (
      record.kind === "job" &&
      applicationCheck.shouldRequest &&
      evidence.applicationStatus !== "available"
    ) {
      try {
        record = {
          ...record,
          applicationVerification: assessApplicationResponse(
            await context.request(record.applyUrl, {
              signal: context.signal,
              maxBytes: 1048576,
              maxRetries: 0,
              diagnosticContext: {
                sourceId: record.sourceId,
                endpointKind: "application",
              },
            }),
            at(),
          ),
        };
      } catch (error) {
        context.signal?.throwIfAborted();
        if (
          ["source_budget_exhausted", "collection_stale_epoch"].includes(
            error.code,
          )
        )
          throw error;
        record = {
          ...record,
          applicationVerification: {
            status: "unknown",
            checkedAt: at(),
            formVerified: false,
          },
        };
      }
    }
    const officialLinks = [];
    for (const link of record.externalLinks || [])
      try {
        const u = new URL(link.url),
          site = officialSites.find(
            (s) =>
              s.providerId === "official-announcements" &&
              s.template?.bodyRule &&
              s.origin === u.origin,
          );
        if (site && u.pathname !== "/")
          officialLinks.push({ url: u.href, site });
      } catch {}
    record = { ...record, officialLinks };
    const attachmentService = getAttachmentService();
    if (!record.attachments?.length || !attachmentService) return record;
    const enriched = await attachmentService.enrich({ record, ...context });
    await recordDiagnostic(diagnostics, {
      operation: "collection.attachment",
      runId: context.runId,
      counts: {
        input: record.attachments.length,
        attachmentsParsed: (enriched.attachments ?? []).filter(
          (a) => a.extraction?.status === "extracted",
        ).length,
      },
      outcome: enriched.attachments.some((a) => a.textStatus === "pending")
        ? "partial"
        : "completed",
    });
    const extracts = [];
    for (const a of enriched.attachments || [])
      if (a.extraction?.status === "extracted") {
        const blocks = [
          ...(a.extraction.blocks || []),
          ...(a.extraction.tables || []).flatMap((t) => t.cells || []),
        ].filter((b) => b.confidence >= 85 && !b.ambiguousMerge);
        if (blocks.length)
          extracts.push({
            url: a.url,
            text: blocks.map((b) => b.text).join("\n"),
            blocks,
          });
      }
    if (!extracts.length) return enriched;
    const description = [enriched.description, ...extracts.map((a) => a.text)]
      .filter(Boolean)
      .join("\n");
    const attachmentBodyComplete =
      enriched.attachmentBodyPending &&
      description.trim().length >= 30 &&
      enriched.attachments.every((a) => {
        if (a.extraction?.status !== "extracted") return false;
        const blocks = [
          ...(a.extraction.blocks || []),
          ...(a.extraction.tables || []).flatMap((t) => t.cells || []),
        ];
        return (
          blocks.length > 0 &&
          blocks.every((b) => b.confidence >= 85 && !b.ambiguousMerge)
        );
      });
    return {
      ...enriched,
      description,
      ...(attachmentBodyComplete
        ? {
            bodyStatus: "complete",
            detailStatus: "complete",
            attachmentBodyPending: false,
            retryEligible: false,
          }
        : {}),
      attachmentRows: extracts.flatMap((a) => {
        const groups = new Map();
        for (const b of a.blocks) {
          const rowNumber = b.row || b.location?.row;
          if (!rowNumber) continue;
          const key =
            a.url +
            "|" +
            JSON.stringify({
              sheet: b.location?.sheet,
              table: b.location?.table,
              page: b.location?.page,
            }) +
            "|" +
            rowNumber;
          const row = groups.get(key) || {
            jobRowId: key,
            sourceUrl: a.url,
            cells: [],
            ambiguous: false,
          };
          row.cells.push(b);
          row.ambiguous ||= b.ambiguousMerge === true;
          groups.set(key, row);
        }
        return [...groups.values()].map((r) => ({
          ...r,
          text: r.cells.map((b) => b.text).join("\n"),
        }));
      }),
      evidence: [
        ...(enriched.evidence || []),
        ...extracts.flatMap((a) =>
          a.blocks.map((b) => ({
            field: "description",
            excerpt: b.text,
            url: a.url,
            kind: "attachment",
            location: b.location,
            confidence: b.confidence,
          })),
        ),
      ],
    };
  };
}
