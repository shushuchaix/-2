import { el, button, field } from "./dom.js";
import { feedback } from "./feedback.js";
import { versionLabel, operationError } from "../version-management.js";
export function versionList(
  document,
  {
    versions = [],
    kind,
    onSelect,
    onRename,
    onToggle,
    onArchive,
    onRestore,
    onPermanentDelete,
    onRescore,
    canRescore = () => true,
  },
) {
  const d = document,
    node = el(d, "section", { className: "stack version-list" }),
    rows = el(d, "div", { className: "stack" }),
    status = feedback(d);
  const filter = el(
    d,
    "select",
    { "aria-label": kind === "profile" ? "画像版本状态" : "目标版本状态" },
    [
      ["all", "所有版本"],
      ["active", "可用版本"],
      ["disabled", "已停用"],
      ["trash", "回收站"],
    ].map(([v, t]) => el(d, "option", { value: v }, t)),
  );
  node.append(
    el(d, "h3", {}, kind === "profile" ? "简历画像版本" : "求职目标版本"),
    field(d, "版本状态", filter),
    status.node,
    rows,
  );
  filter.addEventListener("change", render);
  function render() {
    rows.replaceChildren();
    const groups = new Map();
    for (const v of versions) {
      if (
        (filter.value === "active" && (v.archivedAt || v.enabled === false)) ||
        (filter.value === "disabled" &&
          (v.archivedAt || v.enabled !== false)) ||
        (filter.value === "trash" && !v.archivedAt)
      )
        continue;
      const id = v[kind + "Id"];
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(v);
    }
    if (!groups.size)
      rows.append(el(d, "p", { className: "muted" }, "没有符合条件的版本。"));
    for (const [id, items] of groups) {
      const group = el(
        d,
        "section",
        { className: "version-group", "data-version-group": id },
        el(d, "p", { className: "muted" }, "版本组 · " + id),
      );
      for (const v of items) {
        const name = el(d, "input", {
          value: v.versionName || "",
          "data-version-name": "",
          "aria-label": "版本名称",
          maxLength: 60,
        });
        const row = el(
          d,
          "div",
          { className: "version-row stack", "data-revision-id": v.revisionId },
          el(d, "strong", {}, versionLabel(v)),
          el(
            d,
            "p",
            { className: "muted" },
            Object.entries(v.references || {})
              .filter(([, n]) => n)
              .map(([k, n]) => k + "：" + n)
              .join("，"),
          ),
        );
        const actions = el(d, "div", { className: "row" });
        let busy = false;
        function action(label, fn, disabled = false) {
          const b = button(
            d,
            label,
            async () => {
              if (busy || b.disabled) return;
              busy = true;
              for (const x of row.querySelectorAll("button,input"))
                x.disabled = true;
              try {
                await fn(v);
              } catch (e) {
                status.show(operationError(e), true, { notify: true });
              } finally {
                busy = false;
                for (const x of row.querySelectorAll("button,input"))
                  x.disabled = false;
                b.disabled = disabled;
              }
            },
            { disabled },
          );
          actions.append(b);
        }
        if (onSelect) action("新建版本", onSelect, !!v.archivedAt);
        if (!v.archivedAt) {
          row.append(field(d, "版本名称", name, "修改名称不会创建新版本。"));
          action("重命名", (v) => onRename(v, name.value));
          if (onToggle) action(v.enabled === false ? "启用" : "停用", onToggle);
          action("移入回收站", onArchive);
          if (onRescore)
            action("对该版本岗位重新评分", onRescore, !canRescore(v));
        } else {
          action("恢复", onRestore);
          let confirmed = false;
          const confirm = button(d, "永久删除", async () => {
            if (busy) return;
            if (!confirmed) {
              confirmed = true;
              confirm.textContent = "确认永久删除";
              status.show("此操作不可撤销。仍有引用的版本将拒绝删除。");
              return;
            }
            busy = true;
            confirm.disabled = true;
            try {
              await onPermanentDelete(v);
            } catch (e) {
              status.show(operationError(e), true, { notify: true });
            } finally {
              busy = false;
              confirmed = false;
              confirm.textContent = "永久删除";
              confirm.disabled = false;
            }
          });
          actions.append(confirm);
        }
        row.append(actions);
        group.append(row);
      }
      rows.append(group);
    }
  }
  render();
  return {
    node,
    update(next) {
      versions = next;
      render();
    },
  };
}
