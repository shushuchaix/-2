import type { TargetVersion } from "../../lib/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "../../components/ui/sheet";
import { Button } from "../../components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible";

export function TargetDetailsSheet({
  target,
  onClose,
}: {
  target: TargetVersion;
  onClose(): void;
}) {
  const profile = target.profileSnapshot?.profile;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{target.versionName}</SheetTitle>
          <SheetDescription>
            这个目标的独立配置与自有简历。修改求职方案请创建新版本。
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4">
          <Badge variant={target.enabled ? "secondary" : "outline"}>
            {target.enabled ? "已启用" : "已停用"}
          </Badge>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt>求职方向</dt>
            <dd>{target.roles?.join("、") || "未知"}</dd>
            <dt>城市</dt>
            <dd>
              {target.cityMode === "selected"
                ? target.cities?.join("、")
                : target.cityMode === "from_profile"
                  ? "使用自有简历期望城市"
                  : "不限"}
            </dd>
          </dl>
          <h2>自有简历副本</h2>
          {profile ? (
            <>
              <p>{String(profile.name || "已保存独立简历副本")}</p>
              <p>
                {String(profile.education || profile.degree || "学历未知")} ·{" "}
                {String(profile.major || "专业未知")}
              </p>
              <p className="whitespace-pre-wrap break-words">
                {target.profileSnapshot!.text}
              </p>
            </>
          ) : (
            <Alert>
              <AlertTitle>简历副本待补充</AlertTitle>
              <AlertDescription>
                旧数据中无法核实完整简历。请选择可用简历创建独立的新目标版本后再检索。
              </AlertDescription>
            </Alert>
          )}
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="outline" />}>
              技术信息
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 pt-3">
                <dt>目标版本编号</dt>
                <dd className="break-all font-mono">{target.revisionId}</dd>
                <dt>资料包编号</dt>
                <dd className="break-all font-mono">{target.packageId}</dd>
                <dt>副本来源版本</dt>
                <dd className="break-all font-mono">
                  {target.profileRevisionId || "未提供"}
                </dd>
              </dl>
            </CollapsibleContent>
          </Collapsible>
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
