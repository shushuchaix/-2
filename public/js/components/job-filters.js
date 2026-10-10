import { el, field, list } from "./dom.js";
import { bindValidation } from "./form-validation.js";
import { STATUS_LABELS } from "../format.js";
import { versionLabel } from "../version-management.js";
export function jobFilters({ document: d, targets, onChange }) {
  const form = el(d, "form", { className: "toolbar" }),
    select = (id, options) =>
      el(
        d,
        "select",
        { id },
        options.map(([v, t]) => el(d, "option", { value: v }, t)),
      );
  const target = select("jobsTarget", [
    ["all", "全部版本"],
    ["unassigned", "历史未归属"],
    ...targets.map((t) => [t.revisionId, versionLabel(t)]),
  ]);
  const kind = select("jobKind", [
    ["job", "具体岗位"],
    ["recruitment_notice", "招聘公告"],
    ["company_campaign", "公司招聘窗口"],
    ["all", "全部类型"],
  ]);
  const recommendation = select("jobRecommendation", [
    ["all", "全部推荐结果"],
    ["high", "优先推荐"],
    ["consider", "可以考虑"],
    ["low", "匹配较低"],
    ["insufficient", "信息不足"],
    ["not_recommended", "不推荐"],
    ["unevaluated", "尚未评价"],
  ]);
  const qualification = select("jobQualification", [
    ["all", "全部资格"],
    ["pass", "已确认通过"],
    ["unknown", "待核实"],
    ["fail", "不符合"],
  ]);
  const applicationStatus = select("jobStatus", [
    ["all", "全部投递状态"],
    ...Object.entries(STATUS_LABELS),
  ]);
  const duplicateStatus = select("jobDuplicateStatus", [
    ["all", "全部重复情况"],
    ["normal", "正常"],
    ["possible", "疑似重复"],
    ["protected", "人工记录待处理"],
  ]);
  const search = el(d, "input", {
      id: "jobSearch",
      placeholder: "岗位 / 公司 / 正文",
    }),
    city = el(d, "input", { id: "jobCity" }),
    source = el(d, "input", { id: "jobSource" }),
    since = el(d, "input", { id: "jobSince", type: "date" });
  for (const [label, node] of [
    ["求职目标版本", target],
    ["记录类型", kind],
    ["推荐结果", recommendation],
    ["资格", qualification],
    ["投递状态", applicationStatus],
    ["重复情况", duplicateStatus],
    ["搜索", search],
    ["城市", city],
    ["来源 ID", source],
    ["最近发现自", since],
  ])
    form.append(field(d, label, node));
  form.append(el(d, "button", { type: "submit" }, "筛选"));
  const values = () => ({
    targetRevisionId: target.value,
    kind: kind.value,
    recommendation: recommendation.value,
    qualification: qualification.value,
    applicationStatus: applicationStatus.value,
    duplicateStatus: duplicateStatus.value,
    search: search.value,
    cities: list(city.value).join(","),
    sourceId: source.value,
    since: since.value,
  });
  const validation = bindValidation(form, {
    kind: "filters",
    fields: {
      targetRevisionId: target,
      kind,
      recommendation,
      qualification,
      applicationStatus,
      duplicateStatus,
      search,
      city,
      cities: city,
      sourceId: source,
      since,
    },
    values: () => ({ ...values(), cities: list(city.value) }),
    options: () => ({ targetRevisionIds: targets.map((t) => t.revisionId) }),
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (validation.check()) onChange(values());
  });
  return { node: form, target, values, showError: (e) => validation.show(e) };
}
