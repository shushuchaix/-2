import { useEffect, useRef, useState } from "react";
import type { ApiClient, ApiError, ProfileVersion } from "../../lib/types";
import { validateInput } from "../../../../public/js/validation-rules.js";
import { useOperation } from "../../lib/hooks";
import { TextField } from "../../components/TextField";
import { FormFeedback } from "../../components/FormFeedback";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "../../components/ui/field";
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

type Preview = {
  text: string;
  profile: Record<string, unknown>;
  parserVersion?: string;
  warnings?: string[];
};
const split = (text: string) =>
  text
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((v) =>
          typeof v === "string"
            ? v
            : (v?.name || v?.description || "") +
              (v?.proficiency ? "：" + v.proficiency : ""),
        )
        .join("、")
    : "";
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败，请重新选择文件。"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(file);
  });
}
export function ImportProfileDialog({
  api,
  source,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  source?: ProfileVersion;
  onClose(): void;
  onSaved(profile: ProfileVersion): Promise<void> | void;
}) {
  const [step, setStep] = useState(source ? 1 : 0);
  const [resumeText, setResumeText] = useState("");
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<Preview | null>(
    source
      ? {
          text: source.text || "",
          profile: source.profile,
          parserVersion: source.parserVersion,
        }
      : null,
  );
  const [facts, setFacts] = useState<Record<string, string>>(() =>
    toFacts(source?.profile || {}, source?.text || ""),
  );
  const [versionName, setVersionName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const operation = useOperation();
  const controller = useRef(new AbortController());
  const submission = useRef({ id: crypto.randomUUID(), hash: "" });
  useEffect(() => () => controller.current.abort(), []);
  const serverErrors = (operation.error as ApiError | null)?.fieldErrors || {};
  const allErrors = { ...errors, ...serverErrors };
  const update = (key: string, value: string) =>
    setFacts((f) => ({ ...f, [key]: value }));
  function input() {
    const p = preview?.profile || {};
    return {
      ...(versionName.trim() ? { versionName } : {}),
      text: facts.text,
      parserVersion: preview?.parserVersion || "confirmed-1",
      profile: {
        ...p,
        name: facts.name,
        education: facts.education,
        degree: facts.education,
        major: facts.major,
        graduationYear: facts.year ? Number(facts.year) : null,
        cities: split(facts.cities),
        skills: split(facts.skills).map((s) => {
          const [name, ...rest] = s.split(/[:：]/);
          return rest.length ? { name, proficiency: rest.join("：") } : name;
        }),
        certificates: split(facts.certificates),
        projects: facts.projects
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        explicitFacts: {
          ...((p.explicitFacts as Record<string, unknown>) || {}),
          certificates: Boolean(facts.certificates.trim()),
        },
      },
      overrides: { education: facts.education, major: facts.major },
    };
  }
  async function extract() {
    operation.clear();
    const validation = validateInput("preview", { file, resumeText }) as Record<
      string,
      string
    >;
    setErrors(validation);
    if (Object.keys(validation).length) return;
    await operation.run(async () => {
      const body = file
        ? { filename: file.name, base64: await readFile(file) }
        : { resumeText };
      const result = await api.request<Preview>("/profiles/import-preview", {
        method: "POST",
        body,
        signal: controller.current.signal,
      });
      if (controller.current.signal.aborted) return;
      setPreview(result);
      setFacts(toFacts(result.profile, result.text));
      setErrors({});
      setStep(1);
    }, "预览已生成，请校正后保存。");
  }
  function next() {
    operation.clear();
    const validation = validateInput("profile", input()) as Record<
      string,
      string
    >;
    setErrors(validation);
    if (!Object.keys(validation).length) setStep(2);
  }
  async function save() {
    operation.clear();
    const body = input();
    const validation = validateInput("profile", body) as Record<string, string>;
    setErrors(validation);
    if (Object.keys(validation).length) {
      if (Object.keys(validation).some((k) => k !== "versionName")) setStep(1);
      return;
    }
    const hash = JSON.stringify(body);
    if (submission.current.hash && submission.current.hash !== hash)
      submission.current.id = crypto.randomUUID();
    submission.current.hash = hash;
    await operation.run(async () => {
      const saved = await api.request<ProfileVersion>(
        source
          ? "/profiles/" + encodeURIComponent(source.profileId) + "/revisions"
          : "/profiles",
        {
          method: "POST",
          body: { ...body, submissionId: submission.current.id },
          signal: controller.current.signal,
        },
      );
      if (!controller.current.signal.aborted) await onSaved(saved);
    }, "简历已保存");
  }
  const textArea = (
    name: string,
    label: string,
    value: string,
    change: (v: string) => void,
    description?: string,
  ) => (
    <Field data-invalid={Boolean(allErrors[name])}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Textarea
        id={name}
        value={value}
        onChange={(e) => change(e.target.value)}
        aria-invalid={Boolean(allErrors[name])}
        aria-describedby={allErrors[name] ? name + "-error" : undefined}
        rows={name === "text" || name === "resumeText" ? 7 : 3}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {allErrors[name] && (
        <FieldError role="note" id={name + "-error"}>
          {allErrors[name]}
        </FieldError>
      )}
    </Field>
  );
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
          <DialogTitle>{source ? "创建简历新版本" : "导入简历"}</DialogTitle>
          <DialogDescription>
            第 {step + 1} / 3 步 ·{" "}
            {["上传或粘贴", "校正事实", "命名并保存"][step]}
            。保存后形成独立版本。
          </DialogDescription>
        </DialogHeader>
        <FormFeedback
          errors={allErrors}
          error={operation.error}
          onFocusField={(name) => document.getElementById(name)?.focus()}
        />
        <FieldGroup>
          {step === 0 && (
            <>
              <Field data-invalid={Boolean(allErrors.file)}>
                <FieldLabel htmlFor="file">简历文件</FieldLabel>
                <Input
                  id="file"
                  type="file"
                  accept=".txt,.md,.docx,.pdf"
                  onChange={(e) => setFile(e.target.files?.[0])}
                  aria-invalid={Boolean(allErrors.file)}
                  aria-describedby={allErrors.file ? "file-error" : "file-help"}
                />
                <FieldDescription id="file-help">
                  TXT、MD、DOCX、PDF，最多 20 MB。选择文件时优先读取文件；图片
                  PDF 请粘贴正文。
                </FieldDescription>
                {file && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFile(undefined);
                      const node = document.getElementById(
                        "file",
                      ) as HTMLInputElement;
                      if (node) node.value = "";
                    }}
                  >
                    清除文件
                  </Button>
                )}
                {allErrors.file && (
                  <FieldError role="note" id="file-error">
                    {allErrors.file}
                  </FieldError>
                )}
              </Field>
              {textArea(
                "resumeText",
                "粘贴简历正文",
                resumeText,
                setResumeText,
                "没有选择文件时必填 30–60,000 字符。",
              )}
            </>
          )}
          {step === 1 && (
            <>
              {preview?.warnings?.length ? (
                <Alert role="note">
                  <AlertTitle>请核对提取结果</AlertTitle>
                  <AlertDescription>
                    {preview.warnings.join(" ")}
                  </AlertDescription>
                </Alert>
              ) : null}
              {textArea("text", "校正后的简历正文", facts.text, (v) =>
                update("text", v),
              )}
              <TextField
                name="profile.name"
                label="姓名 / 简历名称"
                value={facts.name}
                onChange={(v) => update("name", v)}
                error={allErrors["profile.name"]}
              />
              <Field data-invalid={Boolean(allErrors["profile.education"])}>
                <FieldLabel htmlFor="profile.education">学历</FieldLabel>
                <Select
                  value={facts.education}
                  onValueChange={(v) => update("education", String(v))}
                >
                  <SelectTrigger
                    id="profile.education"
                    aria-invalid={Boolean(allErrors["profile.education"])}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {[
                        "未知",
                        "高中",
                        "中专",
                        "大专",
                        "本科",
                        "硕士",
                        "博士",
                      ].map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {allErrors["profile.education"] && (
                  <FieldError role="note">
                    {allErrors["profile.education"]}
                  </FieldError>
                )}
              </Field>
              <TextField
                name="profile.major"
                label="专业"
                value={facts.major}
                onChange={(v) => update("major", v)}
                error={allErrors["profile.major"]}
              />
              <TextField
                name="profile.graduationYear"
                label="毕业年份"
                value={facts.year}
                onChange={(v) => update("year", v)}
                error={allErrors["profile.graduationYear"]}
                description="未知可留空；1900–2100 之间的四位年份。"
              />
              <TextField
                name="profile.cities"
                label="期望城市"
                value={facts.cities}
                onChange={(v) => update("cities", v)}
                error={allErrors["profile.cities"]}
                description="逗号或顿号分隔。"
              />
              <TextField
                name="profile.certificates"
                label="可确认的证书"
                value={facts.certificates}
                onChange={(v) => update("certificates", v)}
                error={allErrors["profile.certificates"]}
                description="留空表示未知，不推断未填写的证书。"
              />
              {textArea(
                "profile.skills",
                "技能与熟练度",
                facts.skills,
                (v) => update("skills", v),
                "例如：合成技能：熟悉，逗号或顿号分隔。",
              )}
              {textArea(
                "profile.projects",
                "项目摘要",
                facts.projects,
                (v) => update("projects", v),
                "每行一项。",
              )}
            </>
          )}
          {step === 2 && (
            <>
              <TextField
                name="versionName"
                label="版本名称"
                value={versionName}
                onChange={setVersionName}
                error={allErrors.versionName}
                description="可空则自动命名；自定义名称最多 60 字符。同种版本含回收站不可重名。"
              />
              <p>
                确认：{facts.education} · {facts.major || "专业未知"}
                。个人校正将优先保存。
              </p>
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
            disabled={operation.busy}
            onClick={() =>
              void (step === 0 ? extract() : step === 1 ? next() : save())
            }
          >
            {operation.busy
              ? "处理中…"
              : step === 0
                ? "提取并预览"
                : step === 1
                  ? "下一步"
                  : "保存简历"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function toFacts(
  profile: Record<string, unknown>,
  text: string,
): Record<string, string> {
  return {
    text,
    name: String(profile.name || ""),
    education: String(profile.education || profile.degree || "未知"),
    major: String(profile.major || ""),
    year: String(profile.graduationYear || ""),
    cities: strings(profile.cities || profile.preferredCities),
    certificates: strings(profile.certificates),
    skills: strings(profile.skills),
    projects: Array.isArray(profile.projects)
      ? profile.projects
          .map((v) =>
            typeof v === "string" ? v : v?.name || v?.description || "",
          )
          .join("\n")
      : "",
  };
}
