import type { Preview } from "../../lib/types";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
import { RecordCounts } from "../../components/RecordCounts";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../../components/ui/alert-dialog";

export function PurgeConfirmDialog({
  preview,
  busy = false,
  error,
  stale = false,
  scope = "manual",
  onConfirm,
  onCancel,
}: {
  preview: Preview | null;
  busy?: boolean;
  error?: unknown;
  stale?: boolean;
  scope?: "manual" | "empty";
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <AlertDialog
      open={Boolean(preview)}
      onOpenChange={(value) => {
        if (!value && !busy) onCancel();
      }}
    >
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>确认永久删除</AlertDialogTitle>
          <AlertDialogDescription>
            将永久删除 {preview?.packageCount ?? "未统计"}{" "}
            个版本及其全部子记录，此操作不能通过回收站恢复。清空整个回收站的范围不受当前分类和搜索影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {preview && (
          <div className="flex flex-col gap-4">
            <p>
              清理范围：
              {scope === "empty"
                ? "整个回收站，不受当前分类和搜索影响。"
                : "本次选择的版本及其全部子记录。"}
            </p>
            <RecordCounts counts={preview.totals} label="永久删除内容计数" />
            <Collapsible>
              <CollapsibleTrigger render={<Button variant="outline" />}>
                技术详情
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-3 pt-3">
                <p>预览修订：{preview.workspaceRevision}</p>
                <p className="break-all font-mono">
                  预览校验：{preview.planHash}
                </p>
                {preview.candidates.map((item) => (
                  <dl key={item.packageId} className="flex flex-col gap-2">
                    <div>
                      <dt className="text-sm text-muted-foreground">
                        资料包编号
                      </dt>
                      <dd className="break-all font-mono">{item.packageId}</dd>
                    </div>
                    <div>
                      <dt className="text-sm text-muted-foreground">
                        归档实例编号
                      </dt>
                      <dd className="break-all font-mono">{item.archiveId}</dd>
                    </div>
                  </dl>
                ))}
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
        <OperationFeedback
          busy={busy}
          busyLabel="正在永久删除版本…"
          error={error}
        />
        {stale && <p role="status">回收站内容已变化，请关闭并重新预览。</p>}
        <AlertDialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={busy || stale || !preview?.packageCount}
            onClick={onConfirm}
          >
            {busy ? "正在永久删除版本…" : "确认永久删除"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
