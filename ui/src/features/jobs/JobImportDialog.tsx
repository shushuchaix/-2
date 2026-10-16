import { useState } from "react";
import type { ApiClient, Scope } from "../../lib/types";
import { validateInput } from "../../../../public/js/validation-rules.js";
import { useOperation } from "../../lib/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";
import { FieldGroup } from "../../components/ui/field";
import { TextField } from "../../components/TextField";
import { FormFeedback } from "../../components/FormFeedback";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
export function JobImportDialog({
  api,
  scope,
  onImported,
  onClose,
}: {
  api: ApiClient;
  scope: Scope;
  onImported: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState({
      url: "",
      title: "",
      account: "",
      text: "",
      note: "",
    }),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [result, setResult] = useState<{
      jobIds: string[];
      issues?: { message: string }[];
    } | null>(null),
    op = useOperation();
  async function save() {
    const body = { ...draft, url: draft.url.trim() || undefined };
    const checked = validateInput("import", body) as Record<string, string>;
    if (Object.keys(checked).length) {
      setErrors(checked);
      return;
    }
    setErrors({});
    setResult(null);
    await op.run(async () => {
      const saved = await api.request<{
        jobIds: string[];
        issues?: { message: string }[];
      }>("/imports", { method: "POST", scope, body });
      if (!saved.jobIds?.length)
        throw Error(
          saved.issues?.map((i) => i.message).join("；") ||
            "没有导入招聘线索，请检查正文和来源链接。",
        );
      setResult(saved);
      onImported();
    }, "招聘线索已导入");
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !op.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>导入招聘线索</DialogTitle>
          <DialogDescription>
            保存到当前目标版本。微信公号、微博、抖音链接需同时粘贴公开招聘正文，保留来源与发布账号。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
          <FieldGroup>
            {(
              [
                {
                  key: "url",
                  label: "来源链接",
                  max: 2000,
                  description:
                    "公开 http(s) 链接，不含账号密码；与正文至少填一项。",
                },
                { key: "title", label: "公告标题", max: 200 },
                { key: "account", label: "发布账号", max: 200 },
                { key: "text", label: "招聘正文", max: 60000, multiline: true },
                { key: "note", label: "我的备注", max: 20000, multiline: true },
              ] as const
            ).map((field) => (
              <TextField
                key={field.key}
                name={"import-" + field.key}
                label={field.label}
                value={draft[field.key]}
                onChange={(value) =>
                  setDraft((prev) => ({ ...prev, [field.key]: value }))
                }
                maxLength={field.max}
                multiline={"multiline" in field ? field.multiline : false}
                description={
                  "description" in field ? field.description : undefined
                }
                error={errors[field.key] ?? op.error?.fieldErrors?.[field.key]}
              />
            ))}
            <FormFeedback
              errors={errors}
              error={op.error}
              onFocusField={(name) =>
                document.getElementById("import-" + name)?.focus()
              }
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={op.busy}
              onClick={onClose}
            >
              关闭
            </Button>
            <Button type="submit" disabled={op.busy}>
              导入到当前版本
            </Button>
          </DialogFooter>
        </form>
        <OperationFeedback busy={op.busy} result={op.message} />
        {result && (
          <div role="status">
            <p>已保存 {result.jobIds.length} 条本版本招聘线索。</p>
            {result.issues?.map((issue, i) => (
              <p key={i}>{issue.message}</p>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
