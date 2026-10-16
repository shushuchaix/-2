import { useEffect, useState } from "react";
import type { ApiClient } from "../../lib/types";
import { OperationFeedback } from "../../components/OperationFeedback";
import { RecordCounts } from "../../components/RecordCounts";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, fallback = "未提供") =>
  typeof value === "string" && value.trim() ? value : fallback;
const list = (value: unknown) =>
  Array.isArray(value) ? value.map(object) : [];
const names = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && Boolean(item.trim()),
        )
        .join("、")
    : "";
const date = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN")
    : "时间未提供";
const kindLabels: Record<string, string> = {
  target: "目标版本",
  profile: "简历版本",
  legacy_unassigned: "待归属旧数据",
};

function VersionSummary({ data }: { data: Record<string, unknown> }) {
  const pkg = object(data.package);
  const target =
    list(data.targets).find((item) => item.revisionId === pkg.versionId) ??
    list(data.targets)[0] ??
    {};
  const resume =
    list(data.profiles).find((item) => item.revisionId === pkg.versionId) ??
    list(data.profiles)[0] ??
    {};
  const copy = object(target.profileSnapshot);
  const profile = object(pkg.kind === "target" ? copy.profile : resume.profile);
  const body = text(pkg.kind === "target" ? copy.text : resume.text, "");
  const enabled =
    pkg.enabled ?? (pkg.kind === "target" ? target.enabled : resume.enabled);
  return (
    <section aria-label="版本内容摘要" className="flex flex-col gap-4">
      <div>
        <h2>{text(pkg.versionName, "版本名称未提供")}</h2>
        <p>{kindLabels[String(pkg.kind)] || "版本种类未提供"}</p>
        <p>
          {typeof enabled === "boolean"
            ? enabled
              ? "已启用"
              : "已停用"
            : "启用状态未提供"}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">移入时间</dt>
          <dd>{date(pkg.archivedAt)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">到期时间</dt>
          <dd>{date(pkg.purgeAt)}</dd>
        </div>
        {pkg.kind === "target" && (
          <>
            <div>
              <dt className="text-sm text-muted-foreground">求职方向</dt>
              <dd>{names(target.roles) || "方向未提供"}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">求职地区</dt>
              <dd>
                {target.cityMode === "selected"
                  ? names(target.cities) || "地区未提供"
                  : target.cityMode === "from_profile"
                    ? "使用自有简历期望城市"
                    : target.cityMode === "any"
                      ? "不限"
                      : "地区未提供"}
              </dd>
            </div>
          </>
        )}
      </dl>
      {(pkg.kind === "profile" || pkg.kind === "target") && (
        <section
          aria-label={
            pkg.kind === "target" ? "自有简历副本摘要" : "简历资料摘要"
          }
          className="flex flex-col gap-3"
        >
          <h3>{pkg.kind === "target" ? "自有简历副本" : "简历资料"}</h3>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">姓名</dt>
              <dd>{text(profile.name)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">学历</dt>
              <dd>{text(profile.education ?? profile.degree)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">专业</dt>
              <dd>{text(profile.major)}</dd>
            </div>
          </dl>
          {body ? (
            <Collapsible>
              <CollapsibleTrigger render={<Button variant="outline" />}>
                简历正文
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="whitespace-pre-wrap break-words pt-3">{body}</p>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <p>简历正文未提供。</p>
          )}
        </section>
      )}
      <RecordCounts counts={object(data.counts)} label="版本关联内容计数" />
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="outline" />}>
          技术详情
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="flex flex-col gap-3 pt-3">
            {[
              ["资料包编号", pkg.packageId],
              ["版本编号", pkg.versionId],
              ["归档实例编号", pkg.archiveId],
              ...(pkg.kind === "target"
                ? [["自有副本编号", copy.revisionId]]
                : []),
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-sm text-muted-foreground">
                  {String(label)}
                </dt>
                <dd className="break-all font-mono">{text(value)}</dd>
              </div>
            ))}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export function TrashDetailsSheet({
  api,
  packageId,
  purgeAt,
  onClose,
}: {
  api: ApiClient;
  packageId: string | null;
  purgeAt?: string | null;
  onClose(): void;
}) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());
  const allowed = Boolean(
    packageId &&
      purgeAt &&
      Number.isFinite(Date.parse(purgeAt)) &&
      Date.parse(purgeAt) > now,
  );
  useEffect(() => {
    if (!packageId) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [packageId]);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!allowed || !packageId) return;
    const controller = new AbortController();
    let live = true;
    api
      .request<Record<string, unknown>>(
        "/trash/" + encodeURIComponent(packageId),
        { signal: controller.signal },
      )
      .then((value) => {
        if (!live) return;
        const pkg = value.package as
          | { state?: string; purgeAt?: string }
          | undefined;
        if (
          (pkg?.state && pkg.state !== "trashed") ||
          (pkg?.purgeAt && Date.parse(pkg.purgeAt) <= Date.now())
        ) {
          setError(new Error("此版本已到期或开始清理，不能读取正文。"));
          return;
        }
        setData(value);
      })
      .catch((e) => {
        if (live && !controller.signal.aborted) setError(e);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, packageId, allowed]);
  return (
    <Sheet
      open={Boolean(packageId)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>回收站版本内容</SheetTitle>
          <SheetDescription>
            仅限未到期版本只读查看，恢复和删除均处理整个版本及全部子记录。
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 p-4">
          <OperationFeedback error={error} />
          {!allowed ? (
            <p role="status">已到期，不能读取正文或恢复。</p>
          ) : error ? null : data ? (
            <VersionSummary data={data} />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
