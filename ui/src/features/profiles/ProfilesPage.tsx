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
                <CardDescription>简历版本 · {p.revisionId}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Badge variant="secondary">独立简历</Badge>
                <p>
                  {String(
                    p.profile.education || p.profile.degree || "学历未知",
                  )}{" "}
                  · {String(p.profile.major || "专业待确认")}
                </p>
                <p className="text-muted-foreground">
                  删除资料库简历时，已保存目标中的独立副本保持可用。
                </p>
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
