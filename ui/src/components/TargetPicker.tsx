import { useVersionContext } from "../app/VersionContext";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./ui/select";
export function TargetPicker() {
  const { targets, scope, allTargets, select, loading } = useVersionContext();
  const items = [
    { value: "__none", label: "选择目标版本" },
    { value: "__all", label: "全部目标 · 只读汇总" },
    ...targets.map((t) => ({ value: t.revisionId, label: t.versionName })),
  ];
  return (
    <Select
      items={items}
      value={allTargets ? "__all" : (scope?.targetRevisionId ?? "__none")}
      onValueChange={(value) => {
        const target = targets.find((t) => t.revisionId === value);
        select(
          value === "__all"
            ? { allTargets: true }
            : target
              ? {
                  packageId: target.packageId,
                  targetRevisionId: target.revisionId,
                }
              : null,
        );
      }}
      disabled={loading}
    >
      <SelectTrigger aria-label="当前目标" className="w-full min-w-0 md:w-72">
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
  );
}
