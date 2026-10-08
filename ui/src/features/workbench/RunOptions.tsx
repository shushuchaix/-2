import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { Button } from "../../components/ui/button";
import {
  FieldGroup,
  Field,
  FieldLabel,
  FieldDescription,
} from "../../components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { TextField } from "../../components/TextField";
export function RunOptions({
  mode,
  onMode,
  userKey,
  onKey,
  budgetCny,
  keyError,
}: {
  mode: "rules" | "ai";
  onMode: (v: "rules" | "ai") => void;
  userKey: string;
  onKey: (key: string) => void;
  budgetCny: number | null;
  keyError?: string;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="outline" />}>
        运行选项
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FieldGroup className="py-4">
          <Field>
            <FieldLabel>评价方式</FieldLabel>
            <ToggleGroup
              value={[mode]}
              onValueChange={(v) => {
                if (v[0] === "rules" || v[0] === "ai") onMode(v[0]);
              }}
            >
              <ToggleGroupItem value="rules">离线规则</ToggleGroupItem>
              <ToggleGroupItem value="ai">模型辅助</ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>
              规则模式无需密钥。模型模式使用桌面已保存密钥或本次临时输入。
            </FieldDescription>
          </Field>
          {mode === "ai" && (
            <>
              <TextField
                name="run-key"
                label="本次更新临时模型密钥"
                type="password"
                autoComplete="off"
                value={userKey}
                onChange={onKey}
                error={keyError}
                maxLength={512}
                description="仅用于本次任务；创建成功或离开页面后清除。"
              />
              <p>
                每任务模型费用上限：
                {budgetCny === null ? "使用请求次数预算" : budgetCny + " 元"}
                。在目标或设置页修改；0 元禁用模型调用。
              </p>
            </>
          )}
        </FieldGroup>
      </CollapsibleContent>
    </Collapsible>
  );
}
