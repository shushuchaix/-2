import { readAllJobs } from "../jobs-data.js";
import { el, button } from "../components/dom.js";
import { feedback } from "../components/feedback.js";
import { applicationBoard } from "../components/application-board.js";
import { applicationForm } from "../components/application-form.js";
import { STATUS_LABELS } from "../format.js";
export function mountApplicationsPage({ root, api }) {
  const d = root.ownerDocument,
    status = feedback(d),
    content = el(d, "div"),
    unresolvedPanel = el(d, "section", { className: "card", hidden: true }),
    editor = el(d, "section", { className: "card", hidden: true }),
    filter = el(
      d,
      "select",
      { "aria-label": "投递状态筛选" },
      el(d, "option", { value: "" }, "所有状态"),
      Object.entries(STATUS_LABELS).map(([v, t]) =>
        el(d, "option", { value: v }, t),
      ),
    );
  let mode = "board",
    items = [],
    unresolved = [],
    profiles = [],
    destroyed = false,
    version = 0;
  root.replaceChildren(
    el(
      d,
      "div",
      { className: "page-head" },
      el(
        d,
        "div",
        {},
        el(d, "p", { className: "section-label" }, "APPLICATIONS"),
        el(d, "h1", {}, "投递进度"),
        el(d, "p", {}, "记录每一步，把下次跟进留在视野里。"),
      ),
      el(
        d,
        "div",
        { className: "row" },
        button(d, "看板", () => {
          mode = "board";
          render();
        }),
        button(d, "列表", () => {
          mode = "list";
          render();
        }),
      ),
    ),
    el(d, "div", { className: "toolbar" }, filter),
    status.node,
    content,
    unresolvedPanel,
    editor,
  );
  async function edit(id, pending = false) {
    try {
      const detail = await api.request(
        (pending ? "/applications/" : "/jobs/") + encodeURIComponent(id),
      );
      if (destroyed) return;
      editor.hidden = false;
      editor.replaceChildren(
        el(d, "h2", {}, pending ? "待确认旧记录" : detail.job.canonical.title),
        pending
          ? el(
              d,
              "p",
              {},
              "旧标识对应多个岗位。编辑只更新这条旧投递记录，候选岗位的状态独立保留。",
            )
          : null,
        pending
          ? el(
              d,
              "ul",
              {},
              detail.candidateJobs.map((j) =>
                el(
                  d,
                  "li",
                  {},
                  j.canonical.title +
                    " · " +
                    (j.canonical.cities || []).join(" / "),
                ),
              ),
            )
          : null,
        button(d, "关闭编辑", () => {
          editor.hidden = true;
        }),
        applicationForm({
          document: d,
          application: detail.application,
          profiles,
          onSave: async (body) => {
            const updated = await api.request(
              "/applications/" + encodeURIComponent(id),
              {
                method: "PUT",
                body,
              },
            );
            items = items.map((i) =>
              [id, updated.jobId, updated.originalApplicationId].includes(
                i.jobId,
              )
                ? { ...i, application: updated }
                : i,
            );
            unresolved = unresolved.map((i) =>
              i.application.jobId === id ? { ...i, application: updated } : i,
            );
            render();
            await load();
            return updated;
          },
        }),
      );
      editor.scrollIntoView?.({ block: "start", behavior: "smooth" });
      editor.querySelector("select")?.focus();
    } catch (e) {
      status.show(e.message, true);
    }
  }
  function render() {
    content.replaceChildren(
      applicationBoard({ document: d, items, mode, onEdit: edit }),
    );
    unresolvedPanel.hidden = !unresolved.length;
    unresolvedPanel.replaceChildren(
      el(d, "h2", {}, "待确认旧记录"),
      el(d, "p", {}, "这些旧投递记录对应多个候选岗位，尚未确定归属。"),
      ...unresolved
        .filter((i) => !filter.value || i.application.status === filter.value)
        .map((i) =>
          el(
            d,
            "article",
            { className: "card" },
            el(
              d,
              "p",
              {},
              i.application.jobId + " · " + STATUS_LABELS[i.application.status],
            ),
            el(
              d,
              "p",
              { className: "prose" },
              i.application.note || "暂无备注",
            ),
            button(
              d,
              "查看并编辑旧记录",
              () => edit(i.application.jobId, true),
              { "data-edit-unresolved": i.application.jobId },
            ),
          ),
        ),
    );
  }
  async function load() {
    const request = ++version;
    try {
      const [data, pending] = await Promise.all([
        readAllJobs(api, { status: filter.value }),
        api.request(
          "/applications/unresolved?status=" + encodeURIComponent(filter.value),
        ),
      ]);
      if (destroyed || request !== version) return;
      items = data.items;
      unresolved = pending.items || [];
      render();
    } catch (e) {
      if (!destroyed) status.show(e.message, true);
    }
  }
  filter.addEventListener("change", load);
  const ready = (async () => {
    try {
      profiles = (await api.request("/profiles")).profiles;
      await load();
    } catch (e) {
      if (!destroyed) status.show(e.message, true);
    }
  })();
  return {
    ready,
    destroy() {
      destroyed = true;
      version++;
      root.replaceChildren();
    },
  };
}
