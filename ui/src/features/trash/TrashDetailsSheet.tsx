import { useEffect, useState } from "react";
import type { ApiClient } from "../../lib/types";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";

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
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(data, null, 2)}
            </pre>
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
