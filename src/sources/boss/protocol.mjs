export const BOSS_SEARCH_URL =
  "https://www.zhipin.com/wapi/zpgeek/search/joblist.json";
export const BOSS_DETAIL_URL =
  "https://www.zhipin.com/wapi/zpgeek/job/card.json";
const invalid = () =>
  Object.assign(Error("Boss读取参数无效。"), {
    code: "boss_request_invalid",
    retryable: false,
  });
const bounded = (value, max, optional = false) =>
  typeof value === "string" &&
  value.length <= max &&
  (optional || value.trim().length > 0);
export function buildBossOperation(input = {}) {
  const search = input.kind === "boss.search";
  const detail = input.kind === "boss.detail";
  const allowed = search
    ? ["kind", "query", "city", "page", "pageSize"]
    : ["kind", "securityId", "lid"];
  if (
    (!search && !detail) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    throw invalid();
  if (search) {
    const { query, city, page = 1, pageSize = 15 } = input;
    if (
      !bounded(query, 80) ||
      (city !== undefined && !/^\d{9}$/.test(city)) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 20 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 30
    )
      throw invalid();
    return {
      kind: input.kind,
      method: "POST",
      url: BOSS_SEARCH_URL,
      parameters: {
        query: query.trim(),
        ...(city ? { city } : {}),
        page,
        pageSize,
        scene: 1,
      },
    };
  }
  const { securityId, lid = "" } = input;
  if (!bounded(securityId, 2048) || !bounded(lid, 256, true)) throw invalid();
  return {
    kind: input.kind,
    method: "GET",
    url: BOSS_DETAIL_URL,
    parameters: { securityId, lid },
  };
}
export function parseBossResponse({ kind, status, payload, checkedAt }) {
  const out = (state, code) => ({ status: state, code, checkedAt });
  if (!["boss.search", "boss.detail"].includes(kind))
    return out("unavailable", "boss_response_invalid");
  if (payload?.code === 36) return out("risk_blocked", "boss_account_risk");
  if (payload?.code === 37) {
    const message =
      [payload.message, payload.msg, payload.error, payload.zpData].find(
        (v) => typeof v === "string",
      ) || "";
    if (
      /环境存在异常|环境异常|访问环境异常|请求环境异常/.test(message) ||
      !/__zp_stoken__|stoken|token|登录态过期|登录状态过期|登录状态已失效|登录已过期|凭证过期|认证过期/i.test(
        message,
      )
    )
      return out("risk_blocked", "boss_environment_risk");
    return out("login_required", "boss_auth_expired");
  }
  if (status === 429 || payload?.code === 9)
    return out("rate_limited", "boss_rate_limited");
  if ([401, 403].includes(status))
    return out("login_required", "boss_login_required");
  if (
    status !== 200 ||
    payload?.code !== 0 ||
    !payload.zpData ||
    typeof payload.zpData !== "object"
  )
    return out("unavailable", "boss_response_invalid");
  if (kind === "boss.search") {
    if (
      !Array.isArray(payload.zpData.jobList) ||
      payload.zpData.jobList.length > 30 ||
      typeof payload.zpData.hasMore !== "boolean"
    )
      return out("unavailable", "boss_response_invalid");
    return {
      status: "success",
      records: payload.zpData.jobList,
      hasMore: payload.zpData.hasMore,
      checkedAt,
    };
  }
  const detail = payload.zpData.jobCard;
  if (!detail || typeof detail !== "object" || Array.isArray(detail))
    return out("unavailable", "boss_response_invalid");
  if (
    typeof detail.postDescription !== "string" ||
    !detail.postDescription.trim()
  )
    return out("unavailable", "detail_insufficient");
  return { status: "success", detail, checkedAt };
}
