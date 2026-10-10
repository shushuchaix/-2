import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";

export type DiagnosticEntry = Record<string, unknown>;
const numberKeys = new Set([
  "httpStatus",
  "retryCount",
  "retryDelayMs",
  "attempt",
  "recordCount",
  "responseBytes",
  "durationMs",
  "queueMs",
  "dnsMs",
  "transportMs",
  "timeoutMs",
  "page",
  "queryIndex",
  "redirectCount",
  "issueCount",
  "revision",
  "exitCode",
  "maxRetries",
  "pageLimit",
  "batchSize",
  "errorNumber",
]);
const tokenKeys = new Set([
  "operation",
  "level",
  "code",
  "category",
  "phase",
  "failurePhase",
  "stage",
  "outcome",
  "method",
  "sourceId",
  "siteId",
  "endpointKind",
  "dnsResolver",
  "truncationReason",
]);
const numericChildren = new Set([
  "raw",
  "normalized",
  "notices",
  "expanded",
  "deduplicated",
  "eligible",
  "shortlisted",
  "qualificationUnknown",
  "qualificationFailed",
  "aiSuccess",
  "fallback",
  "newForTarget",
  "input",
  "accepted",
  "rejected",
  "pages",
  "plannedSites",
  "skippedSites",
  "queries",
  "cached",
  "invalid",
  "missing",
  "valid",
  "noJob",
  "skipped",
  "failed",
  "complete",
  "interrupted",
  "orphan",
  "issues",
  "profiles",
  "targets",
  "jobs",
  "observations",
  "evaluations",
  "runs",
  "applications",
  "events",
  "files",
  "requests",
  "maxRequests",
  "details",
  "maxDetails",
  "modelRequests",
  "maxModelRequests",
  "attempts",
  "reservedTokens",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "usedCostCny",
  "maxCostCny",
  "upperCostCny",
  "reservedCostCny",
  "uncertainCostCny",
  "textLength",
  "documentLength",
  "resultCount",
  "expectedCount",
  "maxOutputTokens",
  "calls",
  "failures",
  "pricedRequests",
  "uncertainRequests",
  "costUpperBoundCny",
  "truncated",
  "sites",
  "request",
  "list",
  "detail",
  "search",
  "dns",
  "redirect",
  "retry",
  "duplicate_id",
  "invalid_score",
  "invalid_reasons",
  "invalid_gaps",
  "missing_evidence",
  "invalid_evidence",
  "evidence_not_in_source",
  "unknown_id",
  "missing_result",
  "invalid_results_shape",
]);
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const token = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.@-]{1,160}$/.test(v);
function numericTree(
  v: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!object(v) || depth > 3) return;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    if (
      numericChildren.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    )
      out[key] = value;
    else if (
      [
        "sources",
        "model",
        "counts",
        "usage",
        "coverage",
        "validationCounts",
        "byKind",
      ].includes(key)
    ) {
      const child = numericTree(value, depth + 1);
      if (child && Object.keys(child).length) out[key] = child;
    } else if (key === "costMode" && value === "cny_upper_bound")
      out[key] = value;
    else if (
      key === "pricingVersion" &&
      value === "deepseek-v4.1-flash-cny-2026-10-07"
    )
      out[key] = value;
  }
  return out;
}

