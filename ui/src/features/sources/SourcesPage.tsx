import { useEffect, useState } from "react";
import type { ApiClient } from "../../lib/types";
import { useOperation } from "../../lib/hooks";
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
import { Field, FieldLabel, FieldDescription } from "../../components/ui/field";
import { Switch } from "../../components/ui/switch";
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

const statusLabels: Record<string, string> = {
  ready: "可自动采集",
  candidate: "目录候选，未验证正文",
  empty: "未取得有效样本",
  restricted: "需要授权或手工导入",
  parse_error: "页面结构无法解析",
  unavailable: "暂时不可访问",
  skipped: "未配置或已跳过",
};
const date = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN")
    : "暂无记录";

function SiteCard({
  api,
  sourceId,
  site,
  health,
  onHealth,
}: {
  api: ApiClient;
  sourceId: string;
  site: SourceSite;
  health?: SourceHealth;
  onHealth(health: SourceHealth): void;
}) {
  const [current, setCurrent] = useState(health);
  const op = useOperation();
  useEffect(() => setCurrent(health), [health]);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>{site.name}</h3>
        <Badge variant={current?.status === "ready" ? "default" : "secondary"}>
          {statusLabels[current?.status || site.status || "candidate"] ||
            "状态待检查"}
        </Badge>
      </div>
      <p className="text-muted-foreground break-all">
        {site.origin || "未提供公开地址"}
      </p>
      <p>本次尝试：{date(current?.checkedAt)}</p>
      <p>最近成功：{date(current?.lastSuccessAt || site.verifiedAt)}</p>
      {current?.sampleCount != null && (
        <p>
          有效样本：{current.sampleCount} 条
          {current.truncated ? " · 检查范围受限" : ""}
        </p>
      )}
      <OperationFeedback busy={op.busy} error={op.error} result={op.message} />
      {current?.issues?.map((issue, i) => (
        <p key={i}>
          {issue.code}
          {issue.message ? "：" + issue.message : ""}
          {issue.diagnosticId && (
            <a
              className="ml-2 underline"
              href={
                "#/logs?tab=system&diagnosticId=" +
                encodeURIComponent(issue.diagnosticId)
              }
            >
              查看更新日志
            </a>
          )}
        </p>
      ))}
      <Button
        variant="outline"
        disabled={op.busy}
        aria-label={"检查" + site.name}
        onClick={() =>
          void op.run(async () => {
            const result = await api.request<SourceHealth>(
              "/sources/" + encodeURIComponent(sourceId) + "/probe",
              { method: "POST", body: { siteId: site.siteId } },
            );
            const next = {
              ...result,
              lastSuccessAt:
                result.status === "ready"
                  ? result.checkedAt
                  : result.lastSuccessAt ||
                    current?.lastSuccessAt ||
                    site.verifiedAt,
            };
            setCurrent(next);
            onHealth(next);
          }, "来源检查已完成")
        }
      >
        检查来源
      </Button>
    </div>
  );
}

function SourceCard({
  api,
  source,
  sites,
  onHealth,
}: {
  api: ApiClient;
  source: SourceSummary;
  sites: SourceSite[];
  onHealth(siteId: string, health: SourceHealth): void;
}) {
  const [enabled, setEnabled] = useState(source.config?.enabled !== false);
  const [dirty, setDirty] = useState(false);
  const op = useOperation();
  const save = async (next: boolean) => {
    setEnabled(next);
    setDirty(true);
    const ok = await op.run(
      () =>
        api.request(
          "/sources/" + encodeURIComponent(source.sourceId) + "/settings",
          {
            method: "PUT",
            body: { config: { ...source.config, enabled: next } },
          },
        ),
      "来源设置已保存",
    );
    if (ok) setDirty(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{source.name}</CardTitle>
        <CardDescription>
          {sites.length} 个目录站点 ·{" "}
          {
            sites.filter((s) => (s.health?.status || s.status) === "ready")
              .length
          }{" "}
          个可自动采集
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field orientation="horizontal">
          <Switch
            id={"enabled-" + source.sourceId}
            aria-label={"启用" + source.name}
            checked={enabled}
            disabled={op.busy}
            onCheckedChange={(v) => void save(v)}
          />
          <div>
            <FieldLabel htmlFor={"enabled-" + source.sourceId}>
              {"启用" + source.name}
            </FieldLabel>
            <FieldDescription>
              修改后自动保存，失败时保留选择并可重试。
            </FieldDescription>
          </div>
        </Field>
        <OperationFeedback
          busy={op.busy}
          result={op.message}
          error={op.error}
        />
        {sites.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {sites.map((site) => (
              <SiteCard
                key={site.siteId}
                api={api}
                sourceId={source.sourceId}
                site={site}
                onHealth={(health) => onHealth(site.siteId, health)}
                health={
                  site.health ||
                  source.health?.find(
                    (h) =>
                      (h as SourceHealth & { siteId?: string }).siteId ===
                      site.siteId,
                  )
                }
              />
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">
            尚无目录站点，可添加公开招聘站点或手工导入。
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Button
          variant="outline"
          disabled={op.busy || !dirty}
          onClick={() => void save(enabled)}
        >
          重试保存来源设置
        </Button>
      </CardFooter>
    </Card>
  );
}

export function SourcesPage({ api }: { api: ApiClient }) {
  const [catalog, setCatalog] = useState<{
    sources: SourceSummary[];
    sites: SourceSite[];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    api
      .request<{ sources: SourceSummary[]; sites: SourceSite[] }>("/sources", {
        signal: controller.signal,
      })
      .then((data) => {
        if (live) {
          setCatalog(data);
          setError(null);
        }
      })
      .catch((e) => {
        if (live && !controller.signal.aborted) setError(e);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, refresh]);
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>招聘来源</h1>
          <p className="text-muted-foreground">
            查看采集能力、最近成功与错误，管理公开目录站点。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setRefresh((v) => v + 1)}>
            刷新来源
          </Button>
          <Button disabled={!catalog} onClick={() => setOpen(true)}>
            添加目录站点
          </Button>
        </div>
      </header>
      <OperationFeedback error={error} />
      {!catalog && !error ? (
        <Skeleton className="h-40 w-full" />
      ) : catalog?.sources.length ? (
        catalog.sources.map((source) => (
          <SourceCard
            key={source.sourceId}
            api={api}
            source={source}
            sites={catalog.sites.filter(
              (s) => s.providerId === source.sourceId,
            )}
            onHealth={(siteId, health) =>
              setCatalog(
                (current) =>
                  current && {
                    ...current,
                    sites: current.sites.map((site) =>
                      site.siteId === siteId ? { ...site, health } : site,
                    ),
                  },
              )
            }
          />
        ))
      ) : (
        !error && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无招聘来源</EmptyTitle>
              <EmptyDescription>
                添加公开目录站点后检查采集能力。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      )}
      {catalog && (
        <SiteDialog
          api={api}
          open={open}
          onClose={() => setOpen(false)}
          sources={catalog.sources}
          sites={catalog.sites}
          onSaved={(site) =>
            setCatalog((c) => c && { ...c, sites: [...c.sites, site] })
          }
        />
      )}
    </section>
  );
}
