import type { SourceSummary, SourceSite, SourceHealth } from "./SiteDialog";

export type SourceFilters = {
  query: string;
  category: string;
  enabled: "all" | "enabled" | "disabled";
  health: string;
  page: number;
};
export type SourceDraft = { enabled: boolean; urls: string; accounts: string };
export const sourceStatusLabels: Record<string, string> = {
  ready: "最近探针取得有效样本",
  candidate: "目录候选，未验证正文",
  empty: "未取得有效样本",
  restricted: "读取受限",
  login_required: "需要认证后读取",
  parse_error: "页面结构无法解析",
  content_non_json: "返回 HTML 等非 JSON 内容",
  unavailable: "暂时不可访问",
  budget_exhausted: "累计额度不足，检查未完成",
  source_budget_exhausted: "累计额度不足，检查未完成",
  skipped: "未配置或已跳过",
  unknown: "暂无探针记录",
};
export const sourceCategoryLabels: Record<string, string> = {
  unknown: "未分类",
  national: "全国招聘",
  public: "公开公告",
  employer: "企业招聘",
  university: "高校招聘",
  education: "教育招聘",
  government: "政府招聘",
  social_discovery: "社交发现",
  job_board: "招聘平台",
  campus_aggregator: "校园招聘聚合",
  custom: "自定义目录",
};
export const categoryLabel = (value: string) =>
  sourceCategoryLabels[value] || value;
