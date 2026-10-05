import { el, field } from "./dom.js";
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
    field(d, "求职目标", target),
    field(d, "查看范围", view),
    field(d, "搜索", search),
    field(d, "城市", city),
    field(d, "来源", source),
    field(d, "投递状态", status),
    field(d, "最近发现自", since),
    el(d, "button", { type: "submit" }, "筛选"),
  );
  const values = () => ({
    targetRevisionId: target.value,
    search: search.value,
    cities: city.value,
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
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    onChange(values());
  });
  return { node: form, target, values };
}
