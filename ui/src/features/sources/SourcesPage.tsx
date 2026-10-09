import { useEffect, useState } from "react";
import type { ApiClient, DesktopAdapter } from "../../lib/types";
import { createDesktopAdapter } from "../../lib/desktop";
import { TextField } from "../../components/TextField";
import { CollectionSessionDialog } from "./CollectionSessionDialog";
import { useQuery } from "../../lib/hooks";
import type { CollectionActivity } from "../workbench/CollectionProgress";
import { useVersionContext } from "../../app/VersionContext";
import { buildHash } from "../../app/router";
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
  ready: "探针已验证",
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
  const context = useVersionContext();
  const op = useOperation();
  const roots = useQuery<{ collections?: CollectionActivity[] }>(
      api,
      context.scope ? "/collections" : null,
      context.scope ?? undefined,
    ),
    active = roots.data?.collections?.find(
      (a) => a.collectionProgress.status === "collecting",
    );
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
      <p className="text-sm">
        {Object.entries({
          list: "列表",
          body: "正文",
          attachments: "附件",
          apply: "投递入口",
        })
          .map(
            ([key, label]) =>
              label +
              "：" +
              (current?.capabilities?.[key] === "verified"
                ? "已验证"
                : "待验证"),
          )
          .join(" · ")}
      </p>
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
              href={buildHash({
                page: "logs",
                selection: context.selection,
                filters: { tab: "system", diagnosticId: issue.diagnosticId },
              })}
            >
              查看更新日志
            </a>
          )}
        </p>
      ))}
      <Button
        variant="outline"
        disabled={op.busy || !context.scope || !active}
        aria-label={"检查" + site.name}
        onClick={() =>
          void op.run(async () => {
            const result = await api.request<SourceHealth>(
              "/sources/" + encodeURIComponent(sourceId) + "/probe",
              {
                method: "POST",
                scope: context.scope ?? undefined,
                body: { siteId: site.siteId, activityId: active?.runId },
              },
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
      {!active && (
        <p className="text-sm text-muted-foreground">
          开始或继续本版本采集后，可使用累计额度检查来源。
        </p>
      )}
    </div>
  );
}

function SourceCard({
  api,
  source,
  sites,
  onHealth,
  desktop,
}: {
  api: ApiClient;
  source: SourceSummary;
  sites: SourceSite[];
  onHealth(siteId: string, health: SourceHealth): void;
  desktop: DesktopAdapter;
}) {
  const [enabled, setEnabled] = useState(source.config?.enabled !== false);
  const [dirty, setDirty] = useState(false);
  const op = useOperation();
  const ctx = useVersionContext(),
    social = source.sourceId === "wechat" || source.sourceId === "weibo";
  const [proof, setProof] = useState(source.serviceCapability),
    [paid, setPaid] = useState(false);
  const roots = useQuery<{ collections?: CollectionActivity[] }>(
      api,
      source.optionalService && ctx.scope ? "/collections" : null,
      ctx.scope ?? undefined,
    ),
    active = roots.data?.collections?.find(
      (a) => a.collectionProgress.status === "collecting",
    );
  const [urls, setUrls] = useState(
      Array.isArray(source.config?.articleUrls)
        ? source.config.articleUrls.join("\n")
        : "",
    ),
    [accounts, setAccounts] = useState(
      Array.isArray(source.config?.accountIds)
        ? source.config.accountIds.join("\n")
        : "",
    ),
    [login, setLogin] = useState(false);
  const save = async (next: boolean) => {
    setEnabled(next);
    setDirty(true);
    const ok = await op.run(
      () =>
        api.request(
          "/sources/" + encodeURIComponent(source.sourceId) + "/settings",
          {
            method: "PUT",
            scope: ctx.scope ?? undefined,
            body: {
              config: {
                ...source.config,
                enabled: next,
                ...(social
                  ? {
                      articleUrls: urls
                        .split(/\n/)
                        .map((v) => v.trim())
                        .filter(Boolean),
                      accountIds: accounts
                        .split(/\n/)
                        .map((v) => v.trim())
                        .filter(Boolean),
                    }
                  : {}),
              },
            },
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
            sites.filter(
              (s) =>
                source.health?.find((h) => h.siteId === s.siteId)?.status ===
                "ready",
            ).length
          }{" "}
          个本版本已验证站点
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field orientation="horizontal">
          <Switch
            id={"enabled-" + source.sourceId}
            aria-label={"启用" + source.name}
            checked={enabled}
            disabled={
              op.busy ||
              !ctx.scope ||
              (source.optionalService && !enabled && proof?.enabled !== true)
            }
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
        {social && (
          <>
            <TextField
              name={"social-urls-" + source.sourceId}
              label="已知公开文章/帖子链接（每行一个）"
              multiline
              value={urls}
              onChange={(v) => {
                setUrls(v);
                setDirty(true);
              }}
            />
            <TextField
              name={"social-accounts-" + source.sourceId}
              label="官方机构公开账号标识（每行一个）"
              multiline
              value={accounts}
              onChange={(v) => {
                setAccounts(v);
                setDirty(true);
              }}
              description={
                source.sourceId === "wechat"
                  ? "公开文章中的 __biz 标识；历史可见范围以实际返回为准"
                  : "微博数字 UID；以实际游标分批采集"
              }
            />
            <Button
              variant="outline"
              disabled={!ctx.scope}
              onClick={() => setLogin(true)}
            >
              {source.name}独立登录
            </Button>
            <p className="text-sm text-muted-foreground">
              抓取完整正文、长文、公开海报与附件；验证码或登录限制会暂停该来源并保留进度。
            </p>
          </>
        )}
        {source.optionalService && (
          <div className="flex flex-col gap-3">
            <p>
              账号能力：{String(proof?.state ?? "未检查")} · 正文：
              {proof?.bodyCapability ? "已验证" : "未验证"} · 价格：
              {String(proof?.pricingState ?? "未知")} · 检查时间：
              {String(proof?.checkedAt ?? "暂无")}
            </p>
            <Button
              variant="outline"
              disabled={op.busy || !ctx.scope}
              onClick={() =>
                void op.run(async () => {
                  const result = await api.request<Record<string, unknown>>(
                    "/sources/" + source.sourceId + "/probe",
                    {
                      method: "POST",
                      scope: ctx.scope ?? undefined,
                      body: { activityId: active?.runId },
                    },
                  );
                  setProof(result);
                }, "官方读取能力检查已完成")
              }
            >
              检查本版本官方读取能力
            </Button>
            <label className="flex gap-2">
              <input
                type="checkbox"
                disabled={op.busy || proof?.pricingState !== "paid"}
                checked={paid}
                onChange={(e) => setPaid(e.target.checked)}
              />
              已核对官方服务的独立费用
            </label>
            <Button
              variant="outline"
              disabled={
                op.busy ||
                !ctx.scope ||
                proof?.bodyCapability !== true ||
                !proof?.proofId ||
                (proof?.pricingState === "paid" && !paid)
              }
              onClick={() =>
                void op.run(async () => {
                  const result = await api.request<Record<string, unknown>>(
                    "/sources/" + source.sourceId + "/service",
                    {
                      method: "POST",
                      scope: ctx.scope ?? undefined,
                      body: {
                        proofId: proof?.proofId,
                        paidServiceAcknowledged: paid,
                      },
                    },
                  );
                  setProof(result);
                  setEnabled(true);
                }, "已开通本版本官方读取通道")
              }
            >
              按已核验能力开通
            </Button>
          </div>
        )}
        {source.optionalService && (
          <p className="text-sm text-muted-foreground">
            可选官方服务默认关闭。必须先核实账号读取权限、正文能力、额度与价格；未开通时仍使用公开网页。
          </p>
        )}
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
                  source.health?.find(
                    (h) =>
                      (h as SourceHealth & { siteId?: string }).siteId ===
                      site.siteId,
                  ) || site.health
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
      {login && social && ctx.scope && (
        <CollectionSessionDialog
          key={ctx.scope.packageId}
          api={api}
          desktop={desktop}
          scope={ctx.scope}
          platform={source.sourceId as "wechat" | "weibo"}
          onClose={() => setLogin(false)}
        />
      )}
    </Card>
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
    setCatalog(null);
    setError(null);
    api
      .request<{ sources: SourceSummary[]; sites: SourceSite[] }>("/sources", {
        signal: controller.signal,
        scope: ctx.scope ?? undefined,
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
  }, [api, refresh, ctx.generation]);
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
            key={ctx.generation + source.sourceId}
            api={api}
            desktop={desktop}
            source={source}
            sites={catalog.sites.filter(
              (s) => s.providerId === source.sourceId,
            )}
            onHealth={(siteId, health) =>
              setCatalog(
                (current) =>
                  current && {
                    ...current,
                    sources: current.sources.map((s) =>
                      s.sourceId === source.sourceId
                        ? {
                            ...s,
                            health: [
                              ...(s.health ?? []).filter(
                                (h) => h.siteId !== siteId,
                              ),
                              { ...health, siteId },
                            ],
                          }
                        : s,
                    ),
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
