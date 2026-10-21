import { useState } from "react";
import type {
  ApiClient,
  DesktopAdapter,
  CollectionActivity,
  Scope,
} from "../../lib/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";
import { Button } from "../../components/ui/button";
import { TextField } from "../../components/TextField";
import { SourceSettings } from "./SourceSettings";
import { SiteProbeCard } from "./SiteProbeCard";
import { sourceDraft, siteHealth, type SourceDraft } from "./source-view";
import type { SourceSummary, SourceSite, SourceHealth } from "./SiteDialog";

export type SourceSiteFilters = { query: string; page: number };
export type SourceDetailsProps = {
  api: ApiClient;
  desktop: DesktopAdapter;
  source: SourceSummary | null;
  sites: SourceSite[];
  activity: CollectionActivity | null;
  scope: Scope | null;
  onClose(): void;
  onChanged(): void;
  generation?: number;
  draft?: SourceDraft;
  onDraftChange?(draft: SourceDraft): void;
  onHealth?(siteId: string, health: SourceHealth): void;
  siteFilters?: SourceSiteFilters;
  onSiteFiltersChange?(filters: SourceSiteFilters): void;
};
export function SourceDetailsSheet({
  api,
  desktop,
  source,
  sites,
  activity,
  scope,
  generation = 0,
  draft,
  onDraftChange,
  onHealth,
  onClose,
  onChanged,
  siteFilters,
  onSiteFiltersChange,
}: SourceDetailsProps) {
  const [localFilters, setLocalFilters] = useState<SourceSiteFilters>({
    query: "",
    page: 1,
  });
  const { query, page } = siteFilters || localFilters;
  function changeFilters(next: SourceSiteFilters) {
    setLocalFilters(next);
    onSiteFiltersChange?.(next);
  }
  const [localDraft, setLocalDraft] = useState(() =>
    source ? sourceDraft(source) : { enabled: false, urls: "", accounts: "" },
  );
  if (!source) return <></>;
  const filtered = sites.filter((site) =>
    (site.name + " " + (site.origin || ""))
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const visible = filtered.slice((page - 1) * 20, page * 20);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="flex flex-col gap-6 overflow-y-auto p-6 sm:!max-w-3xl">
        <SheetHeader>
          <SheetTitle>{source.name}来源配置</SheetTitle>
          <SheetDescription>
            目录站点共享；启用配置、公开链接、账号标识和登录按当前版本保存。
          </SheetDescription>
        </SheetHeader>
        <Button variant="outline" onClick={onClose}>
          关闭来源详情
        </Button>
        {scope ? (
          <SourceSettings
            api={api}
            desktop={desktop}
            source={source}
            scope={scope}
            activity={activity}
            generation={generation}
            draft={draft || localDraft}
            onDraftChange={(next) => {
              setLocalDraft(next);
              onDraftChange?.(next);
            }}
            onChanged={onChanged}
          />
        ) : (
          <p>全部目标视图仅可阅读共享目录。选择一个版本后配置来源或登录。</p>
        )}
        <section aria-label="来源目录站点" className="flex flex-col gap-4">
          <h2>目录站点</h2>
          <TextField
            name="source-site-search"
            label="搜索此来源站点"
            value={query}
            onChange={(value) => changeFilters({ query: value, page: 1 })}
          />
          <p>
            第 {page} 页 · 共 {filtered.length} 个站点，每页 20 个
          </p>
          {visible.length ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {visible.map((site) => (
                <SiteProbeCard
                  key={site.siteId}
                  api={api}
                  sourceId={source.sourceId}
                  site={site}
                  health={siteHealth(source, site)}
                  activity={activity}
                  scope={scope}
                  onHealth={(health) => onHealth?.(site.siteId, health)}
                />
              ))}
            </div>
          ) : (
            <p>未找到目录站点，可添加公开招聘站点或手工导入。</p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => changeFilters({ query, page: page - 1 })}
            >
              上一页站点
            </Button>
            <Button
              variant="outline"
              disabled={page * 20 >= filtered.length}
              onClick={() => changeFilters({ query, page: page + 1 })}
            >
              下一页站点
            </Button>
          </div>
        </section>
      </SheetContent>
    </Sheet>
  );
}
