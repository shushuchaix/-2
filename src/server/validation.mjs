import { APPLICATION_STATUSES } from "../domain/contracts.mjs";
export function invalid(message, status = 400) {
  const error = Error(message);
  error.status = status;
  throw error;
}
export function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("JSON object required");
  return value;
}
export function identifier(value, { revision = false } = {}) {
  if (
    typeof value !== "string" ||
    !new RegExp(
      revision ? "^[A-Za-z0-9_-]+@[1-9][0-9]*$" : "^[A-Za-z0-9_-]{1,160}$",
    ).test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    invalid("Invalid ID");
  return value;
}
export function jobIdentifier(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1000 ||
    /[\u0000-\u001f]/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    invalid("Invalid job ID");
  return value;
}
export function date(value) {
  if (value === null) return value;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    invalid("Invalid date");
  return value;
}
export function resumeText(value) {
  if (typeof value !== "string" || value.trim().length < 30)
    invalid("简历内容太短（至少30个字符）");
  if (value.trim().length > 60000) invalid("简历内容过长（上限6万字符）", 413);
  return value.trim();
}
export function filters(params) {
  const result = {};
  for (const key of ["page", "pageSize"])
    if (params.has(key)) {
      const raw = params.get(key);
      if (
        !/^[1-9]\d*$/.test(raw) ||
        !Number.isSafeInteger(Number(raw)) ||
        (key === "pageSize" && Number(raw) > 200)
      )
        invalid("Invalid pagination");
      result[key] = Number(raw);
    }
  for (const key of [
    "search",
    "sourceId",
    "targetId",
    "targetRevisionId",
    "status",
    "kind",
    "qualification",
    "recommendation",
  ])
    if (params.has(key)) result[key] = params.get(key);
  if (result.search?.length > 2000) invalid("Search too long");
  if (result.status && !APPLICATION_STATUSES.includes(result.status))
    invalid("Invalid application status");
  if (
    result.kind &&
    !["job", "recruitment_notice", "company_campaign"].includes(result.kind)
  )
    invalid("Invalid kind");
  if (
    result.qualification &&
    !["pass", "fail", "unknown"].includes(result.qualification)
  )
    invalid("Invalid qualification");
  if (params.has("since")) result.since = date(params.get("since"));
  if (params.has("cities"))
    result.cities = params
      .get("cities")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return result;
}
export function applicationPatch(input) {
  object(input);
  for (const key of ["appliedAt", "followUpAt"])
    if (Object.hasOwn(input, key)) date(input[key]);
  if (input.resumeRevisionId !== undefined && input.resumeRevisionId !== null)
    identifier(input.resumeRevisionId, { revision: true });
  return input;
}
export async function readJsonBody(req, limit = 40 * 1024 * 1024) {
  const bytes = await new Promise((resolve, reject) => {
    let size = 0,
      overflow = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        if (!overflow) {
          overflow = true;
          chunks.length = 0;
          const error = Error("Request body too large");
          error.status = 413;
          reject(error);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overflow) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
  if (!bytes.length) return {};
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("请求体不是合法JSON");
  }
  return object(value);
}
export function userCredentials(input, cfg) {
  const key = String(input.userApiKey || "").trim();
  if (key) {
    if (!cfg.deepseek.allowUserKey) invalid("本站不允许使用自带API Key", 403);
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) invalid("自带API Key格式不正确");
  }
  return key ? { userApiKey: key } : {};
}
