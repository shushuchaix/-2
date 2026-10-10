import { inputError } from "../../public/js/validation-rules.js";
import { identifier } from "./validation.mjs";

const paths = new Set([
  "/api/v2/diagnostics/logs",
  "/api/v2/diagnostics/logs/export",
]);
const filterKeys = [
  "runId",
  "limit",
  "level",
  "category",
  "diagnosticId",
  "requestId",
  "sourceId",
  "siteId",
];
export function isDiagnosticRead(req) {
  return (
    req.method === "GET" &&
    paths.has(new URL(req.url, "http://localhost").pathname)
  );
}

/** Parses safe log metadata only; never reads a workspace or grants business access. */
export function parseDiagnosticQuery(url, { allowScope = false } = {}) {
  const exporting = url.pathname.endsWith("/export"),
    options = {},
    allowed = new Set(filterKeys);
  if (allowScope)
    for (const key of ["packageId", "targetRevisionId", "allTargets"])
      allowed.add(key);
  for (const key of url.searchParams.keys())
    if (!allowed.has(key))
      throw inputError({ filters: "日志查询包含不支持的条件。" });
  for (const key of ["runId", "sourceId", "siteId"]) {
    const value = url.searchParams.get(key);
    if (value) options[key] = identifier(value);
  }
  for (const [key, prefix] of [
    ["diagnosticId", "d"],
    ["requestId", "q"],
  ]) {
    const value = url.searchParams.get(key);
    if (value) {
      if (
        !new RegExp(
          "^" +
            prefix +
            "-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
        ).test(value)
      )
        throw inputError({ [key]: "请填写完整的诊断编号。" });
      options[key] = value;
    }
  }
  for (const [key, values] of [
    ["level", ["info", "warn", "error", "problem"]],
    [
      "category",
      [
        "run",
        "network",
        "storage",
        "http",
        "source",
        "model",
        "desktop",
        "application",
      ],
    ],
  ]) {
    const value = url.searchParams.get(key);
    if (value) {
      if (!values.includes(value))
        throw inputError({ [key]: "请选择支持的日志筛选条件。" });
      options[key] = value;
    }
  }
  const raw = url.searchParams.get("limit"),
    limit = raw === null ? (exporting ? undefined : 200) : Number(raw),
    maximum = exporting ? 5000 : 200;
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
  )
    throw inputError({ limit: "请填写 1–" + maximum + " 的整数。" });
  if (limit !== undefined) options.limit = limit;
  return { exporting, options };
}

export async function sendDiagnosticResult(
  req,
  res,
  { http, diagnostics },
  { exporting, options },
) {
  if (exporting) {
    const text = await diagnostics.exportText(options);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="job-radar-diagnostics.txt"',
      "Cache-Control": "no-store",
    });
    res.end(text);
  } else http.json(req, res, 200, await diagnostics.list(options));
}

/** The caller owns authentication. This whitelist works when storage cannot initialize. */
export async function handleDiagnosticRead(req, res, context) {
  if (!isDiagnosticRead(req)) return false;
  const query = parseDiagnosticQuery(new URL(req.url, "http://localhost"));
  await sendDiagnosticResult(req, res, context, query);
  return true;
}
