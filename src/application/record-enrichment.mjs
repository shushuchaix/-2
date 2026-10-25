import {
  prepareOwnedApplicationCheck,
  hasCurrentApplicationCheck,
  assessOwnedApplicationResponse,
} from "./application-verification.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
import { prepareRecruitmentRecord } from "../domain/recruitment-evidence.mjs";
import { isOperationControlError } from "../domain/operation-control.mjs";
import {
  sourceIssueCode,
  safeSourceDiagnosticRefs,
} from "../sources/source-status.mjs";

/** Complete public record evidence using the caller-owned request and attachments. */
export function createRecordEnrichment({
  clock,
  diagnostics,
  officialSites = [],
  getAttachmentService = () => undefined,
}) {
  const at = () => new Date(clock.now()).toISOString();
  async function checkApplication(record, context) {
    const owned = prepareOwnedApplicationCheck(
      record,
      officialSites,
      clock.now(),
    );
    record = owned.record;
    const applicationCheck = owned.check,
      evidence = applicationCheck.evidence,
      checkedInCurrentRun = hasCurrentApplicationCheck(
        record,
        context.runId,
        clock.now(),
      );
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
      !checkedInCurrentRun &&
      applicationCheck.shouldRequest &&
      evidence.applicationStatus !== "available"
    ) {
      const started = clock.now();
      let phase = "transport";
      try {
        context.signal?.throwIfAborted();
        const response = await context.request(record.applyUrl, {
          signal: context.signal,
          maxBytes: 1048576,
          maxRetries: 0,
          diagnosticContext: {
            sourceId: record.sourceId,
            siteId: record.siteId,
            endpointKind: "application",
          },
        });
        context.signal?.throwIfAborted();
        phase = "parse";
        record = {
          ...record,
          applicationVerification: assessOwnedApplicationResponse(
            owned.site,
            record,
            response,
            at(),
            context.runId,
          ),
        };
        await recordDiagnostic(diagnostics, {
          operation: "collection.application",
          runId: context.runId,
          sourceId: record.sourceId,
          siteId: record.siteId,
          endpointKind: "application",
          phase: "parse",
          durationMs: Math.max(0, Math.round(clock.now() - started)),
          httpStatus: response.status,
          ...safeSourceDiagnosticRefs(response),
          outcome: record.applicationVerification.formVerified
            ? "success"
            : "insufficient",
          resultCategory: record.applicationVerification.challenge
            ? "business_risk"
            : record.applicationVerification.status === "login_required" ||
                [401, 403].includes(response.status)
              ? "auth"
              : response.status === 429
                ? "rate_limited"
                : "response",
        });
      } catch (error) {
        context.signal?.throwIfAborted();
        if (isOperationControlError(error)) throw error;
        const code = sourceIssueCode(error);
        await recordDiagnostic(diagnostics, {
          operation: "collection.application",
          level: "warn",
          runId: context.runId,
          sourceId: record.sourceId,
          siteId: record.siteId,
          endpointKind: "application",
          phase,
          code,
          ...safeSourceDiagnosticRefs(error),
          durationMs: Math.max(0, Math.round(clock.now() - started)),
          outcome: "failed",
          resultCategory: ["request_timeout", "http_timeout"].includes(code)
            ? "timeout"
            : code === "network_error" || code.startsWith("public_dns_")
              ? "network"
              : code === "rate_limited"
                ? "rate_limited"
                : ["login_required", "restricted", "http_forbidden"].includes(
                      code,
                    )
                  ? "auth"
                  : code === "response_size_exceeded"
                    ? "policy"
                    : "unknown",
        });
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
    return prepareRecruitmentRecord(record, clock.now());
  }
  async function enrichAttachments(record, context) {
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
  }
  return async function enrichRecord(record, context) {
    context.signal?.throwIfAborted();
    const enriched = await enrichAttachments(record, context);
    context.signal?.throwIfAborted();
    return checkApplication(enriched, context);
  };
}