/** Explicit display allowlist; never stringify arbitrary diagnostic payloads. */
export function safeDiagnostic(entry: DiagnosticEntry): DiagnosticEntry {
  const result: DiagnosticEntry = {};
  for (const [key, value] of Object.entries(entry)) {
    if (
      numberKeys.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      result[key] = value;
    else if (tokenKeys.has(key) && token(value)) result[key] = value;
    else if (
      [
        "diagnosticId",
        "requestId",
        "parentRequestId",
        "parentDiagnosticId",
        "sessionId",
        "runId",
        "jobId",
        "operationId",
      ].includes(key) &&
      token(value)
    )
      result[key] = value;
    else if (
      key === "at" &&
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(value) &&
      Number.isFinite(Date.parse(value))
    )
      result[key] = value;
    else if (
      key === "route" &&
      typeof value === "string" &&
      /^\/api\/(?:v2\/)?[A-Za-z/:_-]+$/.test(value)
    )
      result[key] = value;
    else if (
      key === "resource" &&
      typeof value === "string" &&
      [
        "workspace.v2.json",
        "workspace.v2.previous.json",
        "config.json",
        "runs-v2/*.json",
        "backups/*.json",
        ".workspace.lock",
      ].includes(value)
    )
      result[key] = value;
    else if (
      ["cacheHit", "hasMore"].includes(key) &&
      typeof value === "boolean"
    )
      result[key] = value;
    else if (["counts", "coverage", "usage"].includes(key))
      result[key] = numericTree(value);
    else if (key === "parser" && object(value)) {
      const p = numericTree(value) || {};
      if (
        typeof value.format === "string" &&
        ["json", "html", "pdf", "docx", "text"].includes(value.format)
      )
        p.format = value.format;
      for (const boolean of ["selectorPresent", "titleOnly"])
        if (typeof value[boolean] === "boolean") p[boolean] = value[boolean];
      if (token(value.version)) p.version = value.version;
      if (
        typeof value.resultType === "string" &&
        [
          "object",
          "array",
          "null",
          "string",
          "number",
          "boolean",
          "unknown",
        ].includes(value.resultType)
      )
        p.resultType = value.resultType;
      if (Array.isArray(value.missingFields))
        p.missingFields = value.missingFields.filter(
          (field) =>
            typeof field === "string" &&
            [
              "data",
              "list",
              "description",
              "title",
              "url",
              "sourceId",
              "records",
              "count",
              "id",
            ].includes(field),
        );
      result.parser = p;
    } else if (key === "runtime" && object(value)) {
      const r: DiagnosticEntry = {};
      for (const version of [
        "appVersion",
        "nodeVersion",
        "electronVersion",
        "chromeVersion",
        "osRelease",
      ])
        if (
          typeof value[version] === "string" &&
          /^v?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?$/.test(value[version])
        )
          r[version] = value[version];
      if (
        typeof value.platform === "string" &&
        ["win32", "linux", "darwin"].includes(value.platform)
      )
        r.platform = value.platform;
      if (
        typeof value.arch === "string" &&
        ["x64", "arm64", "ia32"].includes(value.arch)
      )
        r.arch = value.arch;
      if (typeof value.packaged === "boolean") r.packaged = value.packaged;
      if (
        typeof value.buildId === "string" &&
        /^[a-f0-9]{40}$/.test(value.buildId)
      )
        r.buildId = value.buildId;
      result.runtime = r;
    } else if (key === "error" && object(value)) {
      const e: DiagnosticEntry = {};
      if (token(value.code)) e.code = value.code;
      if (
        typeof value.name === "string" &&
        [
          "Error",
          "TypeError",
          "RangeError",
          "SyntaxError",
          "AbortError",
          "TimeoutError",
        ].includes(value.name)
      )
        e.name = value.name;
      const frames =
        typeof value.stack === "string"
          ? value.stack
              .split("\n")
              .flatMap((line) => {
                const match = line
                  .replaceAll("\\", "/")
                  .match(
                    /(?:src|electron|public\/js)\/[A-Za-z0-9_./-]+:\d+:\d+|node:[A-Za-z0-9_./-]+:\d+:\d+/,
                  );
                return match ? ["at " + match[0]] : [];
              })
              .slice(0, 16)
          : [];
      if (frames.length) e.stack = frames.join("\n");
      if (object(value.cause) && token(value.cause.code))
        e.cause = { code: value.cause.code };
      result.error = e;
    }
  }
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  );
}

export function DiagnosticDetails({
  entry,
  onClose,
}: {
  entry: DiagnosticEntry | null;
  onClose(): void;
}) {
  return (
    <Sheet
      open={Boolean(entry)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>诊断详情</SheetTitle>
          <SheetDescription>
            仅显示请求过程、计数、运行环境和匿名编号，不包含私人正文或路径。
          </SheetDescription>
        </SheetHeader>
        {entry && (
          <pre className="whitespace-pre-wrap break-all p-4">
            {JSON.stringify(safeDiagnostic(entry), null, 2)}
          </pre>
        )}
      </SheetContent>
    </Sheet>
  );
}
