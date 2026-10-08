import { Alert, AlertDescription } from "./ui/alert";
import { useVersionContext } from "../app/VersionContext";
export function ScopeNotice() {
  const { scope, allTargets } = useVersionContext();
  return scope ? null : (
    <Alert>
      <AlertDescription>
        {allTargets
          ? "全部目标 · 只读汇总"
          : "请选择一个目标版本，或查看全部目标的只读汇总。"}
      </AlertDescription>
    </Alert>
  );
}
