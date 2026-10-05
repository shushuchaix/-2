import { el, button, latest } from "../components/dom.js";
import { feedback } from "../components/feedback.js";
import { renderJobList } from "../components/job-list.js";
import { jobFilters } from "../components/job-filters.js";
import { openJobDetail } from "../components/job-detail.js";
import { jobImport } from "../components/job-import.js";
export function mountJobsPage({ root, api, store }) {
  const d = root.ownerDocument,
    status = feedback(d),
    list = el(d, "div"),
    filterRoot = el(d, "div"),
    pager = el(d, "div", { className: "row" });
  let destroyed = false,
    queryController,
    requestId = 0,
    filters = {},
    activeFilters,
    page = 1,
    dialog;
  root.replaceChildren(
    el(
      d,
      "div",
      { className: "page-head" },
      el(
        d,
        "div",
        {},
        el(d, "p", { className: "section-label" }, "OPPORTUNITIES"),
        el(d, "h1", {}, "岗位库"),
        el(d, "p", {}, "从事实与证据开始，找到值得进一步了解的机会。"),
      ),
      button(d, "导入链接 / 正文", () => {
        imports.hidden = !imports.hidden;
      }),
    ),
    status.node,
    filterRoot,
    list,
    pager,
  );
  const imports = el(
    d,
    "section",
    { hidden: true },
    jobImport({ document: d, api, onImported: () => load() }),
  );
  root.append(imports);
  async function load() {
    queryController?.abort();
    queryController = new AbortController();
    const id = ++requestId,
      targetId = store.getState().selectedTargetId;
    store.dispatch({ type: "jobs-request", requestId: id });
    try {
      const params = new URLSearchParams(
        Object.entries({ ...filters, page, pageSize: 30 }).filter(([, v]) => v),
      );
      const data = await api.request("/jobs?" + params, {
        signal: queryController.signal,
      });
      if (destroyed || id !== requestId) return;
      store.dispatch({ type: "jobs", targetId, requestId: id, data });
      list.replaceChildren(
        renderJobList({
          document: d,
          items: data.items,
          onOpen: async (jobId) => {
            try {
              const detail = await api.request(
                "/jobs/" + encodeURIComponent(jobId),
              );
              if (!destroyed) {
                dialog?.close();
                dialog = openJobDetail({ root, detail, api, onChanged: load });
              }
            } catch (e) {
              status.show(e.message, true);
            }
          },
        }),
      );
      pager.replaceChildren(
        button(
          d,
          "上一页",
          () => {
            page--;
            void load();
          },
          { disabled: page <= 1 },
        ),
        el(d, "span", {}, "第 " + page + " 页 · " + data.total + " 条"),
        button(
          d,
          "下一页",
          () => {
            page++;
            void load();
          },
          { disabled: page * 30 >= data.total },
        ),
      );
      status.show("");
    } catch (e) {
      if (!destroyed && id === requestId && e.name !== "AbortError") {
        if (e.fieldErrors) activeFilters?.showError(e);
        status.show("读取失败：" + e.message, true);
      }
    }
  }
  const ready = (async () => {
    try {
      const { targets } = await api.request("/targets");
      if (destroyed) return;
      const f = jobFilters({
        document: d,
        targets: latest(targets, "targetId"),
        onChange: (value) => {
          filters = value;
          const t = targets.find(
            (x) => x.revisionId === value.targetRevisionId,
          );
          store.dispatch({
            type: "target",
            id: t?.targetId || null,
            revisionId: t?.revisionId,
          });
          page = 1;
          void load();
        },
      });
      activeFilters = f;
      f.target.value = store.getState().targetRevisionId || "";
      filters = f.values();
      filterRoot.replaceChildren(f.node);
      await load();
    } catch (e) {
      if (!destroyed) status.show(e.message, true);
    }
  })();
  return {
    ready,
    destroy() {
      destroyed = true;
      queryController?.abort();
      dialog?.close();
      root.replaceChildren();
    },
  };
}
