import { useState } from "react";
import type { ApiClient, TargetVersion } from "../../lib/types";
import { useVersionContext } from "../../app/VersionContext";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";
import { VersionActions } from "../../components/VersionActions";
import { FormFeedback } from "../../components/FormFeedback";
import { CreateTargetDialog } from "./CreateTargetDialog";
import { TargetDetailsSheet } from "./TargetDetailsSheet";

export function TargetsPage({ api }: { api: ApiClient }) {
  const versions = useVersionContext();
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState<TargetVersion | undefined>();
  const [details, setDetails] = useState<TargetVersion | null>(null);
  const [message, setMessage] = useState("");
  const targets = versions.targets.filter(
    (t) => !t.archivedAt && (!t.state || t.state === "active"),
  );
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>求职目标</h1>
          <p className="text-muted-foreground">
            每个目标独立保存简历副本、岗位库、评价、检索与投递记录。
          </p>
        </div>
        <Button
          onClick={() => {
            setSource(undefined);
            setCreating(true);
          }}
        >
          新建目标
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      <FormFeedback error={versions.error} />
      {targets.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {targets.map((target) => (
            <Card key={target.packageId}>
              <CardHeader>
                <CardTitle>{target.versionName}</CardTitle>
                <CardDescription>
                  目标版本 · {target.revisionId}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={target.enabled ? "secondary" : "outline"}>
                    {target.enabled ? "已启用" : "已停用"}
                  </Badge>
                  {versions.scope?.packageId === target.packageId && (
                    <Badge>当前目标</Badge>
                  )}
                </div>
                <p>{target.roles?.join("、") || "求职方向待确认"}</p>
                <p className="text-muted-foreground">
                  {target.profileSnapshot
                    ? "已保存独立简历副本"
                    : "简历副本待补充"}{" "}
                  · 不继承其他目标的投递事实
                </p>
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  aria-label={"查看 " + target.versionName}
                  onClick={() => setDetails(target)}
                >
                  查看
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    versions.select({
                      packageId: target.packageId,
                      targetRevisionId: target.revisionId,
                    });
                    setMessage("已切换到目标：" + target.versionName);
                  }}
                >
                  设为当前目标
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setSource(target);
                    setCreating(true);
                  }}
                >
                  创建目标新版本
                </Button>
                <VersionActions
                  api={api}
                  kind="target"
                  version={target}
                  onChanged={versions.refresh}
                />
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {versions.loading ? "正在读取目标" : "创建第一个求职目标"}
            </EmptyTitle>
            <EmptyDescription>
              先保存简历，再选择求职方向、招聘来源与预算。目标的岗位库从空记录开始。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {creating && (
        <CreateTargetDialog
          api={api}
          profiles={versions.profiles}
          source={source}
          onClose={() => setCreating(false)}
          onSaved={async (saved) => {
            await versions.refresh();
            versions.select({
              packageId: saved.packageId,
              targetRevisionId: saved.revisionId,
            });
            setMessage("目标已保存：" + saved.versionName);
            setCreating(false);
          }}
        />
      )}
      {details && (
        <TargetDetailsSheet target={details} onClose={() => setDetails(null)} />
      )}
    </section>
  );
}
