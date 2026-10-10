import type { Preview } from "../../lib/types";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
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
  onConfirm,
  onCancel,
}: {
  preview: Preview | null;
  busy?: boolean;
  error?: unknown;
  stale?: boolean;
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
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认永久删除</AlertDialogTitle>
          <AlertDialogDescription>
            将永久删除 {preview?.packageCount || 0}{" "}
            个版本及其全部子记录，此操作不能通过回收站恢复。清空整个回收站的范围不受当前分类和搜索影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {preview && (
          <div className="flex flex-col gap-2">
            <p>
              岗位 {preview.totals.jobs} · 评价 {preview.totals.evaluations} ·
              检索 {preview.totals.runs} · 投递 {preview.totals.applications}
            </p>
            <p>
              简历 {preview.totals.profiles} · 目标 {preview.totals.targets} ·
              观察 {preview.totals.observations} · 事件 {preview.totals.events}{" "}
              · 文件 {preview.totals.files}
            </p>
          </div>
        )}
        <OperationFeedback busy={busy} error={error} />
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
            确认永久删除
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
