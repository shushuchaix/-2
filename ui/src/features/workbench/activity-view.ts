import type { CollectionActivity } from "../../lib/types";
const labels: Record<string, string> = {
  collecting: "正在采集",
  paused: "已暂停，可继续",
  waiting_for_auth: "等待独立窗口登录",
  budget_exhausted: "累计额度不足",
  completed: "计划范围已完成",
  cancelled: "活动已取消",
  queued: "等待开始",
  running: "正在更新",
  cancelling: "等待取消",
  partial: "部分完成",
  failed: "更新失败",
  interrupted: "运行中断",
  idle: "尚未开始",
};
export function deriveActivityView(
  activity: CollectionActivity | null,
  slice: Record<string, unknown> | null,
) {
  const status =
    activity?.collectionProgress.status ?? String(slice?.status ?? "idle");
  const matches =
    !activity ||
    (!!activity.collectionProgress.activeSliceRunId &&
      slice?.runId === activity.collectionProgress.activeSliceRunId);
  return {
    rootId: activity?.runId ?? null,
    status,
    label: labels[status] ?? status,
    phase:
      matches && slice
        ? String(slice.stage ?? slice.phase ?? "") || null
        : null,
  };
}
