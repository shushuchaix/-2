import { randomUUID } from "node:crypto";
import path from "node:path";
import { readZipEntries } from "../resume/zip.mjs";
import { parseDocx, ATTACHMENT_ZIP_LIMITS } from "./docx.mjs";
import { parseSpreadsheet } from "./spreadsheet.mjs";
import { parsePdf } from "./pdf.mjs";
import { imageDimensions } from "./ocr.mjs";
const parserVersion = "recruitment-attachments-1";
const result = (status, format, extra = {}) => ({
  status,
  format,
  parserVersion,
  blocks: [],
  tables: [],
  fields: [],
  issues: [],
  ...extra,
});
function fieldsFor(parsed) {
  const fields = [];
  for (const c of [
    ...parsed.blocks,
    ...parsed.tables.flatMap((t) => t.cells),
  ]) {
    const value = c.text.match(
      /博士|硕士|本科|大专|专科|高中|Bachelor|Master|PhD/i,
    )?.[0];
    if (value)
      fields.push({
        field: "degree",
        value,
        status:
          c.confidence >= 85 && !c.ambiguousMerge ? "extracted" : "unknown",
        evidence: {
          kind: c.location.sheet || c.location.table ? "table" : "text",
          location: c.location,
          confidence: c.confidence,
          excerpt: c.text.slice(0, 500),
        },
      });
  }
  return fields;
}
export async function parseAttachmentBytes({
  bytes,
  extension = "",
  ocr,
  converter,
  signal,
  ref,
  attemptId,
} = {}) {
  signal?.throwIfAborted();
  const buffer = Buffer.from(bytes || []);
  if (!buffer.length || buffer.length > 20971520)
    return result("rejected", "unknown", {
      issues: [{ code: "attachment_size_limit" }],
    });
  let format = "unknown",
    parsed;
  try {
    if (buffer.toString("ascii", 0, 5) === "%PDF-") {
      format = "pdf";
      parsed = await parsePdf(buffer, { ocr, signal });
    } else if (buffer.readUInt16LE(0) === 0x4b50) {
      const entries = readZipEntries(buffer, ATTACHMENT_ZIP_LIMITS);
      if (entries.has("word/document.xml")) {
        format = "docx";
        parsed = parseDocx(buffer);
      } else if (entries.has("xl/workbook.xml")) {
        format = "xlsx";
        parsed = parseSpreadsheet(buffer, { zip: true });
      } else throw Error("Unsupported ZIP document");
    } else if (
      buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))
    ) {
      if (extension.toLowerCase() === ".doc") {
        format = "doc";
        if (!converter)
          return result("pending", format, {
            issues: [{ code: "doc_converter_unavailable" }],
          });
        const converted = await converter.convert({
          bytes: buffer,
          ref,
          attemptId,
          signal,
        });
        parsed = parseDocx(converted);
      } else {
        format = "xls";
        parsed = parseSpreadsheet(buffer);
      }
    } else {
      format = "image";
      const d = imageDimensions(buffer);
      if (d.width * d.height > 25000000)
        throw Object.assign(Error("Image pixel limit"), {
          code: "attachment_expansion_limit",
        });
      if (!ocr)
        return result("pending", format, {
          issues: [{ code: "ocr_unavailable" }],
        });
      parsed = { ...(await ocr.recognize(buffer, { signal })), tables: [] };
    }
    signal?.throwIfAborted();
    parsed.blocks ||= [];
    parsed.tables ||= [];
    const uncertain =
      parsed.issues?.length ||
      (!parsed.blocks.length && !parsed.tables.some((t) => t.cells.length)) ||
      parsed.blocks.some((b) => b.confidence < 85);
    return result(uncertain ? "pending" : "extracted", format, {
      ...parsed,
      fields: fieldsFor(parsed),
      bytes: buffer.length,
    });
  } catch (e) {
    signal?.throwIfAborted();
    const limit =
      /ZIP .*limit/.test(e.message) || e.code === "attachment_expansion_limit";
    return result(
      [
        "ocr_unavailable",
        "doc_converter_unavailable",
        "doc_conversion_timeout",
      ].includes(e.code)
        ? "pending"
        : "rejected",
      format,
      {
        issues: [
          {
            code: limit
              ? "attachment_expansion_limit"
              : e.code || "attachment_parse_failed",
          },
        ],
        bytes: buffer.length,
      },
    );
  }
}
export function createAttachmentService({
  request: defaultRequest,
  ledger,
  cleanup,
  cache,
  ocr,
  converter,
  clock = { now: Date.now },
}) {
  const service = {
    async extract({
      ref,
      token,
      attachment,
      operationLease,
      signal,
      request = defaultRequest,
    }) {
      const attemptId = randomUUID();
      let reservation;
      try {
        const cached = await cache?.get({
          scope: ref.scope,
          resourceKey: "attachment:" + attachment.url,
        });
        if (
          cached?.parserVersion === parserVersion &&
          cached.parsedEvidence?.sliceRunId === token.sliceRunId
        )
          return structuredClone(cached.parsedEvidence.result);
        reservation = await ledger.reserve({
          ref,
          token,
          operationLease,
          reservationId: randomUUID(),
          kind: "attachment_credit",
          resourceKey: attachment.url,
        });
        if (cache) {
          const read = await cache.read({
            scope: ref.scope,
            resourceKey: "attachment:" + attachment.url,
            parserVersion,
            ref,
            token,
            operationLease,
            url: attachment.url,
            request,
            requestOptions: {
              responseType: "bytes",
              maxBytes: 20971520,
              kind: "attachment",
              signal,
              maxRetries: 2,
            },
            parse: async (response) => ({
              sliceRunId: token.sliceRunId,
              result: await parseAttachmentBytes({
                bytes: response.bytes,
                extension: path.extname(new URL(attachment.url).pathname),
                ocr,
                converter,
                signal,
                ref,
                attemptId,
              }),
            }),
          });
          if (read.evidence) {
            if (!reservation.duplicate)
              await ledger.settle({
                ref,
                reservationId: reservation.reservationId,
                operationLease,
                verifiedUsage: { bytes: 0 },
              });
            return {
              ...read.evidence.result,
              observedAt: read.checkedAt,
              cacheReused: read.reused,
            };
          }
          return result("pending", "unknown", {
            issues: [
              {
                code: [401, 403].includes(read.status)
                  ? "attachment_restricted"
                  : "attachment_unavailable",
              },
            ],
          });
        }
        const response = await request(attachment.url, {
          responseType: "bytes",
          maxBytes: 20971520,
          kind: "attachment",
          signal,
          maxRetries: 2,
        });
        if (response.status !== 200)
          return result("pending", "unknown", {
            issues: [
              {
                code: [401, 403].includes(response.status)
                  ? "attachment_restricted"
                  : "attachment_unavailable",
              },
            ],
          });
        const bytes = response.bytes;
        if (!(bytes instanceof Uint8Array))
          return result("rejected", "unknown", {
            issues: [{ code: "attachment_bytes_invalid" }],
          });
        if (!reservation.duplicate)
          await ledger.settle({
            ref,
            reservationId: reservation.reservationId,
            operationLease,
            verifiedUsage: { bytes: 0 },
          });
        const parsed = await parseAttachmentBytes({
          bytes,
          extension: path.extname(new URL(attachment.url).pathname),
          ocr,
          converter,
          signal,
          ref,
          attemptId,
        });
        return { ...parsed, observedAt: new Date(clock.now()).toISOString() };
      } finally {
        await cleanup.cleanupAttempt(attemptId);
      }
    },
    async enrich({ record, ...context }) {
      const attachments = [];
      let attempts = 0,
        budgetExhausted = false;
      const pending = (attachment, code) => ({
        ...attachment,
        textStatus: "pending",
        issues: [
          ...(attachment.issues || []).filter((issue) => issue.code !== code),
          { code },
        ],
      });
      for (const a of record.attachments || []) {
        context.signal?.throwIfAborted();
        if (
          a.textStatus === "extracted" &&
          a.extraction?.status === "extracted"
        ) {
          attachments.push(a);
          continue;
        }
        if (budgetExhausted || attempts >= 40) {
          attachments.push(
            pending(
              a,
              budgetExhausted
                ? "source_budget_exhausted"
                : "attachment_batch_limit",
            ),
          );
          continue;
        }
        attempts++;
        try {
          const parsed = await service.extract({ ...context, attachment: a });
          attachments.push({
            ...a,
            textStatus:
              parsed.status === "extracted" ? "extracted" : parsed.status,
            extraction: parsed,
          });
        } catch (e) {
          context.signal?.throwIfAborted();
          if (
            ["collection_stale_epoch", "workspace_write_failed"].includes(
              e.code,
            )
          )
            throw e;
          if (e.code === "source_budget_exhausted") {
            budgetExhausted = true;
            attachments.push(pending(a, e.code));
            continue;
          }
          attachments.push({
            ...a,
            textStatus: "pending",
            issues: [{ code: e.code || "attachment_unavailable" }],
          });
        }
      }
      return {
        ...record,
        attachments,
        attachmentBudgetExhausted: budgetExhausted,
        attachmentIssues: budgetExhausted
          ? [
              {
                code: "source_budget_exhausted",
                budgetKind: "attachments",
                retryable: false,
              },
            ]
          : [],
        attachmentEvidence: attachments.flatMap(
          (a) =>
            a.extraction?.fields?.map((f) => ({
              ...f,
              evidence: { ...f.evidence, url: a.url },
            })) || [],
        ),
      };
    },
  };
  return service;
}
