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
export function sourceHealthStatuses(
  source: SourceSummary,
  sites: SourceSite[],
): string[] {
  const states = [
    ...(source.health || []).map((h) => h.status),
    ...sites
      .filter((s) => s.providerId === source.sourceId)
      .map((s) => siteHealth(source, s)?.status || s.status),
  ].filter((v): v is string => typeof v === "string" && !!v);
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
  ]);
  return (
    sourceHealthStatuses(source, sites).some((status) =>
      problemStates.has(status),
    ) ||
    [
      ...(source.health || []),
      ...sites
        .filter((site) => site.providerId === source.sourceId)
        .map((site) => siteHealth(source, site)),
    ].some((health) => !!health?.issues?.length)
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
