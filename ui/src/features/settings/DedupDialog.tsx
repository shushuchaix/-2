import { useState } from "react";
import type { ApiClient } from "../../lib/types";
import { useOperation } from "../../lib/hooks";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Badge } from "../../components/ui/badge";
import { Field, FieldLabel } from "../../components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";

type DuplicateGroup = {
  groupId: string;
  packageId: string;
  versionName?: string;
  keepJobId: string;
  removeJobIds: string[];
  reasons?: string[];
  reasonCodes?: string[];
  protected?: boolean;
  protectedReason?: string;
  archiveId?: string;
  purgeAt?: string;
};
type DedupPreview = {
  workspaceRevision: number;
  planHash: string;
  groups: DuplicateGroup[];
  possiblePairs?: { jobIds: string[]; reasons?: string[] }[];
  packages?: unknown[];
};
type DedupResult = {
  counts?: {
    removedEntities?: number;
    collapsedVersionEntries?: number;
    affectedVersions?: number;
  };
  totals?: {
    removedEntities?: number;
    collapsedVersionEntries?: number;
    affectedVersions?: number;
  };
  packages?: {
    packageId: string;
    versionName?: string;
    code?: string;
    counts?: { removedEntities?: number; protected?: number };
  }[];
  results?: {
    packageId: string;
    versionName?: string;
    removed?: number;
    protected?: number;
    code?: string;
  }[];
  [key: string]: unknown;
};
const reasonLabels: Record<string, string> = {
  authority_id: "可信来源岗位编号相同",
  specific_job_url: "同一岗位详情链接",
  identical_manual_input: "完整手动导入内容一致",
  identical_complete_content: "完整内容与关键资格一致",
  similar_company_title: "同单位标题相似，需核对",
  multiple_manual_applications: "存在独立人工投递，禁止自动覆盖",
  insufficient_identity_evidence: "身份依据不足",
};

export function DedupDialog({
  api,
  allVersions = true,
  onCompleted,
}: {
  api: ApiClient;
  allVersions?: boolean;
  onCompleted?(result: DedupResult): void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DedupPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [result, setResult] = useState<DedupResult | null>(null);
  const op = useOperation();
  async function load() {
    setOpen(true);
    setStale(false);
    setPreview(null);
    setResult(null);
    await op.run(async () => {
      const plan = await api.request<DedupPreview>("/jobs/duplicates/preview", {
        method: "POST",
        body: { allVersions },
      });
      setPreview(plan);
      setSelected(
        plan.groups.filter((g) => !g.protected).map((g) => g.groupId),
      );
    }, "去重预览已生成");
  }
  async function apply() {
    if (!preview || stale || !selected.length) return;
    const ok = await op.run(async () => {
      const response = await api.request<DedupResult>(
        "/jobs/duplicates/apply",
        {
          method: "POST",
          body: {
            workspaceRevision: preview.workspaceRevision,
            planHash: preview.planHash,
            selectedGroupIds: selected,
            allVersions,
          },
        },
      );
      const saved: DedupResult = {
        ...response,
        counts: response.counts ?? response.totals,
        results:
          response.results ??
          response.packages?.map((item) => ({
            packageId: item.packageId,
            versionName: item.versionName,
            removed: item.counts?.removedEntities,
            protected: item.counts?.protected,
            code: item.code,
          })),
      };
      setResult(saved);
      setStale(true);
      await onCompleted?.(saved);
    }, "所选版本内重复岗位已清理");
    if (!ok) setStale(true);
  }
  return (
    <>
      <Button variant="outline" onClick={() => void load()}>
        预览所有版本去重
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!op.busy) setOpen(v);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>逐版本清理重复岗位</DialogTitle>
            <DialogDescription>
              包括正常、停用和未到期回收站版本。每个版本独立处理，同一岗位在不同版本中保留，不改变回收期限。人工记录冲突会保留。
            </DialogDescription>
          </DialogHeader>
          <OperationFeedback
            busy={op.busy}
            error={op.error}
            result={op.message}
          />
          {preview?.groups.map((group) => (
            <div
              key={group.groupId}
              className="flex flex-col gap-3 rounded-lg border p-4"
            >
              <Field orientation="horizontal">
                <Checkbox
                  id={"dedup-" + group.groupId}
                  aria-label={
                    (group.versionName || group.packageId) +
                    " " +
                    (group.protected ? "保护组" : "重复组")
                  }
                  checked={selected.includes(group.groupId)}
                  disabled={op.busy || group.protected || stale}
                  onCheckedChange={(v) =>
                    setSelected((ids) =>
                      v
                        ? [...ids, group.groupId]
                        : ids.filter((id) => id !== group.groupId),
                    )
                  }
                />
                <FieldLabel htmlFor={"dedup-" + group.groupId}>
                  {group.versionName || group.packageId}
                </FieldLabel>
                <Badge variant="secondary">
                  {group.protected ? "人工记录受保护" : "可归并"}
                </Badge>
              </Field>
              <p>保留：{group.keepJobId}</p>
              <p>归并删除：{group.removeJobIds.join("、")}</p>
              <p>
                依据：
                {(group.reasons || group.reasonCodes || [])
                  .map((reason) => reasonLabels[reason] || reason)
                  .join("；")}
              </p>
              {group.protected && (
                <p>
                  保护原因：
                  {reasonLabels[group.protectedReason || ""] ||
                    "人工记录存在冲突，需先核对。"}
                </p>
              )}
            </div>
          ))}
          {preview && !preview.groups.length && (
            <p>没有可确认清理的重复岗位。</p>
          )}
          {preview?.possiblePairs?.length ? (
            <p>
              另有 {preview.possiblePairs.length}{" "}
              组疑似重复，仅供核对，不自动删除。
            </p>
          ) : null}
          {result && (
            <div role="status">
              <p>
                已清理重复实体 {result.counts?.removedEntities || 0}{" "}
                条，版本内归并 {result.counts?.collapsedVersionEntries || 0}{" "}
                条，涉及{" "}
                {result.counts?.affectedVersions || result.results?.length || 0}{" "}
                个版本。
              </p>
              {result.results?.map((item) => (
                <p key={item.packageId}>
                  {item.versionName || item.packageId}：清理 {item.removed || 0}
                  ，保护 {item.protected || 0}
                  {item.code && "；" + item.code}
                </p>
              ))}
            </div>
          )}
          {stale && !result && (
            <p role="status">预览已失效，请重新预览后核对并确认。</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={op.busy}
              onClick={() => setOpen(false)}
            >
              关闭预览
            </Button>
            <Button
              variant="outline"
              disabled={op.busy}
              onClick={() => void load()}
            >
              重新预览
            </Button>
            <Button
              disabled={op.busy || stale || !preview || !selected.length}
              onClick={() => void apply()}
            >
              确认清理所选重复岗位
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
