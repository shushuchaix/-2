import { useEffect, useRef, useState } from "react";
import type {
  ApiClient,
  ApiError,
  ProfileVersion,
  TargetVersion,
} from "../../lib/types";
import { validateInput } from "../../../../public/js/validation-rules.js";
import { useOperation } from "../../lib/hooks";
import { TextField } from "../../components/TextField";
import { FormFeedback } from "../../components/FormFeedback";
import { Button } from "../../components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldSet,
  FieldLegend,
} from "../../components/ui/field";
import { Checkbox } from "../../components/ui/checkbox";
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
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";

type Source = {
  sourceId: string;
  name?: string;
  label?: string;
  enabled?: boolean;
};
type Site = { siteId: string; name?: string; enabled?: boolean };
type Settings = {
  model?: Record<string, unknown>;
  budgets?: Record<string, unknown>;
  settings?: Settings;
};
const split = (value: string) =>
  value
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
const jobTypes = [
  ["campus", "校招"],
  ["internship", "实习"],
  ["social", "社招"],
  ["unknown", "未标类型"],
] as const;
const budgetFields = [
  ["maxCostCny", "模型费用上限（元）"],
  ["maxModelRequests", "模型请求上限"],
  ["maxRequests", "采集请求上限"],
  ["maxSites", "站点上限"],
  ["maxDetails", "详情请求上限"],
] as const;
export function CreateTargetDialog({
  api,
  profiles,
  source,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  profiles: ProfileVersion[];
  source?: TargetVersion;
  onClose(): void;
  onSaved(target: TargetVersion): Promise<void> | void;
}) {
  const available = profiles.filter(
    (p) => !p.archivedAt && (!p.state || p.state === "active"),
  );
  const [step, setStep] = useState(0);
  const [profileRevisionId, setProfile] = useState(
    available.some((p) => p.revisionId === source?.profileRevisionId)
      ? source!.profileRevisionId!
      : available.at(-1)?.revisionId || "",
  );
  const [versionName, setVersionName] = useState("");
  const [roles, setRoles] = useState(source?.roles?.join("、") || "");
  const [cityMode, setCityMode] = useState(source?.cityMode || "any");
  const [cities, setCities] = useState(source?.cities?.join("、") || "");
  const [degreePolicy, setDegreePolicy] = useState(
    String(source?.degreePolicy || "eligibility"),
  );
  const [minDegree, setMinDegree] = useState(
    String(source?.minDegree || "本科"),
  );
  const [year, setYear] = useState(String(source?.graduationYear || ""));
  const [types, setTypes] = useState<string[]>(
    Array.isArray(source?.jobTypes)
      ? (source.jobTypes as string[])
      : ["campus", "internship"],
  );
  const [coverageMode, setCoverage] = useState(
    String(source?.coverageMode || "standard"),
  );
  const [selectedSources, setSources] = useState<string[]>(
    source?.sourceIds || [],
  );
  const [selectedSites, setSites] = useState<string[]>(source?.siteIds || []);
  const [budgets, setBudgets] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(source?.budgets || {}).map(([k, v]) => [k, String(v)]),
    ),
  );
  const [catalog, setCatalog] = useState<{ sources: Source[]; sites: Site[] }>({
    sources: [],
    sites: [],
  });
  const [settings, setSettings] = useState<Settings>({});
  const [catalogError, setCatalogError] = useState<unknown>();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const operation = useOperation();
  const controller = useRef(new AbortController());
  const submission = useRef({ id: crypto.randomUUID(), hash: "" });
  useEffect(() => {
    void Promise.all([
      api.request<{ sources: Source[]; sites: Site[] }>("/sources", {
        signal: controller.current.signal,
      }),
      api.request<Settings>("/settings", { signal: controller.current.signal }),
    ])
      .then(([catalog, data]) => {
        if (controller.current.signal.aborted) return;
        setCatalog(catalog);
        const config = data.settings || data;
        setSettings(config);
        if (!source?.budgets)
          setBudgets(
            Object.fromEntries(
              Object.entries(config.budgets || {})
                .filter(([, v]) => v != null)
                .map(([k, v]) => [k, String(v)]),
            ),
          );
      })
      .catch((error) => {
        if (!controller.current.signal.aborted) setCatalogError(error);
      })
      .finally(() => {
        if (!controller.current.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.current.abort();
  }, [api, source]);
  const allErrors = {
    ...errors,
    ...(operation.error as ApiError | null)?.fieldErrors,
  };
  const chosen = available.find((p) => p.revisionId === profileRevisionId);
  function input() {
    return {
      ...(source ? { targetId: source.targetId } : {}),
      versionName,
      profileRevisionId,
      roles: split(roles),
      cityMode,
      cities: cityMode === "selected" ? split(cities) : [],
      degreePolicy,
      minDegree: degreePolicy === "minimum_requirement" ? minDegree : null,
      graduationYear: year ? Number(year) : null,
      jobTypes: types,
      sourceIds: selectedSources,
      siteIds: selectedSites,
      coverageMode,
      budgets: Object.fromEntries(
        Object.entries(budgets)
          .filter(([, value]) => value !== "")
          .map(([key, value]) => [key, Number(value)]),
      ),
    };
  }
  function validate(current: number) {
    const all = validateInput("target", input(), {
      requireVersionName: current === 3,
      profileRevisionIds: available.map((p) => p.revisionId),
      sourceIds: catalog.sources.map((s) => s.sourceId),
      siteIds: catalog.sites.map((s) => s.siteId),
      model: settings.model,
    }) as Record<string, string>;
    const keys =
      current === 0
        ? ["profileRevisionId"]
        : current === 1
          ? [
              "roles",
              "cityMode",
              "cities",
              "degreePolicy",
              "minDegree",
              "graduationYear",
              "jobTypes",
            ]
          : current === 2
            ? ["sourceIds", "siteIds", "coverageMode", "budgets"]
            : null;
    return keys
      ? Object.fromEntries(
          Object.entries(all).filter(([key]) =>
            keys.some((k) => key === k || key.startsWith(k + ".")),
          ),
        )
      : all;
  }
  function next() {
    operation.clear();
    const validation = validate(step);
    setErrors(validation);
    if (!Object.keys(validation).length) setStep(step + 1);
  }
  async function save() {
    operation.clear();
    const validation = validate(3);
    setErrors(validation);
    if (Object.keys(validation).length) {
      if (validation.profileRevisionId) setStep(0);
      else if (
        Object.keys(validation).some((k) =>
          [
            "roles",
            "cityMode",
            "cities",
            "degreePolicy",
            "minDegree",
            "graduationYear",
            "jobTypes",
          ].includes(k),
        )
      )
        setStep(1);
      else if (
        Object.keys(validation).some(
          (k) =>
            k.startsWith("budgets") ||
            ["sourceIds", "siteIds", "coverageMode"].includes(k),
        )
      )
        setStep(2);
      return;
    }
    const body = input(),
      hash = JSON.stringify(body);
    if (submission.current.hash && submission.current.hash !== hash)
      submission.current.id = crypto.randomUUID();
    submission.current.hash = hash;
    await operation.run(async () => {
      const saved = await api.request<TargetVersion>("/targets", {
        method: "POST",
        body: { ...body, submissionId: submission.current.id },
        signal: controller.current.signal,
      });
      if (!controller.current.signal.aborted) await onSaved(saved);
    }, "目标已保存");
  }
  function option(
    name: string,
    label: string,
    value: string,
    options: [string, string][],
    change: (value: string) => void,
    description?: string,
  ) {
    return (
      <Field data-invalid={Boolean(allErrors[name])}>
        <FieldLabel htmlFor={name}>{label}</FieldLabel>
        <Select
          value={value || null}
          onValueChange={(v) => change(String(v || ""))}
          items={options.map(([value, label]) => ({ value, label }))}
        >
          <SelectTrigger
            id={name}
            aria-invalid={Boolean(allErrors[name])}
            aria-describedby={allErrors[name] ? name + "-error" : undefined}
          >
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {options.map(([id, label]) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {description && <FieldDescription>{description}</FieldDescription>}
        {allErrors[name] && (
          <FieldError role="note" id={name + "-error"}>
            {allErrors[name]}
          </FieldError>
        )}
      </Field>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !operation.busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!operation.busy}
      >
        <DialogHeader>
          <DialogTitle>{source ? "创建目标新版本" : "新建目标"}</DialogTitle>
          <DialogDescription>
            第 {step + 1} / 4 步 ·{" "}
            {["选择简历", "求职偏好", "来源与预算", "摘要与命名"][step]}
          </DialogDescription>
        </DialogHeader>
        <FormFeedback
          errors={allErrors}
          error={operation.error || catalogError}
          onFocusField={(name) => document.getElementById(name)?.focus()}
        />
        <FieldGroup>
          {step === 0 && (
            <>
              {option(
                "profileRevisionId",
                "使用的简历版本",
                profileRevisionId,
                available.map((p) => [p.revisionId, p.versionName]),
                setProfile,
                "保存目标时复制完整简历，之后源简历的更改或删除不影响目标。",
              )}
              {chosen && (
                <p>
                  {String(
                    chosen.profile.education ||
                      chosen.profile.degree ||
                      "学历未知",
                  )}{" "}
                  · {String(chosen.profile.major || "专业未知")}
                </p>
              )}
              {!available.length && (
                <Alert>
                  <AlertTitle>还没有可用简历</AlertTitle>
                  <AlertDescription>
                    请先到简历管理保存简历，或从回收站恢复未到期的简历版本。
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
          {step === 1 && (
            <>
              <TextField
                name="roles"
                label="求职方向"
                value={roles}
                onChange={setRoles}
                error={allErrors.roles}
                description="逗号或顿号分隔，查询最多使用前 6 个方向词。"
              />
              {option(
                "cityMode",
                "城市范围",
                cityMode,
                [
                  ["any", "不限城市"],
                  ["from_profile", "使用简历期望城市"],
                  ["selected", "指定城市"],
                ],
                setCityMode,
              )}
              {cityMode === "selected" && (
                <TextField
                  name="cities"
                  label="指定城市"
                  value={cities}
                  onChange={setCities}
                  error={allErrors.cities}
                  description="至少一座城市，逗号或顿号分隔。"
                />
              )}
              {option(
                "degreePolicy",
                "学历口径",
                degreePolicy,
                [
                  ["eligibility", "按本人学历判断资格"],
                  ["minimum_requirement", "岗位至少要求指定学历"],
                ],
                setDegreePolicy,
              )}
              {degreePolicy === "minimum_requirement" &&
                option(
                  "minDegree",
                  "最低要求学历",
                  minDegree,
                  ["大专", "本科", "硕士", "博士"].map((v) => [v, v]),
                  setMinDegree,
                )}
              <TextField
                name="graduationYear"
                label="届别"
                value={year}
                onChange={setYear}
                error={allErrors.graduationYear}
                description="可空，沿用简历毕业年份；1900–2100。"
              />
              <FieldSet
                id="jobTypes"
                data-invalid={Boolean(allErrors.jobTypes)}
              >
                <FieldLegend>招聘类型</FieldLegend>
                <FieldGroup>
                  {jobTypes.map(([id, label]) => (
                    <Field orientation="horizontal" key={id}>
                      <Checkbox
                        id={"type-" + id}
                        checked={types.includes(id)}
                        onCheckedChange={(checked) =>
                          setTypes((current) =>
                            checked
                              ? [...current, id]
                              : current.filter((v) => v !== id),
                          )
                        }
                        aria-invalid={Boolean(allErrors.jobTypes)}
                      />
                      <FieldLabel htmlFor={"type-" + id}>{label}</FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
                {allErrors.jobTypes && (
                  <FieldError role="note">{allErrors.jobTypes}</FieldError>
                )}
              </FieldSet>
            </>
          )}
          {step === 2 && (
            <>
              {option(
                "coverageMode",
                "覆盖预算",
                coverageMode,
                [
                  ["standard", "标准 · 12 站点 / 120 请求"],
                  ["broad", "广泛 · 24 站点 / 240 请求"],
                ],
                setCoverage,
              )}
              <FieldSet id="sourceIds">
                <FieldLegend>招聘来源</FieldLegend>
                <FieldDescription>
                  不勾选时使用全部可用来源；显示名称，实际保存来源身份。
                </FieldDescription>
                <FieldGroup>
                  {catalog.sources.map((item) => (
                    <Field key={item.sourceId} orientation="horizontal">
                      <Checkbox
                        id={"source-" + item.sourceId}
                        checked={selectedSources.includes(item.sourceId)}
                        onCheckedChange={(checked) =>
                          setSources((current) =>
                            checked
                              ? [...current, item.sourceId]
                              : current.filter((id) => id !== item.sourceId),
                          )
                        }
                      />
                      <FieldLabel htmlFor={"source-" + item.sourceId}>
                        {item.name || item.label || item.sourceId}
                        {item.enabled === false ? "（已停用）" : ""}
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
                {allErrors.sourceIds && (
                  <FieldError role="note">{allErrors.sourceIds}</FieldError>
                )}
              </FieldSet>
              {catalog.sites.length > 0 && (
                <FieldSet id="siteIds">
                  <FieldLegend>指定站点（可选）</FieldLegend>
                  <FieldGroup>
                    {catalog.sites.map((item) => (
                      <Field key={item.siteId} orientation="horizontal">
                        <Checkbox
                          id={"site-" + item.siteId}
                          checked={selectedSites.includes(item.siteId)}
                          onCheckedChange={(checked) =>
                            setSites((current) =>
                              checked
                                ? [...current, item.siteId]
                                : current.filter((id) => id !== item.siteId),
                            )
                          }
                        />
                        <FieldLabel htmlFor={"site-" + item.siteId}>
                          {item.name || item.siteId}
                        </FieldLabel>
                      </Field>
                    ))}
                  </FieldGroup>
                  {allErrors.siteIds && (
                    <FieldError role="note">{allErrors.siteIds}</FieldError>
                  )}
                </FieldSet>
              )}
              {budgetFields.map(([key, label]) => (
                <TextField
                  key={key}
                  name={"budgets." + key}
                  label={label}
                  value={budgets[key] || ""}
                  onChange={(value) =>
                    setBudgets((current) => ({ ...current, [key]: value }))
                  }
                  error={allErrors["budgets." + key]}
                  description={
                    key === "maxCostCny"
                      ? "0–10 元，0 表示规则模式，不调用模型。留空沿用设置。"
                      : "可留空，沿用全局设置；仅填写非负整数。"
                  }
                />
              ))}
              <p className="text-muted-foreground">
                模型：{String(settings.model?.model || "未配置")}
                。新建目标不会发起采集或模型请求。
              </p>
            </>
          )}
          {step === 3 && (
            <>
              <TextField
                name="versionName"
                label="版本名称"
                value={versionName}
                onChange={setVersionName}
                error={allErrors.versionName}
                description="必填 1–60 字符，同种名称不可重复，包括回收站中未清理的名称。"
              />
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt>简历</dt>
                <dd>{chosen?.versionName || "待选择"} · 独立副本</dd>
                <dt>方向</dt>
                <dd>{split(roles).join("、")}</dd>
                <dt>城市</dt>
                <dd>
                  {cityMode === "selected"
                    ? cities
                    : cityMode === "any"
                      ? "不限"
                      : "使用简历期望城市"}
                </dd>
                <dt>来源</dt>
                <dd>
                  {selectedSources.length
                    ? selectedSources
                        .map(
                          (id) =>
                            catalog.sources.find((s) => s.sourceId === id)
                              ?.name || id,
                        )
                        .join("、")
                    : "全部可用来源"}
                </dd>
                <dt>模型费用</dt>
                <dd>
                  {budgets.maxCostCny === "" || budgets.maxCostCny == null
                    ? "沿用设置"
                    : budgets.maxCostCny + " 元"}
                </dd>
              </dl>
              <Alert role="note">
                <AlertTitle>独立的新版本</AlertTitle>
                <AlertDescription>
                  保存新目标时从空岗位库开始，不继承旧目标的评价、检索、投递状态或备注。已有配置通过另建新版本保留。
                </AlertDescription>
              </Alert>
            </>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" disabled={operation.busy} onClick={onClose}>
            取消
          </Button>
          {step > 0 && (
            <Button
              variant="outline"
              disabled={operation.busy}
              onClick={() => {
                operation.clear();
                setErrors({});
                setStep(step - 1);
              }}
            >
              上一步
            </Button>
          )}
          <Button
            disabled={
              operation.busy ||
              !available.length ||
              catalogLoading ||
              Boolean(catalogError)
            }
            onClick={() => void (step === 3 ? save() : next())}
          >
            {operation.busy
              ? "保存中…"
              : catalogLoading
                ? "读取配置…"
                : step === 3
                  ? "保存目标"
                  : "下一步"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
