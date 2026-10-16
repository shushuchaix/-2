import { RefreshCw } from "lucide-react";
import { useJobUpdate } from "../../app/JobUpdateContext";
import { useVersionContext } from "../../app/VersionContext";
import { useCollectionActivity } from "../../app/CollectionContext";
import { buildHash } from "../../app/router";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import { OperationFeedback } from "../../components/OperationFeedback";
import { deriveActivityView } from "./activity-view";

export function JobUpdatePanel() {
  const update = useJobUpdate(),
    version = useVersionContext(),
    collection = useCollectionActivity();
  const target = version.targets.find(
    (t) =>
      t.packageId === version.scope?.packageId &&
      t.revisionId === version.scope.targetRevisionId,
  );
  const activity = collection.activity,
    p = activity?.collectionProgress;
  const updatedAt = p?.updatedAt;
  return (
    <Card role="region" aria-label="岗位更新">
      <CardHeader>
        <CardTitle>获取最新岗位</CardTitle>
        <CardDescription>
          每次启动为选中的启用目标自动更新一次。手动更新使用本地规则匹配；模型评价可在工作台选择。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p>当前任务：{deriveActivityView(activity, null).label}</p>
        {updatedAt && (
          <p>最近活动更新：{new Date(updatedAt).toLocaleString()}</p>
        )}
        <OperationFeedback busy={update.busy} busyLabel="正在准备岗位更新…" />
        {p && (
          <p>
            本活动新增 {p.metrics?.newUnique ?? "未统计"} 条 · 有效且不重复{" "}
            {p.metrics?.validNewUnique ?? "未统计"} 条
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">
        <Button
          disabled={
            !version.scope ||
            version.loading ||
            !!version.error ||
            target?.enabled === false ||
            !target?.profileSnapshot?.text?.trim() ||
            collection.loading ||
            !!collection.error ||
            update.busy ||
            p?.status === "collecting" ||
            !!p?.activeSliceRunId
          }
          onClick={() => void update.manual()}
        >
          <RefreshCw data-icon="inline-start" />
          手动更新岗位
        </Button>
        <a
          className="text-primary underline"
          href={buildHash({
            page: "workbench",
            selection: version.selection,
            filters: {},
          })}
        >
          查看更新进度与运行选项
        </a>
      </CardFooter>
    </Card>
  );
}
