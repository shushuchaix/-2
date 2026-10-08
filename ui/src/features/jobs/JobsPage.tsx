import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/types";
import { useQuery, useOperation } from "../../lib/hooks";
import { OperationFeedback } from "../../components/OperationFeedback";
import { useVersionContext } from "../../app/VersionContext";
import { parseRoute, buildHash } from "../../app/router";
import { useIsMobile } from "../../hooks/use-mobile";
import { JobFilters } from "./JobFilters";
import { JobDetailsSheet } from "./JobDetailsSheet";
import { JobImportDialog } from "./JobImportDialog";
import { DedupDialog } from "../settings/DedupDialog";
import {
  factOf,
  qualificationOf,
  recommendationOf,
  applicationLabels,
  type JobItem,
} from "./job-view";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../../components/ui/table";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";
import { FormFeedback } from "../../components/FormFeedback";
export function JobsPage({ api }: { api: ApiClient }) {
  const [importing, setImporting] = useState(false);
  const exporting = useOperation();
  const ctx = useVersionContext(),
    mobile = useIsMobile();
  const [filters, setFilters] = useState(
      () => parseRoute(window.location.hash).filters,
    ),
    [search, setSearch] = useState(filters.search ?? ""),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25),
    [opened, setOpened] = useState<string | null>(null);
  const currentFilters = useRef(filters);
  const setFilter = (name: string, value: string) => {
    setPage(1);
    setFilters((prev) => {
      const next = { ...prev, [name]: value };
      currentFilters.current = next;
      const route = parseRoute(window.location.hash);
      window.history.replaceState(
        null,
        "",
        buildHash({ ...route, filters: next }),
      );
      return next;
    });
  };
  useEffect(() => {
    if (search === (filters.search ?? "")) return;
    const timer = setTimeout(() => setFilter("search", search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setPage(1);
    setOpened(null);
  }, [ctx.generation]);
  useEffect(() => {
    const restore = () => {
      const route = parseRoute(window.location.hash);
      if (route.page !== "jobs") return;
      // A queued hashchange may refer to the route already rendered. Preserve
      // an in-progress search draft unless the URL filters actually changed.
      const names = new Set([
        ...Object.keys(route.filters),
        ...Object.keys(currentFilters.current),
      ]);
      if (
        [...names].every(
          (name) =>
            (route.filters[name] ?? "") ===
            (currentFilters.current[name] ?? ""),
        )
      )
        return;
      currentFilters.current = route.filters;
      setFilters(route.filters);
      setSearch(route.filters.search ?? "");
      setPage(1);
      setOpened(null);
    };
    window.addEventListener("hashchange", restore);
    return () => window.removeEventListener("hashchange", restore);
  }, []);
  const params = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(filters).filter(
        ([k, v]) => v && !["tab", "diagnosticId"].includes(k),
      ),
    ),
    page: String(page),
    pageSize: String(pageSize),
  });
  const query = useQuery<{ items: JobItem[]; total: number }>(
    api,
    ctx.selection ? "/jobs?" + params : null,
    ctx.selection ?? undefined,
  );
  const catalog = useQuery<{ sources: { sourceId: string; name: string }[] }>(
    api,
    "/sources",
  );
  const items = query.data?.items ?? [];
  const pageOptions = [25, 50, 100].map((n) => ({
    value: String(n),
    label: n + " 条/页",
  }));
  const owner = (row: JobItem) =>
    ctx.targets.find(
      (t) => t.packageId === (row.ownerPackageId ?? row.packageId),
    );
  const action = (row: JobItem) =>
    ctx.scope ? (
      <Button variant="outline" onClick={() => setOpened(row.jobId)}>
        查看岗位
      </Button>
    ) : (
      <Button
        variant="outline"
        onClick={() => {
          const t = owner(row);
          if (t)
            ctx.select({
              packageId: t.packageId,
              targetRevisionId: t.revisionId,
            });
        }}
        disabled={!owner(row)}
      >
        进入所属版本
      </Button>
    );
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={!ctx.scope}
          onClick={() => setImporting(true)}
        >
          导入招聘线索
        </Button>
        <DedupDialog api={api} onCompleted={() => query.refresh()} />
        <Button
          variant="outline"
          disabled={!ctx.selection || exporting.busy}
          onClick={() =>
            void exporting.run(async () => {
              const blob = await api.download("/exports", {
                method: "POST",
                scope: ctx.selection ?? undefined,
                body: {
                  format: "csv",
                  filters: Object.fromEntries(
                    Object.entries(filters).filter(([, v]) => v),
                  ),
                },
              });
              const url = URL.createObjectURL(blob),
                anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = "job-radar-jobs.csv";
              anchor.click();
              URL.revokeObjectURL(url);
            }, "岗位导出已完成")
          }
        >
          导出筛选结果 CSV
        </Button>
      </div>
      <OperationFeedback
        busy={exporting.busy}
        result={exporting.message}
        error={exporting.error}
      />
      <JobFilters
        filters={filters}
        search={search}
        onSearch={setSearch}
        onChange={setFilter}
        sources={catalog.data?.sources ?? []}
      />
      <FormFeedback error={query.error} />
      {query.loading && <Skeleton className="h-24 w-full" />}
      {!query.loading && !items.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>这里还没有岗位</EmptyTitle>
            <EmptyDescription>
              选择目标更新岗位，或调整筛选条件。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!!items.length &&
        (mobile ? (
          <div className="flex flex-col gap-4">
            {items.map((row) => {
              const f = factOf(row);
              return (
                <Card key={row.jobId + row.ownerPackageId}>
                  <CardHeader>
                    <CardTitle>{f.title}</CardTitle>
                    <CardDescription>
                      {f.organization ?? f.company ?? "单位待核实"}
                      {!ctx.scope &&
                        " · " + (owner(row)?.versionName ?? "所属版本待核实")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p>{f.cities?.join("、") ?? "城市待核实"}</p>
                    <p>
                      {recommendationOf(row)} · {qualificationOf(row)} · 截止{" "}
                      {f.deadline ?? "待核实"}
                    </p>
                    <Badge variant="secondary">
                      {applicationLabels[row.application?.status ?? "new"] ??
                        "未处理"}
                    </Badge>
                  </CardContent>
                  <CardFooter>{action(row)}</CardFooter>
                </Card>
              );
            })}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "岗位 / 单位",
                  "城市",
                  "匹配 / 资格",
                  "截止日期",
                  "投递状态",
                  "操作",
                ].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => {
                const f = factOf(row);
                return (
                  <TableRow key={row.jobId + row.ownerPackageId}>
                    <TableCell className="max-w-80 whitespace-normal">
                      <p className="font-semibold">{f.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {f.organization ?? f.company ?? "单位待核实"}
                      </p>
                      {!ctx.scope && (
                        <Badge variant="outline">
                          {owner(row)?.versionName ?? "所属版本待核实"}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{f.cities?.join("、") ?? "待核实"}</TableCell>
                    <TableCell>
                      <p>
                        {row.evaluation?.score ?? "—"} 分 ·{" "}
                        {recommendationOf(row)}
                      </p>
                      <p>{qualificationOf(row)}</p>
                    </TableCell>
                    <TableCell>{f.deadline ?? "待核实"}</TableCell>
                    <TableCell>
                      {applicationLabels[row.application?.status ?? "new"] ??
                        "未处理"}
                    </TableCell>
                    <TableCell>{action(row)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ))}
      <div className="flex flex-wrap items-center gap-4">
        <Select
          items={pageOptions}
          value={String(pageSize)}
          onValueChange={(v) => {
            setPageSize(Number(v));
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {pageOptions.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={page <= 1 || query.loading}
          onClick={() => setPage((x) => x - 1)}
        >
          上一页
        </Button>
        <p>
          第 {page} 页 · 共 {query.data?.total ?? 0} 条
        </p>
        <Button
          variant="outline"
          disabled={
            page * pageSize >= (query.data?.total ?? 0) || query.loading
          }
          onClick={() => setPage((x) => x + 1)}
        >
          下一页
        </Button>
      </div>
      {opened && ctx.scope && (
        <JobDetailsSheet
          api={api}
          jobId={opened}
          scope={ctx.scope}
          onClose={() => setOpened(null)}
          onChanged={query.refresh}
        />
      )}
      {importing && ctx.scope && (
        <JobImportDialog
          api={api}
          scope={ctx.scope}
          onImported={query.refresh}
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}
