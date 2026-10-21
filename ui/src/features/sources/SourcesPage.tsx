import { useEffect, useRef, useState } from "react";
import type { ApiClient, DesktopAdapter } from "../../lib/types";
import { createDesktopAdapter } from "../../lib/desktop";
import { useVersionContext } from "../../app/VersionContext";
import { useCollectionActivity } from "../../app/CollectionContext";
import { JobUpdatePanel } from "../workbench/JobUpdatePanel";
import { buildHash } from "../../app/router";
import { TextField } from "../../components/TextField";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../components/ui/select";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import {
  SiteDialog,
  type SourceSummary,
  type SourceSite,
  type SourceHealth,
} from "./SiteDialog";
import {
  SourceDetailsSheet,
  type SourceSiteFilters,
} from "./SourceDetailsSheet";
import {
  sourceRows,
  sourceCategories,
  sourceHealthStatuses,
  sourceHasProblems,
  sourceReadySiteCount,
  sourceProbeHealth,
  sourceLastAttemptAt,
  sourceIssueLabel,
  categoryLabel,
  sourceStatusLabels,
  sourceDraft,
  type SourceDraft,
  type SourceFilters,
} from "./source-view";
import { formatDate } from "../../../../public/js/format.js";

type Catalog = { sources: SourceSummary[]; sites: SourceSite[] };
const initialFilters: SourceFilters = {
  query: "",
  category: "all",
  enabled: "all",
  health: "all",
  page: 1,
};
function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(v) => onChange(v || "all")}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function SourcesPage({
  api,
  desktop = createDesktopAdapter(),
}: {
  api: ApiClient;
  desktop?: DesktopAdapter;
}) {
  const ctx = useVersionContext();
  const collections = useCollectionActivity();
  const key = JSON.stringify([ctx.scope, ctx.generation]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [catalogState, setCatalog] = useState<{
    key: string;
    value: Catalog | null;
  }>({ key, value: null });
  const [errorState, setError] = useState<{ key: string; error: unknown }>({
    key,
    error: null,
  });
  const [details, setDetails] = useState<{
    key: string;
    sourceId: string;
  } | null>(null);
  const [siteDialog, setSiteDialog] = useState<string | null>(null);
  const [draftState, setDrafts] = useState<{
    key: string;
    values: Record<string, SourceDraft>;
  }>({ key, values: {} });
  const [filterState, setFilters] = useState({ key, value: initialFilters });
  const [siteFilterState, setSiteFilters] = useState<{
    key: string;
    values: Record<string, SourceSiteFilters>;
  }>({ key, values: {} });
  const [refresh, setRefresh] = useState(0);
  const catalog = catalogState.key === key ? catalogState.value : null;
  const error = errorState.key === key ? errorState.error : null;
  const filters = filterState.key === key ? filterState.value : initialFilters;
  const drafts = draftState.key === key ? draftState.values : {};
  const siteFilters = siteFilterState.key === key ? siteFilterState.values : {};
  const opened =
    details?.key === key
      ? catalog?.sources.find((s) => s.sourceId === details.sourceId)
      : null;
  useEffect(() => {
    setDrafts((prev) => (prev.key === key ? prev : { key, values: {} }));
    setFilters((prev) =>
      prev.key === key ? prev : { key, value: initialFilters },
    );
    setDetails((prev) => (prev?.key === key ? prev : null));
    setSiteFilters((prev) => (prev.key === key ? prev : { key, values: {} }));
    setSiteDialog((prev) => (prev === key ? prev : null));
  }, [key]);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setError({ key, error: null });
    api
      .request<Catalog>("/sources", {
        signal: controller.signal,
        scope: ctx.scope ?? undefined,
      })
      .then((data) => {
        if (live && currentKey.current === key)
          setCatalog({ key, value: data });
      })
      .catch((error) => {
        if (live && !controller.signal.aborted && currentKey.current === key)
          setError({ key, error });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, refresh, key]);
  function updateFilters(patch: Partial<SourceFilters>) {
    setFilters({ key, value: { ...filters, ...patch, page: patch.page ?? 1 } });
  }
  function onHealth(sourceId: string, siteId: string, health: SourceHealth) {
    if (currentKey.current !== key) return;
    setCatalog((prev) =>
      prev.key === key && prev.value
        ? {
            key,
            value: {
              sources: prev.value.sources.map((s) =>
                s.sourceId === sourceId
                  ? {
                      ...s,
                      health: [
                        ...(s.health || []).filter((h) => h.siteId !== siteId),
                        { ...health, siteId },
                      ],
                    }
                  : s,
              ),
              sites: prev.value.sites.map((s) =>
                s.siteId === siteId ? { ...s, health } : s,
              ),
            },
          }
        : prev,
    );
  }
  const sources = catalog?.sources || [];
  const sites = catalog?.sites || [];
  const result = sourceRows(sources, sites, filters);
  const categories = [
    ...new Set(sources.flatMap((s) => sourceCategories(s, sites))),
  ];
  const statuses = [
    ...new Set(sources.flatMap((s) => sourceHealthStatuses(s, sites))),
  ];
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>招聘来源</h1>
          <p className="text-muted-foreground">
            来源目录共享；启用配置和登录按当前版本保存。探针包含共享历史与本版本检查；当前岗位在招状态需要独立核验。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setRefresh((v) => v + 1)}>
            刷新来源
          </Button>
          <Button
            disabled={!catalog || !ctx.scope}
            onClick={() => setSiteDialog(key)}
          >
            添加目录站点
          </Button>
        </div>
      </header>
      {!ctx.scope && (
        <p className="text-muted-foreground">
          选择一个目标版本后可添加目录站点。
        </p>
      )}
      <JobUpdatePanel />
      {catalog && (
        <section
          aria-label="来源状态摘要"
          className="rounded-lg border bg-card p-4"
        >
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt>目录来源</dt>
              <dd>{sources.length} 个</dd>
            </div>
            <div>
              <dt>{ctx.scope ? "本版本启用" : "目录默认启用"}</dt>
              <dd>
                {
                  sources.filter((source) => source.config?.enabled !== false)
                    .length
                }{" "}
                个
              </dd>
            </div>
            <div>
              <dt>有有效样本探针记录</dt>
              <dd>
                {
                  sources.filter(
                    (source) => sourceReadySiteCount(source, sites) > 0,
                  ).length
                }{" "}
                个来源
              </dd>
            </div>
            <div>
              <dt>有运行问题</dt>
              <dd>
                {
                  sources.filter((source) => sourceHasProblems(source, sites))
                    .length
                }{" "}
                个来源
              </dd>
            </div>
          </dl>
        </section>
      )}
      <OperationFeedback error={error} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
          <TextField
            name="source-search"
            label="搜索来源"
            value={filters.query}
            onChange={(query) => updateFilters({ query })}
          />
        </div>
        <FilterSelect
          label="来源类别"
          value={filters.category}
          options={[
            { value: "all", label: "全部类别" },
            ...categories.map((value) => ({
              value,
              label: categoryLabel(value),
            })),
          ]}
          onChange={(category) => updateFilters({ category })}
        />
        <FilterSelect
          label="来源启用状态"
          value={filters.enabled}
          options={[
            { value: "all", label: "全部启用状态" },
            { value: "enabled", label: "已启用" },
            { value: "disabled", label: "未启用" },
          ]}
          onChange={(enabled) =>
            updateFilters({ enabled: enabled as SourceFilters["enabled"] })
          }
        />
        <FilterSelect
          label="来源探针状态"
          value={filters.health}
          options={[
            { value: "all", label: "全部探针状态" },
            ...statuses.map((value) => ({
              value,
              label: sourceStatusLabels[value] || value,
            })),
          ]}
          onChange={(health) => updateFilters({ health })}
        />
      </div>
      {!catalog && !error ? (
        <Skeleton className="h-40 w-full" />
      ) : result.items.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {result.items.map((source) => {
            const owned = sites.filter((s) => s.providerId === source.sourceId);
            const ready = sourceReadySiteCount(source, owned);
            const issues = sourceProbeHealth(source, owned).flatMap(
              (health) => health.issues || [],
            );
            const checkedAt = sourceLastAttemptAt(source, owned);
            const unmatchedHistory = source.health?.some(
              (health) => !owned.some((site) => site.siteId === health.siteId),
            );
            return (
              <Card
                key={source.sourceId}
                role="region"
                aria-label={source.name + "来源摘要"}
              >
                <CardHeader>
                  <CardTitle>{source.name}</CardTitle>
                  <CardDescription>
                    {owned.length} 个目录站点 · {ready} 个探针取得有效样本站点
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">
                      {source.config?.enabled === false ? "未启用" : "已启用"}
                    </Badge>
                    {sourceCategories(source, owned).map((category) => (
                      <Badge key={category} variant="secondary">
                        {categoryLabel(category)}
                      </Badge>
                    ))}
                  </div>
                  <p>最近探针：{formatDate(checkedAt)}</p>
                  {source.sourceId === "boss" && (
                    <p className="text-sm text-muted-foreground">
                      登录入口：查看来源配置 → Boss直聘独立登录 →
                      打开独立采集窗口。
                    </p>
                  )}
                  {unmatchedHistory && (
                    <p className="text-sm text-muted-foreground">
                      来源历史探针（未关联目录站点）
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {sourceHealthStatuses(source, owned)
                      .map((status) => sourceStatusLabels[status] || status)
                      .join("、")}
                  </p>
                  {!!issues.length && (
                    <p className="text-sm">
                      运行问题：
                      {issues
                        .map(sourceIssueLabel)
                        .filter((v, i, values) => values.indexOf(v) === i)
                        .join("；")}
                    </p>
                  )}
                  {issues.find((issue) => issue.diagnosticId)?.diagnosticId && (
                    <a
                      className="text-primary underline"
                      href={buildHash({
                        page: "logs",
                        selection: ctx.selection,
                        filters: {
                          tab: "system",
                          diagnosticId: issues.find(
                            (issue) => issue.diagnosticId,
                          )!.diagnosticId!,
                        },
                      })}
                    >
                      查看来源问题日志
                    </a>
                  )}
                </CardContent>
                <CardFooter>
                  <Button
                    variant="outline"
                    onClick={() =>
                      setDetails({ key, sourceId: source.sourceId })
                    }
                  >
                    查看来源配置
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      ) : (
        !error && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无匹配的招聘来源</EmptyTitle>
              <EmptyDescription>
                调整筛选，或添加公开目录站点后检查采集能力。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      )}
      {catalog && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={filters.page <= 1}
            onClick={() => updateFilters({ page: filters.page - 1 })}
          >
            上一页来源
          </Button>
          <p>
            第 {filters.page} 页 · 共 {result.total} 个来源
          </p>
          <Button
            variant="outline"
            disabled={filters.page * 20 >= result.total}
            onClick={() => updateFilters({ page: filters.page + 1 })}
          >
            下一页来源
          </Button>
        </div>
      )}
      {opened && (
        <SourceDetailsSheet
          key={key + opened.sourceId}
          api={api}
          desktop={desktop}
          source={opened}
          sites={sites.filter((s) => s.providerId === opened.sourceId)}
          activity={collections.activity}
          scope={ctx.scope}
          generation={ctx.generation}
          draft={drafts[opened.sourceId] || sourceDraft(opened)}
          siteFilters={siteFilters[opened.sourceId] || { query: "", page: 1 }}
          onSiteFiltersChange={(filters) => {
            if (currentKey.current === key)
              setSiteFilters((prev) => ({
                key,
                values: {
                  ...(prev.key === key ? prev.values : {}),
                  [opened.sourceId]: filters,
                },
              }));
          }}
          onDraftChange={(draft) => {
            if (currentKey.current === key)
              setDrafts((prev) => ({
                key,
                values: {
                  ...(prev.key === key ? prev.values : {}),
                  [opened.sourceId]: draft,
                },
              }));
          }}
          onClose={() => setDetails(null)}
          onChanged={() => {
            if (currentKey.current === key) setRefresh((v) => v + 1);
          }}
          onHealth={(siteId, health) =>
            onHealth(opened.sourceId, siteId, health)
          }
        />
      )}
      {catalog && ctx.scope && (
        <SiteDialog
          key={key}
          api={api}
          open={siteDialog === key}
          onClose={() => setSiteDialog(null)}
          sources={sources}
          sites={sites}
          onSaved={(site) => {
            if (currentKey.current === key)
              setCatalog((prev) =>
                prev.key === key && prev.value
                  ? {
                      key,
                      value: {
                        ...prev.value,
                        sites: [...prev.value.sites, site],
                      },
                    }
                  : prev,
              );
          }}
        />
      )}
    </section>
  );
}
