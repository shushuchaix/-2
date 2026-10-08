import { useState } from "react";
import type { ApiClient } from "../../lib/types";
import { useOperation } from "../../lib/hooks";
import { validateInput } from "../../../../public/js/validation-rules.js";
import { TextField } from "../../components/TextField";
import { FormFeedback } from "../../components/FormFeedback";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";

export type SourceSummary = {
  sourceId: string;
  name: string;
  config?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  health?: SourceHealth[];
};
export type SourceHealth = {
  status?: string;
  checkedAt?: string;
  lastSuccessAt?: string;
  sampleCount?: number;
  truncated?: boolean;
  issues?: { code?: string; message?: string; diagnosticId?: string }[];
};
export type SourceSite = {
  siteId: string;
  providerId: string;
  name: string;
  origin?: string;
  category?: string;
  status?: string;
  verifiedAt?: string;
  health?: SourceHealth;
};

export function SiteDialog({
  api,
  sources,
  sites,
  open,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  sources: SourceSummary[];
  sites: SourceSite[];
  open: boolean;
  onClose(): void;
  onSaved(site: SourceSite): void;
}) {
  const [draft, setDraft] = useState({
    providerId: sources[0]?.sourceId || "",
    siteId: "",
    name: "",
    origin: "",
    evidenceUrl: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const op = useOperation();
  const serverErrors = (
    op.error as { fieldErrors?: Record<string, string> } | null
  )?.fieldErrors;
  const fieldErrors = { ...errors, ...serverErrors };
  const change = (name: keyof typeof draft, value: string) => {
    setDraft((d) => ({ ...d, [name]: value }));
    setErrors({});
    op.clear();
  };
  async function save() {
    const input = Object.fromEntries(
      Object.entries(draft).map(([k, v]) => [k, v.trim()]),
    ) as typeof draft;
    const invalid = validateInput("site", input, {
      sourceIds: sources.map((s) => s.sourceId),
      siteIds: sites.map((s) => s.siteId),
    }) as Record<string, string>;
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    const committed = await op.run(async () => {
      const site = await api.request<SourceSite>("/sources/sites", {
        method: "POST",
        body: { ...input, category: "custom" },
      });
      onSaved(site);
    }, "候选站点已保存");
    if (committed) {
      setDraft({
        providerId: sources[0]?.sourceId || "",
        siteId: "",
        name: "",
        origin: "",
        evidenceUrl: "",
      });
      setErrors({});
      onClose();
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !op.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>添加目录站点</DialogTitle>
          <DialogDescription>
            保存为候选站点，检查取得有效正文后才成为可采集来源。
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
          <FormFeedback errors={fieldErrors} error={op.error} />
          <FieldGroup>
            <Field data-invalid={Boolean(fieldErrors.providerId)}>
              <FieldLabel htmlFor="providerId">来源适配器</FieldLabel>
              <Select
                value={draft.providerId}
                onValueChange={(value) => change("providerId", value || "")}
                disabled={op.busy}
              >
                <SelectTrigger
                  id="providerId"
                  aria-invalid={Boolean(fieldErrors.providerId)}
                  aria-label="来源适配器"
                >
                  <SelectValue placeholder="选择来源适配器" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {sources.map((s) => (
                      <SelectItem key={s.sourceId} value={s.sourceId}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {(["siteId", "name", "origin", "evidenceUrl"] as const).map(
              (name) => (
                <TextField
                  key={name}
                  name={name}
                  label={
                    {
                      siteId: "站点 ID",
                      name: "站点名称",
                      origin: "公开站点地址",
                      evidenceUrl: "归属证据链接",
                    }[name]
                  }
                  value={draft[name]}
                  onChange={(v) => change(name, v)}
                  error={fieldErrors[name]}
                  disabled={op.busy}
                  description={
                    name === "siteId"
                      ? "字母、数字、下划线或短横线；不能重复。"
                      : name === "origin" || name === "evidenceUrl"
                        ? "公开 HTTP(S) 链接，不含凭据，不能指向本机或内网。"
                        : undefined
                  }
                />
              ),
            )}
          </FieldGroup>
          <OperationFeedback busy={op.busy} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={op.busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={op.busy || !sources.length}>
              保存候选站点
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
