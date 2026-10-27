import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, ApiError, DesktopAdapter } from "../../lib/types";
import { useVersionContext } from "../../app/VersionContext";
import { useOperation } from "../../lib/hooks";
import { validateInput } from "../../../../public/js/validation-rules.js";
import { TextField } from "../../components/TextField";
import { FormFeedback } from "../../components/FormFeedback";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "../../components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../components/ui/card";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../components/ui/tabs";
import { Skeleton } from "../../components/ui/skeleton";
import { LegacyAssignmentPanel } from "./LegacyAssignmentPanel";
import { DedupDialog } from "./DedupDialog";
import { BudgetSummary } from "../../components/BudgetSummary";
import { budgetView } from "../../lib/budget-view";

type Settings = {
  model?: {
    baseUrl?: string;
    model?: string;
    configured?: boolean;
    credentialStatus?: "configured" | "not_configured" | "needs_configuration";
    credentialMessage?: string;
  };
  budgets?: { maxCostCny?: number | null; maxModelRequests?: number };
};
const credentialMessages = {
  configured: "已配置模型访问。",
  not_configured: "尚未配置密钥，规则模式可正常使用。",
  needs_configuration:
    "本地模型凭据与当前配置尚未核对，请重新填写密钥并保存；规则分析仍可使用。",
};
function credentialDescription(settings: Settings | null, stale: boolean) {
  if (stale) return "配置状态待刷新，请刷新后确认模型是否可用。";
  if (!settings) return "正在读取模型配置状态。";
  const status = settings.model?.credentialStatus;
  return credentialMessages[
    status === "configured" ||
    status === "not_configured" ||
    status === "needs_configuration"
      ? status
      : settings.model?.configured
        ? "configured"
        : "not_configured"
  ];
}
function statusRefreshError(message: string) {
  return Object.assign(Error(message), {
    code: "settings_status_refresh_failed",
  });
}
type SettingsMutation = {
  refresh: () => Promise<boolean>;
  begin: () => boolean;
  finish: () => void;
  busy: boolean;
};
const locations: [string, string][] = [
  ["data", "工作区数据"],
  ["history", "当前更新历史"],
  ["backups", "完整业务备份"],
  ["cache", "可重建缓存"],
  ["logs", "诊断日志"],
];

