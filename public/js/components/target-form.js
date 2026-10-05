import { el, field, list } from "./dom.js";
import { bindValidation } from "./form-validation.js";
export function targetForm({
  document: d,
  profiles = [],
  target = {},
  sourceIds = [],
  onSave,
}) {
  const form = el(d, "form", { id: "targetForm" }),
    profile = el(
      d,
      "select",
      { id: "targetProfile" },
      profiles.map((p) =>
        el(
          d,
          "option",
          { value: p.revisionId },
          (p.profile.name || "画像") + " · " + p.revisionId,
        ),
      ),
    ),
    roles = el(d, "input", {
      id: "targetRoles",
      value: (target.roles || []).join("、"),
    }),
    cityMode = el(
      d,
      "select",
      { id: "cityMode" },
      [
        ["any", "不限城市"],
        ["from_profile", "从画像取值"],
        ["selected", "指定城市"],
      ].map(([v, t]) => el(d, "option", { value: v }, t)),
    ),
    cities = el(d, "input", {
      id: "targetCities",
      value: (target.cities || []).join("、"),
    }),
    degree = el(
      d,
      "select",
      { id: "degreePolicy" },
      el(d, "option", { value: "eligibility" }, "按本人学历判断资格"),
      el(
        d,
        "option",
        { value: "minimum_requirement" },
        "只看要求至少达到指定学历的岗位",
      ),
    ),
    minDegree = el(
      d,
      "select",
      { id: "minDegree" },
      ["大专", "本科", "硕士", "博士"].map((x) =>
        el(d, "option", { value: x }, x),
      ),
    ),
    coverage = el(
      d,
      "select",
      { id: "coverageMode" },
      el(d, "option", { value: "standard" }, "标准 · 12站点 / 120请求"),
      el(d, "option", { value: "broad" }, "广泛 · 24站点 / 240请求"),
    ),
    sources = el(d, "input", {
      id: "targetSources",
      value: (target.sourceIds || []).join("、"),
    }),
    year = el(d, "input", {
      id: "targetYear",
      value: target.graduationYear || "",
      type: "number",
    }),
    types = ["campus", "internship", "social", "unknown"].map((v, i) =>
      el(
        d,
        "label",
        { className: "inline-check" },
        el(d, "input", {
          type: "checkbox",
          name: "jobType",
          value: v,
          checked: (target.jobTypes || ["campus", "internship"]).includes(v),
        }),
        ["校招", "实习", "社招", "未标类型"][i],
      ),
    ),
    save = el(
      d,
      "button",
      {
        type: "submit",
        className: "primary",
        id: "saveTarget",
        disabled: !profiles.length,
      },
      target.targetId ? "保存目标新版本" : "保存检索目标",
    );
  const typeGroup = el(
    d,
    "fieldset",
    { id: "targetJobTypes", className: "field" },
    el(d, "legend", {}, "招聘类型"),
    el(d, "div", { className: "row" }, types),
    el(d, "small", {}, "必选至少一项；选择校招、实习、社招或未标类型。"),
  );
  profile.value = target.profileRevisionId || profiles.at(-1)?.revisionId || "";
  cityMode.value = target.cityMode || "any";
  degree.value = target.degreePolicy || "eligibility";
  coverage.value = target.coverageMode || "standard";
  minDegree.value = target.minDegree || "本科";
  form.append(
    field(
      d,
      "使用的画像版本",
      profile,
      "必选已保存的画像版本；没有画像时请先确认并保存简历。",
    ),
    field(
      d,
      "求职方向（逗号分隔，最多使用前6个查询词）",
      roles,
      "必填至少一项；逗号或顿号分隔，最多 100 项，每项最多 200 字符。",
    ),
    el(
      d,
      "div",
      { className: "grid" },
      field(d, "城市范围", cityMode, "必选；指定城市时需填写至少一座城市。"),
      field(
        d,
        "指定城市",
        cities,
        "指定城市模式必填；逗号或顿号分隔，最多 100 项，每项最多 200 字符。其他模式不提交此项。",
      ),
      field(
        d,
        "学历口径",
        degree,
        "必选；按本人学历判断，或指定最低岗位要求。",
      ),
      field(
        d,
        "最低要求学历",
        minDegree,
        "指定最低要求模式必选；其他模式不使用此项。",
      ),
      field(
        d,
        "届别",
        year,
        "可空时沿用画像年份；填写 1900–2100 之间的四位毕业年份，例如 2027。",
      ),
      field(
        d,
        "覆盖预算",
        coverage,
        "必选标准或广泛；来源采集仍受任务预算限制。",
      ),
    ),
    typeGroup,
    field(
      d,
      "来源 ID（留空使用所有可用来源）",
      sources,
      "可空；逗号或顿号分隔，需为数据源页面中已存在的来源 ID。",
    ),
    save,
  );
  const values = () => ({
    ...target,
    profileRevisionId: profile.value,
    roles: list(roles.value),
    cityMode: cityMode.value,
    cities: cityMode.value === "selected" ? list(cities.value) : [],
    degreePolicy: degree.value,
    minDegree: degree.value === "minimum_requirement" ? minDegree.value : null,
    jobTypes: types
      .map((l) => l.querySelector("input"))
      .filter((x) => x.checked)
      .map((x) => x.value),
    sourceIds: list(sources.value),
    coverageMode: coverage.value,
    graduationYear: year.value,
  });
  const validation = bindValidation(form, {
    kind: "target",
    fields: {
      profileRevisionId: profile,
      roles,
      cityMode,
      cities,
      degreePolicy: degree,
      minDegree,
      graduationYear: year,
      jobTypes: typeGroup,
      sourceIds: sources,
      coverageMode: coverage,
    },
    values,
    options: () => ({
      profileRevisionIds: profiles.map((p) => p.revisionId),
      sourceIds,
    }),
  });
  const updateDependentFields = () => {
    cities.disabled = cityMode.value !== "selected";
    minDegree.disabled = degree.value !== "minimum_requirement";
  };
  cityMode.addEventListener("change", updateDependentFields);
  degree.addEventListener("change", updateDependentFields);
  updateDependentFields();
  let busy = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || !validation.check()) return;
    busy = true;
    save.disabled = true;
    const input = values();
    input.graduationYear = year.value ? Number(year.value) : null;
    try {
      await onSave(input);
    } catch (e) {
      validation.show(e);
    } finally {
      busy = false;
      save.disabled = !profiles.length;
    }
  });
  return form;
}
