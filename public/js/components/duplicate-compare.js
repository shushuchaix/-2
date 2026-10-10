import { el, button, field } from "./dom.js";
import { bindValidation } from "./form-validation.js";
export function duplicateCompare({
  document: d,
  job,
  relatedJobs = [],
  api,
  onChanged,
  status,
}) {
  const section = el(
    d,
    "section",
    { className: "detail-section" },
    el(d, "h3", {}, "关联记录"),
    el(
      d,
      "p",
      { className: "muted" },
      "关联保留两条记录和各自事实，不会合并或删除。",
    ),
  );
  for (const other of relatedJobs) {
    const unlink = button(d, "取消关联", async () => {
      if (unlink.disabled) return;
      unlink.disabled = true;
      try {
        await api.request("/jobs/" + encodeURIComponent(job.jobId) + "/links", {
          method: "DELETE",
          body: { jobId: other.jobId },
        });
        status.show("关联已取消", false, { notify: true });
        await onChanged();
      } catch (e) {
        status.show("取消关联失败：" + e.message, true);
      } finally {
        unlink.disabled = false;
      }
    });
    section.append(
      el(
        d,
        "div",
        { className: "card" },
        el(d, "strong", {}, other.canonical.title),
        el(d, "p", {}, other.canonical.company || "公司未提供"),
        el(d, "p", {}, (other.canonical.cities || []).join(" / ")),
        unlink,
      ),
    );
  }
  const id = el(d, "input", {
      id: "linkedJobId",
      placeholder: "另一条记录的岗位 ID",
      "aria-label": "关联岗位 ID",
    }),
    form = el(d, "form"),
    save = el(d, "button", { type: "submit" }, "关联记录"),
    values = () => ({ jobId: id.value.trim() });
  form.append(
    field(
      d,
      "关联岗位 ID",
      id,
      "填写另一条记录详情中的岗位 ID；不得关联当前记录。关联后两条记录仍独立保留。",
    ),
    save,
  );
  const validation = bindValidation(form, {
    kind: "link",
    fields: { jobId: id },
    values,
    options: () => ({ selfId: job.jobId }),
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (save.disabled || !validation.check()) return;
    save.disabled = true;
    id.disabled = true;
    try {
      await api.request("/jobs/" + encodeURIComponent(job.jobId) + "/links", {
        method: "POST",
        body: values(),
      });
      validation.clear();
      await onChanged();
      status.show("记录已关联", false, { notify: true });
    } catch (e) {
      id.disabled = false;
      validation.show(e);
    } finally {
      save.disabled = false;
      id.disabled = false;
    }
  });
  section.append(form);
  return section;
}
