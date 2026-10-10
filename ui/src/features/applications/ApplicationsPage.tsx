import { useState } from "react";
import type { ApiClient } from "../../lib/types";
import { useQuery } from "../../lib/hooks";
import { useVersionContext } from "../../app/VersionContext";
import { ApplicationEditor } from "./ApplicationEditor";
import { factOf, applicationLabels, type JobItem } from "../jobs/job-view";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../components/ui/select";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";
import { FormFeedback } from "../../components/FormFeedback";
export function ApplicationsPage({ api }: { api: ApiClient }) {
  const ctx = useVersionContext(),
    [view, setView] = useState("board"),
    [editing, setEditing] = useState<JobItem | null>(null),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25);
  const query = useQuery<{
    items: (JobItem & {
      applicationId: string;
      status: string;
      note?: string;
      followUpAt?: string;
    })[];
    total: number;
  }>(
    api,
    ctx.selection
      ? "/applications?page=" + page + "&pageSize=" + pageSize
      : null,
    ctx.selection ?? undefined,
  );
  const rows = (query.data?.items ?? []).map((row) => ({
    ...row,
    application: row.application ?? {
      applicationId: row.applicationId,
      status: row.status,
      note: row.note,
      followUpAt: row.followUpAt,
    },
  }));
  const statuses = Object.keys(applicationLabels);
  const rowCard = (row: JobItem) => (
    <Card key={row.application?.applicationId ?? row.jobId}>
      <CardHeader>
        <CardTitle>{factOf(row).title}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {String(
            factOf(row).company ?? factOf(row).organization ?? "单位待核实",
          )}
        </p>
        <CardDescription>
          {applicationLabels[row.application?.status ?? "new"] ??
            row.application?.status}
          {!ctx.scope
            ? " · " +
              (ctx.targets.find((t) => t.packageId === row.ownerPackageId)
                ?.versionName ?? "所属版本待核实")
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap">
          {row.application?.note ?? "暂无备注"}
        </p>
        {row.application?.followUpAt && (
          <p>跟进：{row.application.followUpAt.slice(0, 10)}</p>
        )}
      </CardContent>
      <CardFooter>
        {ctx.scope ? (
          <Button variant="outline" onClick={() => setEditing(row)}>
            编辑投递记录
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              const target = ctx.targets.find(
                (t) => t.packageId === row.ownerPackageId,
              );
              if (target)
                ctx.select({
                  packageId: target.packageId,
                  targetRevisionId: target.revisionId,
                });
            }}
          >
            进入所属版本
          </Button>
        )}
      </CardFooter>
    </Card>
  );
  return (
    <div className="flex flex-col gap-6">
      <ToggleGroup
        aria-label="投递显示方式"
        value={[view]}
        onValueChange={(v) => {
          if (v[0]) setView(v[0]);
        }}
      >
        <ToggleGroupItem value="board">看板</ToggleGroupItem>
        <ToggleGroupItem value="list">列表</ToggleGroupItem>
      </ToggleGroup>
      <p className="text-muted-foreground">
        看板按当前页分组，共 {query.data?.total ?? 0} 条投递记录。
      </p>
      <FormFeedback error={query.error} />
      {!query.loading && !rows.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>还没有投递记录</EmptyTitle>
            <EmptyDescription>
              在岗位库记录感兴趣或已投递的岗位。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {view === "board" ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {statuses.map((status) => (
            <section key={status} className="flex min-w-0 flex-col gap-4">
              <h2 className="font-semibold">
                {applicationLabels[status]} ·{" "}
                {rows.filter((r) => r.application?.status === status).length}
              </h2>
              {rows
                .filter((r) => r.application?.status === status)
                .map(rowCard)}
            </section>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">{rows.map(rowCard)}</div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <Select
          items={[25, 50, 100].map((n) => ({
            value: String(n),
            label: n + " 条/页",
          }))}
          value={String(pageSize)}
          onValueChange={(v) => {
            setPageSize(Number(v));
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="每页投递条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {[25, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} 条/页
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={page <= 1 || query.loading}
          onClick={() => setPage((p) => p - 1)}
        >
          上一页
        </Button>
        <p>第 {page} 页</p>
        <Button
          variant="outline"
          disabled={
            page * pageSize >= (query.data?.total ?? 0) || query.loading
          }
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </Button>
      </div>
      {editing && ctx.scope && (
        <ApplicationEditor
          key={ctx.scope.packageId + editing.jobId}
          api={api}
          applicationId={editing.application?.applicationId}
          jobId={editing.jobId}
          initial={editing.application}
          scope={ctx.scope}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            query.refresh();
          }}
        />
      )}
    </div>
  );
}
