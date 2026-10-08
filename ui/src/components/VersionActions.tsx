import { useState } from "react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "./ui/alert-dialog";
import { FieldGroup } from "./ui/field";
import { TextField } from "./TextField";
import { FormFeedback } from "./FormFeedback";
import { OperationFeedback } from "./OperationFeedback";
import { useOperation } from "../lib/hooks";
import type { ApiClient, ProfileVersion, TargetVersion } from "../lib/types";
import { validateInput } from "../../../public/js/validation-rules.js";
export function versionPath(
  kind: "profile" | "target",
  version: ProfileVersion | TargetVersion,
) {
  const parent =
    kind === "profile"
      ? (version as ProfileVersion).profileId
      : (version as TargetVersion).targetId;
  return (
    "/" +
    (kind === "profile" ? "profiles" : "targets") +
    "/" +
    encodeURIComponent(parent) +
    "/revisions/" +
    encodeURIComponent(version.revisionId) +
    "?packageId=" +
    encodeURIComponent(version.packageId)
  );
}
export function VersionActions({
  api,
  kind,
  version,
  onChanged,
}: {
  api: ApiClient;
  kind: "profile" | "target";
  version: ProfileVersion | TargetVersion;
  onChanged: () => void | Promise<void>;
}) {
  const operation = useOperation();
  const [rename, setRename] = useState(false),
    [archive, setArchive] = useState(false),
    [name, setName] = useState(version.versionName),
    [errors, setErrors] = useState<Record<string, string>>({});
  async function saveName() {
    const checked = validateInput(
      "profile",
      { versionName: name },
      { partial: true },
    ) as Record<string, string>;
    if (!name.trim()) checked.versionName = "请填写版本名称。";
    if (Object.keys(checked).length) {
      setErrors(checked);
      return;
    }
    setErrors({});
    if (
      await operation.run(async () => {
        await api.request(versionPath(kind, version), {
          method: "PATCH",
          body: { versionName: name },
        });
        await onChanged();
      }, "版本名称已保存")
    )
      setRename(false);
  }
  return (
    <div className="flex flex-col gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" disabled={operation.busy} />}
        >
          版本操作
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                setName(version.versionName);
                setRename(true);
                operation.clear();
              }}
            >
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void operation.run(
                  async () => {
                    await api.request(versionPath(kind, version), {
                      method: "PATCH",
                      body: { enabled: version.enabled === false },
                    });
                    await onChanged();
                  },
                  version.enabled === false ? "版本已启用" : "版本已停用",
                )
              }
            >
              {version.enabled === false ? "启用" : "停用"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                operation.clear();
                setArchive(true);
              }}
            >
              移入回收站
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <OperationFeedback
        result={operation.message}
        busy={operation.busy}
        error={!rename && !archive ? operation.error : undefined}
      />
      <Dialog
        open={rename}
        onOpenChange={(v) => {
          if (!operation.busy) setRename(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名版本</DialogTitle>
            <DialogDescription>
              同种版本名称不能重复，回收站内名称仍占用。
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <FieldGroup>
              <TextField
                name="rename-versionName"
                label="版本名称"
                value={name}
                onChange={setName}
                error={
                  errors.versionName ??
                  operation.error?.fieldErrors?.versionName
                }
              />
              <FormFeedback
                errors={errors}
                error={operation.error}
                onFocusField={() =>
                  document.getElementById("rename-versionName")?.focus()
                }
              />
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={operation.busy}
                onClick={() => setRename(false)}
              >
                取消
              </Button>
              <Button disabled={operation.busy} type="submit">
                保存名称
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={archive}
        onOpenChange={(v) => {
          if (!operation.busy) setArchive(v);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>将整个版本移入回收站？</AlertDialogTitle>
            <AlertDialogDescription>
              {kind === "profile"
                ? "已保存目标中的独立简历副本保持可用。"
                : "此版本的岗位、评价、检索和投递记录将一起回收。"}
              三天内可整包恢复，满72小时永久删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormFeedback error={operation.error} />
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={operation.busy}
              onClick={() => setArchive(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={operation.busy}
              onClick={() =>
                void operation.run(async () => {
                  await api.request(versionPath(kind, version), {
                    method: "DELETE",
                  });
                  await onChanged();
                  setArchive(false);
                }, "该版本已进入回收站")
              }
            >
              确认移入回收站
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
