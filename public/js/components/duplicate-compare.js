import { el, button } from "./dom.js";
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
  for (const other of relatedJobs)
    section.append(
      el(
        d,
        "div",
        { className: "card" },
        el(d, "strong", {}, other.canonical.title),
        el(d, "p", {}, other.canonical.company || "公司未提供"),
        el(d, "p", {}, (other.canonical.cities || []).join(" / ")),
        button(d, "取消关联", async () => {
          try {
            await api.request("/jobs/" + job.jobId + "/links", {
              method: "DELETE",
              body: { jobId: other.jobId },
            });
            status.show("关联已取消");
            await onChanged();
          } catch (e) {
            status.show(e.message, true);
          }
        }),
      ),
    );
  const id = el(d, "input", {
    placeholder: "另一条记录的岗位 ID",
    "aria-label": "关联岗位 ID",
  });
  section.append(
    id,
    button(d, "关联记录", async () => {
      try {
        await api.request("/jobs/" + job.jobId + "/links", {
          method: "POST",
          body: { jobId: id.value },
        });
        await onChanged();
        status.show("记录已关联");
      } catch (e) {
        status.show(e.message, true);
      }
    }),
  );
  return section;
}
