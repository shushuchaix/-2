import { useState } from "react";
import type { ApiClient, Scope } from "../../lib/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "../../components/ui/sheet";
import {
  FieldGroup,
  Field,
  FieldLabel,
  FieldError,
  FieldDescription,
} from "../../components/ui/field";
import { Checkbox } from "../../components/ui/checkbox";
import { useVersionContext } from "../../app/VersionContext";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../components/ui/select";
import { TextField } from "../../components/TextField";
import { FormFeedback } from "../../components/FormFeedback";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
import { useOperation } from "../../lib/hooks";
import { applicationLabels, type ApplicationRecord } from "../jobs/job-view";
import { validateInput } from "../../../../public/js/validation-rules.js";
export function ApplicationEditor({
  api,
  applicationId,
  jobId,
  initial = {},
  scope,
  onSaved,
  onClose,
}: {
  api: ApiClient;
  applicationId?: string;
  jobId: string;
  initial?: Partial<ApplicationRecord>;
  scope: Scope;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState(initial.status ?? "new"),
    [note, setNote] = useState(initial.note ?? ""),
    [resumeRecorded, setResumeRecorded] = useState(!!initial.resumeRevisionId),
    [appliedAt, setAppliedAt] = useState(initial.appliedAt?.slice(0, 10) ?? ""),
    [followUpAt, setFollowUpAt] = useState(
      initial.followUpAt?.slice(0, 10) ?? "",
    ),
    [errors, setErrors] = useState<Record<string, string>>({});
  const op = useOperation();
  const target = useVersionContext().targets.find(
      (t) => t.packageId === scope.packageId,
    ),
    copyId = target?.profileSnapshot?.revisionId;
  const items = Object.entries(applicationLabels).map(([value, label]) => ({
    value,
    label,
  }));
  async function save() {
    const body = {
      status,
      note,
      appliedAt,
      followUpAt,
      resumeRevisionId: resumeRecorded && copyId ? copyId : null,
    };
    const check = validateInput("application", body) as Record<string, string>;
    if (Object.keys(check).length) {
      setErrors(check);
      return;
    }
    setErrors({});
    if (
      await op.run(
        () =>
          api.request(
            applicationId
              ? "/applications/" + encodeURIComponent(applicationId)
              : "/jobs/" + encodeURIComponent(jobId) + "/application",
            { method: applicationId ? "PUT" : "POST", scope, body },
          ),
        "投递记录已保存",
      )
    )
      onSaved();
  }
  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v && !op.busy) onClose();
      }}
    >
      <SheetContent className="flex flex-col gap-4 overflow-y-auto p-6">
        <SheetHeader>
          <SheetTitle>投递记录</SheetTitle>
          <SheetDescription>仅修改当前目标版本的记录和备注。</SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
          <FieldGroup>
            <Field>
              <FieldLabel>投递状态</FieldLabel>
              <Select
                items={items}
                value={status}
                onValueChange={(v) => setStatus(String(v))}
              >
                <SelectTrigger aria-label="投递状态">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {items.map((i) => (
                      <SelectItem key={i.value} value={i.value}>
                        {i.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {(errors.status ?? op.error?.fieldErrors?.status) && (
                <FieldError role="note">
                  {errors.status ?? op.error?.fieldErrors?.status}
                </FieldError>
              )}
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="application-resumeRevisionId"
                checked={resumeRecorded}
                onCheckedChange={setResumeRecorded}
                disabled={!copyId}
              />
              <FieldLabel htmlFor="application-resumeRevisionId">
                记录使用本目标自有简历副本
              </FieldLabel>
            </Field>
            <FieldDescription>
              仅使用这个目标保存时的独立副本。
              {!copyId && "当前版本缺少副本，请创建完整目标。"}
            </FieldDescription>
            <TextField
              name="application-appliedAt"
              label="投递日期"
              type="date"
              value={appliedAt}
              onChange={setAppliedAt}
              error={errors.appliedAt ?? op.error?.fieldErrors?.appliedAt}
            />
            <TextField
              name="application-followUpAt"
              label="跟进日期"
              type="date"
              value={followUpAt}
              onChange={setFollowUpAt}
              error={errors.followUpAt ?? op.error?.fieldErrors?.followUpAt}
            />
            <TextField
              name="application-note"
              label="投递备注"
              multiline
              value={note}
              onChange={setNote}
              maxLength={20000}
              error={errors.note ?? op.error?.fieldErrors?.note}
            />
            <FormFeedback
              errors={errors}
              error={op.error}
              onFocusField={(name) =>
                document.getElementById("application-" + name)?.focus()
              }
            />
          </FieldGroup>
          {initial.events?.length && (
            <section className="flex flex-col gap-2">
              <h2 className="font-semibold">投递记录变更</h2>
              {initial.events.map((event, i) => (
                <p key={String(event.recordId ?? i)}>
                  {String(event.at ?? "时间待核实")} · 已更新投递记录
                </p>
              ))}
            </section>
          )}
          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              disabled={op.busy}
              onClick={onClose}
            >
              关闭
            </Button>
            <Button type="submit" disabled={op.busy}>
              保存投递记录
            </Button>
          </SheetFooter>
        </form>
        <OperationFeedback result={op.message} busy={op.busy} />
      </SheetContent>
    </Sheet>
  );
}
