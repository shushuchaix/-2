import { APPLICATION_STATUSES } from "../domain/contracts.mjs";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
export {
  validateCollectionLimits,
  collectionLimitsFor,
} from "../../public/js/validation-rules.js";
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
    !/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$)/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) !==
      value.slice(0, 10)
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
      result[key] = raw;
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
    "applicationStatus",
    "duplicateStatus",
    "openingStatus",
  ])
    if (params.has(key)) result[key] = params.get(key);
  if (params.has("since")) result.since = params.get("since");
  if (params.has("cities"))
    result.cities = params
      .get("cities")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  assertInput("filters", result);
  for (const key of ["page", "pageSize"])
    if (Object.hasOwn(result, key)) result[key] = Number(result[key]);
  return result;
}
export function applicationPatch(input) {
  assertInput("application", input);
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
  assertInput("key", { userApiKey: input.userApiKey });
  const key = input.userApiKey || "";
  if (key) {
    if (!cfg.deepseek.allowUserKey) invalid("本站不允许使用自带API Key", 403);
  }
  return key ? { userApiKey: key } : {};
}
