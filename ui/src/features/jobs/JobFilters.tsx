import { useState } from "react";
import { TextField } from "../../components/TextField";
import { FieldGroup, Field, FieldLabel } from "../../components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../components/ui/select";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(v) => onChange(String(v ?? ""))}
      >
        <SelectTrigger aria-label={label}>
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
    </Field>
  );
}
export function JobFilters({
  filters,
  search,
  onSearch,
  onChange,
  sources,
}: {
  filters: Record<string, string>;
  search: string;
  onSearch: (s: string) => void;
  onChange: (k: string, v: string) => void;
  sources: { sourceId: string; name: string }[];
}) {
  const [advanced, setAdvanced] = useState(false);
  return (
    <FieldGroup>
      <div className="grid gap-4 md:grid-cols-3">
        <TextField
          name="job-search"
          label="搜索岗位"
          value={search}
          onChange={onSearch}
          maxLength={200}
        />
        <Choice
          label="推荐状态"
          value={filters.recommendation ?? "all"}
          onChange={(v) => onChange("recommendation", v)}
          items={[
            { value: "all", label: "全部推荐状态" },
            { value: "high", label: "优先推荐" },
            { value: "consider", label: "可以考虑" },
            { value: "unevaluated", label: "尚未评价" },
          ]}
        />
        <Choice
          label="投递状态"
          value={filters.applicationStatus ?? "all"}
          onChange={(v) => onChange("applicationStatus", v)}
          items={[
            { value: "all", label: "全部投递状态" },
            { value: "new", label: "未处理" },
            { value: "interested", label: "感兴趣" },
            { value: "applied", label: "已投递" },
            { value: "interviewing", label: "面试中" },
          ]}
        />
      </div>
      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger render={<Button variant="outline" />}>
          更多筛选
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-4 py-4 md:grid-cols-3">
            <Choice
              label="招聘时效"
              value={filters.openingStatus ?? "all"}
              onChange={(v) => onChange("openingStatus", v)}
              items={[
                { value: "all", label: "全部时效" },
                { value: "open", label: "当前招聘" },
                { value: "historical", label: "历史结果公告" },
                { value: "closed", label: "已截止" },
                { value: "unknown", label: "时效待核验" },
              ]}
            />
            <TextField
              name="job-cities"
              label="城市"
              value={filters.cities ?? ""}
              onChange={(v) => onChange("cities", v)}
              description="多个城市以逗号分隔"
            />
            <Choice
              label="招聘来源"
              value={filters.sourceId ?? "all"}
              onChange={(v) => onChange("sourceId", v === "all" ? "" : v)}
              items={[
                { value: "all", label: "全部来源" },
                ...sources.map((s) => ({ value: s.sourceId, label: s.name })),
              ]}
            />
            <Choice
              label="岗位类型"
              value={filters.kind ?? "all"}
              onChange={(v) => onChange("kind", v)}
              items={[
                { value: "all", label: "全部岗位类型" },
                { value: "job", label: "具体岗位" },
                { value: "recruitment_notice", label: "招聘公告" },
              ]}
            />
            <Choice
              label="资格判断"
              value={filters.qualification ?? "all"}
              onChange={(v) => onChange("qualification", v)}
              items={[
                { value: "all", label: "全部资格" },
                { value: "pass", label: "符合已知要求" },
                { value: "unknown", label: "待核实" },
                { value: "fail", label: "不符合明确要求" },
              ]}
            />
            <TextField
              name="job-since"
              label="采集起始日期"
              type="date"
              value={filters.since ?? ""}
              onChange={(v) => onChange("since", v)}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </FieldGroup>
  );
}