function ModelSettings({
  api,
  settings,
  stale,
  mutation,
}: {
  api: ApiClient;
  settings: Settings;
  stale: boolean;
  mutation: SettingsMutation;
}) {
  const [model, setModel] = useState({
    baseUrl: settings.model?.baseUrl || "https://api.deepseek.com",
    model: settings.model?.model || "deepseek-flash",
  });
  const [cost, setCost] = useState(
    settings.budgets?.maxCostCny == null
      ? ""
      : String(settings.budgets.maxCostCny),
  );
  const [requests, setRequests] = useState(
    String(Math.min(20, settings.budgets?.maxModelRequests ?? 20)),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedDraft, setSavedDraft] = useState(() =>
    JSON.stringify({ model, cost, requests }),
  );
  const currentDraft = JSON.stringify({ model, cost, requests });
  const op = useOperation();
  useEffect(() => {
    if (!stale && op.error?.code === "settings_status_refresh_failed")
      op.clear();
  }, [stale, op.error?.code, op.clear]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const fieldErrors = { ...errors, ...op.error?.fieldErrors };
  const change = (action: () => void) => {
    action();
    setErrors({});
    op.clear();
  };
  async function save() {
    const input = {
      model: { baseUrl: model.baseUrl.trim(), model: model.model.trim() },
      budgets:
        cost === ""
          ? {
              maxModelRequests: requests,
              ...(settings.budgets?.maxCostCny != null
                ? { maxCostCny: null }
                : {}),
            }
          : { maxModelRequests: 1000, maxCostCny: cost },
    };
    const invalid = validateInput("settings", input) as Record<string, string>;
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    if (!mutation.begin()) return;
    try {
      await op.run(async () => {
        await api.request("/settings", {
          method: "PUT",
          body: {
            ...input,
            budgets: {
              maxModelRequests: cost === "" ? Number(requests) : 1000,
              ...(cost !== ""
                ? { maxCostCny: Number(cost) }
                : settings.budgets?.maxCostCny != null
                  ? { maxCostCny: null }
                  : {}),
            },
          },
        });
        if (!live.current) return;
        // The write has committed even if its following read fails.
        setSavedDraft(currentDraft);
        if (!(await mutation.refresh()))
          throw statusRefreshError(
            "设置已保存，但配置状态刷新失败。请点击“刷新配置状态”重试。",
          );
      }, "设置已保存");
    } finally {
      mutation.finish();
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>模型与每任务预算</CardTitle>
        <CardDescription>
          {credentialDescription(settings, stale)}
          费用填写元，当前模型 v4.1 的 API 标识为 deepseek-flash。
        </CardDescription>
      </CardHeader>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        <CardContent className="flex flex-col gap-4">
          <BudgetSummary
            label={
              savedDraft === currentDraft
                ? "已保存预算设置"
                : "预算设置（待保存）"
            }
            view={budgetView({
              modelBudget: {
                maxCostCny: cost === "" ? null : Number(cost),
                maxModelRequests: cost === "" ? Number(requests) : 1000,
              },
            })}
          />
          <FormFeedback errors={fieldErrors} error={op.error} />
          <FieldGroup>
            <TextField
              name="model.baseUrl"
              label="兼容 API endpoint"
              value={model.baseUrl}
              onChange={(value) =>
                change(() => setModel((m) => ({ ...m, baseUrl: value })))
              }
              error={fieldErrors["model.baseUrl"]}
              disabled={op.busy}
              description="完整 HTTP(S) 地址，不包含用户名或密码；可使用本地模型地址。"
            />
            <TextField
              name="model.model"
              label="模型名称"
              value={model.model}
              onChange={(value) =>
                change(() => setModel((m) => ({ ...m, model: value })))
              }
              error={fieldErrors["model.model"]}
              disabled={op.busy}
            />
            <TextField
              name="budgets.maxCostCny"
              label="每任务模型费用上限（元）"
              type="number"
              min="0"
              max="10"
              step="0.01"
              value={cost}
              onChange={(v) => change(() => setCost(v))}
              error={fieldErrors["budgets.maxCostCny"]}
              disabled={op.busy}
              description="官方 deepseek-flash 可填 0–10 元，最多两位小数；0 表示不发起模型调用。兼容服务商留空，改用请求次数预算。"
            />
            {cost === "" && (
              <TextField
                name="budgets.maxModelRequests"
                label="每任务模型尝试上限"
                type="number"
                min="0"
                max="20"
                step="1"
                value={requests}
                onChange={(v) => change(() => setRequests(v))}
                error={fieldErrors["budgets.maxModelRequests"]}
                disabled={op.busy}
                description="填写整数 0–20，重试计入；0 表示不调用模型。"
              />
            )}
          </FieldGroup>
          <p className="text-muted-foreground">
            费用模式按已核实官方价格计算费用上界，包含进行中和用量不确定的调用；另有
            1000 次辅助上限。未配置价格不估算费用。
          </p>
          <OperationFeedback busy={op.busy} result={op.message} />
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={op.busy || mutation.busy}>
            保存模型与预算设置
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function DesktopKey({
  desktop,
  settings,
  stale,
  mutation,
}: {
  desktop: DesktopAdapter;
  settings: Settings | null;
  stale: boolean;
  mutation: SettingsMutation;
}) {
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const op = useOperation();
  useEffect(() => {
    if (!stale && op.error?.code === "settings_status_refresh_failed")
      op.clear();
  }, [stale, op.error?.code, op.clear]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const confirmed = (receipt: unknown, action: "保存" | "清除") => {
    if (
      !receipt ||
      typeof receipt !== "object" ||
      (receipt as { cancelled?: unknown }).cancelled === true ||
      (receipt as { success?: unknown }).success === false ||
      typeof (receipt as { configured?: unknown }).configured !== "boolean"
    )
      throw Error(`未收到桌面密钥${action}确认，请检查配置状态后重试。`);
    return (receipt as { configured: boolean }).configured;
  };
  async function save() {
    const invalid = validateInput(
      "key",
      { userApiKey: key },
      { required: true },
    ) as Record<string, string>;
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    if (!mutation.begin()) return;
    try {
      await op.run(async () => {
        if (!(await desktop.isAvailable()))
          throw new Error("系统加密不可用，不能保存密钥。");
        if (!live.current) return;
        const receipt = await desktop.saveKey("deepseek", key.trim());
        if (!live.current) return;
        if (!confirmed(receipt, "保存")) {
          await mutation.refresh();
          throw Error("桌面密钥尚未配置成功，请检查模型设置后重试。");
        }
        setKey("");
        if (!(await mutation.refresh()))
          throw statusRefreshError(
            "桌面密钥已加密保存，但配置状态刷新失败。请点击“刷新配置状态”重试。",
          );
      }, "桌面密钥已加密保存");
    } finally {
      mutation.finish();
    }
  }
  async function remove() {
    if (!mutation.begin()) return;
    try {
      await op.run(async () => {
        const receipt = await desktop.deleteKey("deepseek");
        if (!live.current) return;
        if (confirmed(receipt, "清除")) {
          await mutation.refresh();
          throw Error("桌面密钥尚未清除，请刷新配置状态后重试。");
        }
        setKey("");
        if (!(await mutation.refresh()))
          throw statusRefreshError(
            "桌面密钥已清除，但配置状态刷新失败。请点击“刷新配置状态”重试。",
          );
      }, "桌面密钥已清除");
    } finally {
      mutation.finish();
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>桌面密钥</CardTitle>
        <CardDescription>
          {desktop.available
            ? credentialDescription(settings, stale) ===
              credentialMessages.configured
              ? "已保存加密密钥，模型访问已配置，不显示原文。"
              : credentialDescription(settings, stale)
            : "浏览器不保存桌面密钥，模型任务可使用任务页面的临时输入。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FormFeedback errors={errors} error={op.error} />
        <FieldGroup>
          <TextField
            name="userApiKey"
            label="桌面密钥"
            value={key}
            onChange={(v) => {
              setKey(v);
              setErrors({});
              op.clear();
            }}
            error={errors.userApiKey || op.error?.fieldErrors?.userApiKey}
            type="password"
            autoComplete="off"
            disabled={op.busy || !desktop.available}
            description="不回显保存的 Key；只通过桌面加密桥接处理，设置 API 不包含密钥。"
          />
        </FieldGroup>
        <OperationFeedback busy={op.busy} result={op.message} />
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          disabled={op.busy || mutation.busy || !desktop.available}
          onClick={() => void save()}
        >
          加密保存桌面 Key
        </Button>
        <Button
          variant="outline"
          disabled={op.busy || mutation.busy || !desktop.available}
          onClick={() => void remove()}
        >
          清除桌面 Key
        </Button>
      </CardFooter>
    </Card>
  );
}

function DataLocations({ desktop }: { desktop: DesktopAdapter }) {
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const op = useOperation();
  useEffect(() => {
    if (!desktop.available) return;
    let live = true;
    desktop
      .getDataLocations()
      .then((value) => {
        if (live && value && typeof value === "object")
          setPaths(
            Object.fromEntries(
              locations.flatMap(([kind]) => {
                const v = (value as Record<string, unknown>)[kind];
                return typeof v === "string" ? [[kind, v]] : [];
              }),
            ),
          );
      })
      .catch((e) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [desktop]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>本地数据与保存位置</CardTitle>
        <CardDescription>
          {desktop.available
            ? "业务数据、检索历史、备份、缓存与诊断日志分别保存。"
            : "浏览器使用服务器工作区，下载位置由浏览器决定。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <OperationFeedback
          error={error || op.error}
          result={op.message}
          busy={op.busy}
        />
        {locations
          .filter(([kind]) => paths[kind])
          .map(([kind, label]) => (
            <div
              key={kind}
              className="flex flex-col gap-2 rounded-lg border p-4"
            >
              <p>{label}</p>
              <code className="break-all">{paths[kind]}</code>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={op.busy}
                  aria-label={"打开" + label}
                  onClick={() =>
                    void op.run(
                      () => desktop.openDataLocation(kind),
                      "已打开" + label,
                    )
                  }
                >
                  打开目录
                </Button>
                <Button
                  variant="outline"
                  disabled={op.busy}
                  aria-label={"复制" + label + "路径"}
                  onClick={() =>
                    void op.run(
                      () => desktop.copyDataLocation(kind),
                      label + "路径已复制",
                    )
                  }
                >
                  复制路径
                </Button>
              </div>
            </div>
          ))}
      </CardContent>
      <CardFooter>
        <p className="text-muted-foreground">
          请通过软件备份恢复，不要手动移动正在使用的目录。
        </p>
      </CardFooter>
    </Card>
  );
}

async function readFile(file: File) {
  if (typeof file.text === "function") return file.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取备份文件。"));
    reader.readAsText(file);
  });
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Backups({ api }: { api: ApiClient }) {
  const context = useVersionContext();
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const op = useOperation();
  const fieldErrors = { ...errors, ...op.error?.fieldErrors };
  async function restore() {
    const invalid = validateInput("backup", { file }) as Record<string, string>;
    setErrors(invalid);
    if (Object.keys(invalid).length || !file) return;
    const committed = await op.run(async () => {
      let archive: unknown;
      try {
        archive = JSON.parse(await readFile(file));
      } catch {
        throw Object.assign(new Error("备份内容不是有效 JSON。"), {
          fieldErrors: { file: "请选择有效的工作区备份。" },
        } satisfies Partial<ApiError>);
      }
      await api.request("/workspace/restore", {
        method: "POST",
        body: { archive },
      });
    }, "工作区已恢复");
    if (committed) {
      context.select(null);
      await context.refresh();
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>工作区备份与恢复</CardTitle>
        <CardDescription>
          备份保留各版本的独立业务记录，不含凭据。恢复会校验完整性，并过滤本机已永久删除或到期的记录。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FormFeedback errors={fieldErrors} error={op.error} />
        <FieldGroup>
          <Field data-invalid={Boolean(fieldErrors.file)}>
            <FieldLabel htmlFor="file">恢复备份文件</FieldLabel>
            <Input
              id="file"
              type="file"
              accept=".json"
              disabled={op.busy}
              aria-invalid={Boolean(fieldErrors.file)}
              aria-describedby={
                fieldErrors.file ? "file-error" : "file-description"
              }
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setErrors({});
                op.clear();
              }}
            />
            <FieldDescription id="file-description">
              本软件下载的非空 JSON 备份，最大 38
              MiB。岗位导出文件不能用于恢复。
            </FieldDescription>
            {fieldErrors.file && (
              <FieldError id="file-error">{fieldErrors.file}</FieldError>
            )}
          </Field>
        </FieldGroup>
        <OperationFeedback busy={op.busy} result={op.message} />
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={op.busy}
          onClick={() =>
            void op.run(async () => {
              const archive = await api.request("/workspace/backup", {
                method: "POST",
                body: {},
              });
              downloadBlob(
                new Blob([JSON.stringify(archive, null, 2)], {
                  type: "application/json",
                }),
                "job-radar-backup.json",
              );
            }, "备份已生成，已开始下载")
          }
        >
          下载工作区备份
        </Button>
        <Button disabled={op.busy} onClick={() => void restore()}>
          校验并恢复
        </Button>
      </CardFooter>
    </Card>
  );
}

export function SettingsPage({
  api,
  desktop,
}: {
  api: ApiClient;
  desktop: DesktopAdapter;
}) {
  const context = useVersionContext();
  const [tab, setTab] = useState("model");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const activeMutation = useRef(false);
  const live = useRef(true);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!live.current) return false;
    const token = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRefreshing(true);
    try {
      const value = await api.request<Settings>("/settings", {
        signal: controller.signal,
      });
      if (
        !live.current ||
        token !== generation.current ||
        controller.signal.aborted
      )
        return false;
      setSettings(value);
      setError(null);
      setStale(false);
      return true;
    } catch (e) {
      if (
        live.current &&
        token === generation.current &&
        !controller.signal.aborted
      ) {
        setError(e);
        setStale(true);
      }
      return false;
    } finally {
      if (live.current && token === generation.current) setRefreshing(false);
    }
  }, [api]);
  useEffect(() => {
    live.current = true;
    setSettings(null);
    setError(null);
    setStale(false);
    void refresh();
    return () => {
      live.current = false;
      generation.current++;
      request.current?.abort();
    };
  }, [refresh]);
  const mutation: SettingsMutation = {
    refresh,
    busy: mutationBusy,
    begin() {
      if (!live.current || activeMutation.current) return false;
      activeMutation.current = true;
      setMutationBusy(true);
      return true;
    },
    finish() {
      activeMutation.current = false;
      if (live.current) setMutationBusy(false);
    },
  };
  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1>设置</h1>
        <p className="text-muted-foreground">
          管理模型预算、本地数据、备份和版本维护。
        </p>
      </header>
      <OperationFeedback error={error} />
      {stale && (
        <Button
          variant="outline"
          disabled={refreshing || mutationBusy}
          onClick={() => void refresh()}
        >
          刷新配置状态
        </Button>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="model">模型与预算</TabsTrigger>
          <TabsTrigger value="data">数据与备份</TabsTrigger>
          <TabsTrigger value="versions">版本维护</TabsTrigger>
        </TabsList>
        <TabsContent value="model" keepMounted>
          <div className="flex flex-col gap-6">
            {settings ? (
              <ModelSettings
                api={api}
                settings={settings}
                stale={stale}
                mutation={mutation}
              />
            ) : (
              !error && <Skeleton className="h-40 w-full" />
            )}
            <DesktopKey
              desktop={desktop}
              settings={settings}
              stale={stale}
              mutation={mutation}
            />
          </div>
        </TabsContent>
        <TabsContent value="data">
          <div className="flex flex-col gap-6">
            <DataLocations desktop={desktop} />
            <Backups api={api} />
          </div>
        </TabsContent>
        <TabsContent value="versions">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>所有版本岗位维护</CardTitle>
                <CardDescription>
                  逐版本保守去重；相同岗位在不同目标中的记录、评价和投递保持独立。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DedupDialog
                  api={api}
                  allVersions
                  onCompleted={() => context.refresh()}
                />
              </CardContent>
              <CardFooter>
                <p className="text-muted-foreground">
                  到期和清理中的回收包由回收站处理，不能去重延长保留时间。
                </p>
              </CardFooter>
            </Card>
            <LegacyAssignmentPanel
              api={api}
              onChanged={() => context.refresh()}
            />
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
