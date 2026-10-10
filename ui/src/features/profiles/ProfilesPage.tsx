import { useState } from "react";
import type { ApiClient, ProfileVersion } from "../../lib/types";
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
import { ImportProfileDialog } from "./ImportProfileDialog";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible";

export function ProfilesPage({ api }: { api: ApiClient }) {
  const versions = useVersionContext();
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState<ProfileVersion | undefined>();
  const [message, setMessage] = useState("");
  const profiles = versions.profiles.filter(
    (p) => !p.archivedAt && (!p.state || p.state === "active"),
  );
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>简历管理</h1>
          <p className="text-muted-foreground">
            导入、校正并保存独立简历版本，为每个求职目标提供复制来源。
          </p>
        </div>
        <Button
          onClick={() => {
            setSource(undefined);
            setImporting(true);
          }}
        >
          导入简历
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      <FormFeedback error={versions.error} />
      {profiles.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {profiles.map((p) => (
            <Card key={p.packageId}>
              <CardHeader>
                <CardTitle>{p.versionName}</CardTitle>
                <CardDescription>
                  {p.parserVersion ? "已提取并保存" : "已保存资料"} ·{" "}
                  {updatedLabel(p)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">独立简历</Badge>
                  <Badge variant={p.enabled ? "secondary" : "outline"}>
                    {p.enabled ? "已启用" : "已停用"}
                  </Badge>
                </div>
                <p>
                  {String(
                    p.profile.education || p.profile.degree || "学历未知",
                  )}{" "}
                  · {String(p.profile.major || "专业待确认")}
                </p>
                <p className="text-muted-foreground">
                  删除资料库简历时，已保存目标中的独立副本保持可用。
                </p>
                <Collapsible>
                  <CollapsibleTrigger render={<Button variant="outline" />}>
                    技术信息
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 pt-3">
                      <dt>简历版本编号</dt>
                      <dd className="break-all font-mono">{p.revisionId}</dd>
                      <dt>资料包编号</dt>
                      <dd className="break-all font-mono">{p.packageId}</dd>
                      <dt>提取器版本</dt>
                      <dd>{p.parserVersion || "未提供"}</dd>
                    </dl>
                  </CollapsibleContent>
                </Collapsible>
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setSource(p);
                    setImporting(true);
                  }}
                >
                  创建简历新版本
                </Button>
                <VersionActions
                  api={api}
                  kind="profile"
                  version={p}
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
              {versions.loading ? "正在读取简历" : "先准备一份简历"}
            </EmptyTitle>
            <EmptyDescription>
              支持 TXT、MD、DOCX、PDF 或粘贴正文。提取后可以逐项校正。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {importing && (
        <ImportProfileDialog
          key={source?.revisionId || "new-profile"}
          api={api}
          source={source}
          onClose={() => setImporting(false)}
          onSaved={async (p) => {
            setMessage("简历已保存：" + p.versionName);
            await versions.refresh();
            setImporting(false);
          }}
        />
      )}
    </section>
  );
}
function updatedLabel(profile: ProfileVersion) {
  const metadata = profile as ProfileVersion & {
    updatedAt?: string;
    createdAt?: string;
  };
  const value = metadata.updatedAt || metadata.createdAt;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? "更新于 " + date.toLocaleString("zh-CN")
    : "更新时间未提供";
}