export function sourceDraft(source: SourceSummary): SourceDraft {
  return {
    enabled: source.config?.enabled !== false,
    urls: Array.isArray(source.config?.articleUrls)
      ? source.config.articleUrls.join("\n")
      : "",
    accounts: Array.isArray(source.config?.accountIds)
      ? source.config.accountIds.join("\n")
      : "",
  };
}
export function sourceCategories(
  source: SourceSummary,
  sites: SourceSite[],
): string[] {
  const categories = [
    source.capabilities?.category,
    ...sites
      .filter((s) => s.providerId === source.sourceId)
      .map((s) => s.category),
  ].filter((v): v is string => typeof v === "string" && !!v.trim());
  return [...new Set(categories.length ? categories : ["unknown"])];
}
export function siteHealth(
  source: SourceSummary,
  site: SourceSite,
): SourceHealth | undefined {
  return source.health?.find((h) => h.siteId === site.siteId) || site.health;
}
type SourceIssue = NonNullable<SourceHealth["issues"]>[number];
function isBudgetIssue(issue: SourceIssue): boolean {
  return (
    /^(?:source_)?budget_exhausted$/.test(issue.code || "") ||
    ((!issue.code ||
      ["unavailable", "source_probe_failed"].includes(issue.code)) &&
      /^(?:source_)?budget_exhausted(?::|\s|$)/.test(issue.message || ""))
  );
}
export function probeStatus(health?: SourceHealth): string {
  if (
    health?.status === "unavailable" &&
    health.issues?.length &&
    health.issues.every(isBudgetIssue)
  )
    return "budget_exhausted";
  return health?.status || "unknown";
}
export function sourceIssueLabel(issue: SourceIssue): string {
  if (isBudgetIssue(issue)) return sourceStatusLabels.budget_exhausted;
  const labels: Record<string, string> = {
    network_error: "网络读取失败",
    request_timeout: "读取超时",
    http_timeout: "读取超时",
    rate_limited: "读取频率受限",
    http_forbidden: "读取受限",
    captcha: "需要验证后读取",
    challenge_required: "需要验证后读取",
    risk_blocked: "来源读取被风险检查阻止",
    boss_environment_risk: "Boss 环境风险，已停止读取",
    boss_account_risk: "Boss 账号风险，已停止读取",
    boss_risk_blocked: "Boss 读取被风险检查阻止",
    boss_auth_expired: "Boss 登录已过期",
    boss_login_required: "Boss 需要登录后读取",
    boss_ajax_unavailable: "Boss 页面读取组件未就绪",
    boss_transport_failed: "Boss 招聘接口连接失败",
    boss_response_invalid: "Boss 招聘接口返回内容无法识别",
    boss_rate_limited: "Boss 读取频率受限",
    collection_browser_timeout: "招聘页面加载或读取超时",
    collection_browser_output_limit: "招聘页面内容超过读取上限",
    session_unavailable: "登录会话不可用",
    detail_unavailable: "正文读取失败",
    detail_insufficient: "正文证据不足",
    body_unverified: "正文待验证",
    list_unverified: "列表待验证",
    invalid_record: "未取得有效招聘记录",
    service_disabled: "读取服务未启用",
    not_configured: "尚未配置",
    template_not_configured: "尚未配置公告列表与正文模板",
    candidate_not_verified: "目录候选，尚未验证采集能力",
    page_limit_reached: "已达到本次分页上限",
  };
  return (
    labels[issue.code || ""] ||
    sourceStatusLabels[issue.code || ""] ||
    "检查遇到问题"
  );
}
export function sourceProbeHealth(
  source: SourceSummary,
  sites: SourceSite[],
): SourceHealth[] {
  const owned = sites.filter((site) => site.providerId === source.sourceId);
  const ids = new Set(owned.map((site) => site.siteId));
  return [
    ...owned
      .map((site) => siteHealth(source, site))
      .filter((health): health is SourceHealth => !!health),
    ...(source.health || []).filter((health) => !ids.has(health.siteId || "")),
  ];
}
export function sourceReadySiteCount(
  source: SourceSummary,
  sites: SourceSite[],
): number {
  return sites.filter(
    (site) =>
      site.providerId === source.sourceId &&
      probeStatus(siteHealth(source, site)) === "ready",
  ).length;
}
export function sourceLastAttemptAt(
  source: SourceSummary,
  sites: SourceSite[],
): string | undefined {
  return sourceProbeHealth(source, sites)
    .map((health) => health.lastAttemptAt || health.checkedAt)
    .filter(
      (value): value is string =>
        typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
export function sourceHealthStatuses(
  source: SourceSummary,
  sites: SourceSite[],
): string[] {
  const owned = sites.filter((site) => site.providerId === source.sourceId);
  const ids = new Set(owned.map((site) => site.siteId));
  const states = [
    ...owned.map((site) => probeStatus(siteHealth(source, site))),
    ...(source.health || [])
      .filter(
        (health) =>
          !ids.has(health.siteId || "") && probeStatus(health) !== "ready",
      )
      .map((health) => probeStatus(health)),
  ];
  return [...new Set(states.length ? states : ["unknown"])];
}
export function sourceHasProblems(
  source: SourceSummary,
  sites: SourceSite[],
): boolean {
  const problemStates = new Set([
    "empty",
    "restricted",
    "login_required",
    "parse_error",
    "content_non_json",
    "unavailable",
    "budget_exhausted",
    "source_budget_exhausted",
  ]);
  return (
    sourceHealthStatuses(source, sites).some((status) =>
      problemStates.has(status),
    ) ||
    sourceProbeHealth(source, sites).some((health) => !!health.issues?.length)
  );
}
export function sourceRows(
  sources: SourceSummary[],
  sites: SourceSite[],
  filters: SourceFilters,
): { items: SourceSummary[]; total: number } {
  const query = filters.query.trim().toLocaleLowerCase();
  const filtered = sources.filter((source) => {
    const owned = sites.filter((s) => s.providerId === source.sourceId);
    return (
      (!query ||
        [
          source.name,
          source.sourceId,
          ...owned.map((s) => s.name + " " + (s.origin || "")),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)) &&
      (filters.category === "all" ||
        sourceCategories(source, owned).includes(filters.category)) &&
      (filters.enabled === "all" ||
        (source.config?.enabled !== false) ===
          (filters.enabled === "enabled")) &&
      (filters.health === "all" ||
        sourceHealthStatuses(source, owned).includes(filters.health))
    );
  });
  const page = Math.max(1, filters.page);
  return {
    items: filtered.slice((page - 1) * 20, page * 20),
    total: filtered.length,
  };
}
