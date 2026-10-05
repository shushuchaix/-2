import { el, field, list } from "./dom.js";
import { bindValidation } from "./form-validation.js";
export function profileForm({ document: d, preview = {}, onSave }) {
  const p = preview.profile || {},
    form = el(d, "form", { id: "profileForm" }),
    text = el(
      d,
      "textarea",
      { id: "confirmedText", rows: 7 },
      preview.text || "",
    ),
    education = el(
      d,
      "select",
      { id: "education" },
      ["未知", "大专", "本科", "硕士", "博士"].map((x) =>
        el(d, "option", { value: x }, x),
      ),
    );
  education.value = p.education || p.degree || "未知";
  const input = (id, value) => el(d, "input", { id, value: value || "" });
  const name = input("profileName", p.name),
    major = input("major", p.major),
    year = input("graduationYear", p.graduationYear),
    skills = el(
      d,
      "textarea",
      { id: "skills" },
      (p.skills || [])
        .map((x) =>
          typeof x === "string"
            ? x
            : x.name + (x.proficiency ? "：" + x.proficiency : ""),
        )
        .join("、"),
    ),
    certificates = input(
      "certificates",
      (p.certificates || [])
        .map((x) => (typeof x === "string" ? x : x.name))
        .join("、"),
    ),
    cities = input(
      "profileCities",
      (p.cities || p.preferredCities || []).join("、"),
    ),
    projects = el(
      d,
      "textarea",
      { id: "projects" },
      (p.projects || [])
        .map((x) => (typeof x === "string" ? x : x.name || x.description || ""))
        .join("\n"),
    );
  form.append(
    field(
      d,
      "校正后的简历正文",
      text,
      "必填；30–60,000 字符。请核对提取内容，图片 PDF 可改为粘贴正文。",
    ),
    el(
      d,
      "div",
      { className: "grid" },
      field(
        d,
        "姓名 / 画像名称",
        name,
        "可空；姓名或便于识别的画像名称，最多 200 字符。",
      ),
      field(d, "学历", education, "请选择实际学历；无法确认时保留“未知”。"),
      field(d, "专业", major, "可空；最多 200 字符，未知不要猜测。"),
      field(
        d,
        "毕业年份",
        year,
        "可空；填写 1900–2100 之间的四位年份，例如 2027。",
      ),
      field(
        d,
        "期望城市",
        cities,
        "可空；逗号或顿号分隔，最多 100 项，每项最多 200 字符。",
      ),
      field(
        d,
        "证书（明确填写；留空表示未知）",
        certificates,
        "可空；逗号或顿号分隔，只填写可确认的证书，最多 100 项，每项最多 200 字符。",
      ),
    ),
    field(
      d,
      "技能，可写 Java：熟悉、SQL：了解",
      skills,
      "可空；逗号或顿号分隔，最多 100 项，每项名称与熟练度最多 200 字符。",
    ),
    field(
      d,
      "项目摘要，每行一项",
      projects,
      "可空；最多 100 项，每行最多 20,000 字符。",
    ),
    el(
      d,
      "button",
      { type: "submit", className: "primary" },
      "确认并保存画像版本",
    ),
  );
  const values = () => ({
    text: text.value,
    profile: {
      ...p,
      name: name.value,
      education: education.value,
      degree: education.value,
      major: major.value,
      graduationYear: year.value,
      cities: list(cities.value),
      skills: list(skills.value).map((x) => {
        const [name, proficiency] = x.split(/[:：]/);
        return proficiency ? { name, proficiency } : name;
      }),
      certificates: list(certificates.value),
      projects: projects.value
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean),
      explicitFacts: {
        ...(p.explicitFacts || {}),
        certificates: !!certificates.value.trim(),
      },
    },
    overrides: { education: education.value, major: major.value },
  });
  const validation = bindValidation(form, {
    kind: "profile",
    fields: {
      text,
      "profile.name": name,
      "profile.education": education,
      "profile.major": major,
      "profile.graduationYear": year,
      "profile.cities": cities,
      "profile.certificates": certificates,
      "profile.skills": skills,
      "profile.projects": projects,
    },
    values,
  });
  let busy = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || !validation.check()) return;
    busy = true;
    const save = form.querySelector("button[type=submit]"),
      input = values();
    save.disabled = true;
    input.profile.graduationYear = year.value ? Number(year.value) : null;
    try {
      await onSave(input);
    } catch (e) {
      validation.show(e);
    } finally {
      busy = false;
      save.disabled = false;
    }
  });
  return form;
}
