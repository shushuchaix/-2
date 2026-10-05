import { el, field, list } from "./dom.js";
import { bindValidation } from "./form-validation.js";
import { STATUS_LABELS } from "../format.js";
export function jobFilters({ document: d, targets, onChange }) {
  const form = el(d, "form", { className: "toolbar" }),
    select = (id, options) =>
      el(
        d,
        "select",
        { id },
        options.map(([v, t]) => el(d, "option", { value: v }, t)),
      ),
    target = select("jobsTarget", [
      ["", "所有目标"],
      ...targets.map((t) => [
        t.revisionId,
        t.roles.join(" / ") + " · v" + t.revision,
      ]),
    ]),
    view = select("jobsView", [
      ["", "全部记录"],
      ["high", "优先推荐"],
      ["unknown", "待核实"],
      ["recruitment_notice", "招聘公告"],
      ["company_campaign", "公司窗口"],
      ["not_recommended", "排除岗位"],
    ]),
    search = el(d, "input", {
      id: "jobSearch",
      placeholder: "岗位 / 公司 / 正文",
    }),
    city = el(d, "input", { id: "jobCity", placeholder: "城市" }),
    source = el(d, "input", { id: "jobSource", placeholder: "来源 ID" }),
    status = select("jobStatus", [
      ["", "所有投递状态"],
      ...Object.entries(STATUS_LABELS),
    ]),
    since = el(d, "input", { id: "jobSince", type: "date" });
  form.append(
    field(d, "求职目标", target, "选择已有目标，或查看所有目标。"),
    field(d, "查看范围", view, "可按推荐结果或记录类型查看。"),
    field(d, "搜索", search, "选填，最多 2,000 字。"),
    field(d, "城市", city, "选填，多个城市用逗号分隔。"),
    field(
      d,
      "来源",
      source,
      "选填，填写来源 ID，例如 tencent；留空查看所有来源。",
    ),
    field(d, "投递状态", status, "留空查看所有投递状态。"),
    field(d, "最近发现自", since, "选填，使用有效日历日期；留空不限制日期。"),
    el(d, "button", { type: "submit" }, "筛选"),
  );
  const values = () => ({
    targetRevisionId: target.value,
    search: search.value,
    cities: list(city.value).join(","),
    sourceId: source.value,
    status: status.value,
    since: since.value,
    ...(view.value === "unknown"
      ? { qualification: "unknown" }
      : ["recruitment_notice", "company_campaign"].includes(view.value)
        ? { kind: view.value }
        : view.value
          ? { recommendation: view.value }
          : {}),
  });
  const validation = bindValidation(form, {
    kind: "filters",
    fields: {
      targetRevisionId: target,
      recommendation: view,
      kind: view,
      qualification: view,
      search,
      city,
      cities: city,
      sourceId: source,
      status,
      since,
    },
    values: () => ({ ...values(), city: city.value, cities: list(city.value) }),
    options: () => ({ targetRevisionIds: targets.map((t) => t.revisionId) }),
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validation.check()) return;
    onChange(values());
  });
  return {
    node: form,
    target,
    values,
    showError: (error) => validation.show(error),
  };
}
