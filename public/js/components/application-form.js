import { el, field } from "./dom.js";
import { feedback } from "./feedback.js";
import { bindValidation } from "./form-validation.js";
import { STATUS_LABELS, localDate, formatDate } from "../format.js";
import { versionLabel } from "../version-management.js";
export function applicationForm({
  document: d,
  application,
  profiles = [],
  onSave,
}) {
  let current = application;
  const form = el(d, "form", { id: "applicationForm" }),
    status = feedback(d),
    selection = el(
      d,
      "select",
      { id: "applicationStatus" },
      Object.entries(STATUS_LABELS).map(([v, t]) =>
        el(d, "option", { value: v }, t),
      ),
    ),
    note = el(
      d,
      "textarea",
      { id: "applicationNote", rows: 5 },
      current.note || "",
    ),
    resume = el(
      d,
      "select",
      { id: "applicationResume" },
      el(d, "option", { value: "" }, "未记录"),
      profiles
        .filter(
          (p) => !p.archivedAt || p.revisionId === current.resumeRevisionId,
        )
        .map((p) =>
          el(
            d,
            "option",
            { value: p.revisionId, disabled: !!p.archivedAt },
            versionLabel(p),
          ),
        ),
    ),
    applied = el(d, "input", {
      id: "appliedAt",
      type: "date",
      value: localDate(current.appliedAt),
    }),
    follow = el(d, "input", {
      id: "followUpAt",
      type: "date",
      value: localDate(current.followUpAt),
    }),
    save = el(
      d,
      "button",
      { type: "submit", className: "primary" },
      "保存投递记录",
    ),
    history = el(d, "div", { className: "prose" });
  selection.value = current.status;
  resume.value = current.resumeRevisionId || "";
  const renderHistory = () => {
    history.textContent = (current.events || [])
      .map(
        (e) =>
          formatDate(e.at) +
          " · " +
          Object.entries(e.changes || {})
            .map(
              ([k, v]) => k + ": " + (v.from ?? "空") + " → " + (v.to ?? "空"),
            )
            .join("；"),
      )
      .join("\n");
  };
  renderHistory();
  form.append(
    field(d, "投递状态", selection, "请选择当前进度；保存后会记录变更历史。"),
    field(
      d,
      "备注（可以清空）",
      note,
      "最多 20,000 字；清空后保存可删除原备注。",
    ),
    field(
      d,
      "使用的简历版本",
      resume,
      "可选择已保存的画像版本，也可保留“未记录”。",
    ),
    el(
      d,
      "div",
      { className: "grid" },
      field(
        d,
        "投递日期",
        applied,
        "选填，使用有效日历日期；清空后保存可删除日期。",
      ),
      field(d, "下次跟进日期", follow, "选填，可记录过去或未来的跟进日期。"),
    ),
    save,
    status.node,
    el(d, "h3", {}, "变更历史"),
    history,
  );
  const fields = {
      status: selection,
      note,
      resumeRevisionId: resume,
      appliedAt: applied,
      followUpAt: follow,
    },
    values = () => ({
      status: selection.value,
      note: note.value,
      resumeRevisionId: resume.value || null,
      appliedAt: applied.value || null,
      followUpAt: follow.value || null,
    }),
    validation = bindValidation(form, {
      kind: "application",
      fields,
      values,
      options: () => ({
        profileRevisionIds: profiles.map((p) => p.revisionId),
      }),
    });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled || !validation.check()) return;
    save.disabled = true;
    status.show("");
    for (const node of Object.values(fields)) node.disabled = true;
    try {
      const updated = await onSave(values());
      current = updated;
      renderHistory();
      validation.clear();
      status.show("投递记录已保存", false, { notify: true });
    } catch (e) {
      for (const node of Object.values(fields)) node.disabled = false;
      validation.show(e);
      status.show("投递记录未保存。输入已保留，可修改后重试。", true);
    } finally {
      save.disabled = false;
      for (const node of Object.values(fields)) node.disabled = false;
    }
  });
  return form;
}
