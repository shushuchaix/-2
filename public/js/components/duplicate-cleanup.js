import { el, button } from "./dom.js";
import { feedback } from "./feedback.js";
import { operationError } from "../version-management.js";
const reasons = (values) =>
  values
    .map(
      (v) =>
        ({
          authority_id: "可信来源岗位编号相同",
          specific_job_url: "同一岗位详情链接",
          identical_manual_input: "完整手动导入内容一致",
          identical_complete_content: "完整岗位内容与关键资格一致",
          similar_company_title: "同单位的岗位标题相似",
          insufficient_identity_evidence: "身份证据不足，需人工核对",
          multiple_manual_applications: "存在多个独立人工投递记录",
        })[v] || v,
    )
    .join("；");
export function duplicateCleanup(document, { api, onApplied, notify }) {
  const d = document,
    node = el(d, "section", { className: "card stack duplicate-cleanup" }),
    status = feedback(d),
    body = el(d, "div", { className: "stack" }),
    result = el(d, "p", { className: "cleanup-result", "aria-live": "polite" });
  let plan,
    busy = false,
    stale = false,
    disposed = false,
    generation = 0;
  node.hidden = true;
  const confirm = button(d, "确认清理所选重复岗位", apply, {
    className: "primary",
    disabled: true,
  });
  const refresh = button(d, "重新预览", () => void open());
  node.append(
    el(d, "h2", {}, "清理所有版本重复岗位"),
    el(
      d,
      "p",
      {},
      "范围包括正常、停用、历史、回收站版本和未归属记录。清理前自动生成完整业务备份，可在设置中整体恢复；恢复会回退备份后的其他业务改动。",
    ),
    status.node,
    body,
    el(
      d,
      "div",
      { className: "row" },
      refresh,
      confirm,
      button(d, "关闭预览", () => {
        node.hidden = true;
      }),
    ),
    result,
  );
  function report(text, error = false) {
    status.show(text, error, { notify: true });
    notify?.(text, error);
  }
  async function open() {
    if (busy || disposed) return;
    node.hidden = false;
    busy = true;
    confirm.disabled = true;
    refresh.disabled = true;
    const seq = ++generation;
    try {
      const preview = await api.request("/jobs/duplicates/preview", {
        method: "POST",
        body: {},
      });
      const ids = [
        ...new Set(
          preview.groups.flatMap((g) => [g.keepJobId, ...g.removeJobIds]),
        ),
      ];
      const details = await Promise.all(
        ids.map(async (id) => {
          try {
            const x = await api.request("/jobs/" + encodeURIComponent(id));
            return [id, x.job.canonical];
          } catch {
            return [id, {}];
          }
        }),
      );
      if (disposed || seq !== generation) return;
      plan = preview;
      stale = false;
      body.replaceChildren();
      result.textContent = "";
      const map = new Map(details);
      const label = (id) => {
        const r = map.get(id) || {};
        return (
          (r.title || "岗位") +
          " · " +
          (r.company || "单位未提供") +
          " · " +
          (r.cities || []).join("/") +
          " · " +
          id
        );
      };
      for (const g of plan.groups) {
        const checkbox = el(d, "input", {
          type: "checkbox",
          value: g.groupId,
          "data-cleanup-group": "",
          checked: !g.protected,
          disabled: !!g.protected,
        });
        body.append(
          el(
            d,
            "article",
            { className: "card" },
            el(
              d,
              "label",
              {},
              checkbox,
              g.protected
                ? "人工记录待处理 · 禁止自动删除"
                : "确定重复 · 可清理",
            ),
            el(d, "p", {}, "保留：" + label(g.keepJobId)),
            el(d, "p", {}, "归并删除：" + g.removeJobIds.map(label).join("；")),
            el(
              d,
              "p",
              {},
              "依据：" + reasons(g.reasons || g.reasonCodes || []),
            ),
            el(
              d,
              "p",
              {},
              "涉及版本：" + (g.targetRevisionIds || []).join("、"),
            ),
            g.protected
              ? el(
                  d,
                  "p",
                  { className: "notice-banner" },
                  "保护原因：" +
                    reasons([g.protectedReason || "存在独立人工记录"]),
                )
              : null,
          ),
        );
      }
      body.append(
        el(
          d,
          "h3",
          {},
          "疑似重复 · " + (plan.possiblePairs || []).length + " 组（仅供核对）",
        ),
        ...(plan.possiblePairs || []).map((p) =>
          el(
            d,
            "p",
            {},
            (p.jobIds || []).join(" / ") +
              " · " +
              reasons(p.reasons || p.reasonCodes || []),
          ),
        ),
      );
      if (!plan.groups.length)
        body.append(el(d, "p", {}, "没有可确认清理的重复岗位。"));
      status.show("预览已生成；请核对保留项和删除项后确认。", false, {
        notify: true,
      });
    } catch (e) {
      report("预览失败：" + operationError(e), true);
    } finally {
      busy = false;
      refresh.disabled = false;
      confirm.disabled = stale || !plan;
    }
  }
  async function apply() {
    if (busy || stale || !plan || disposed) return;
    const selected = [...body.querySelectorAll("input[data-cleanup-group]")]
      .filter((x) => x.checked && !x.disabled)
      .map((x) => x.value);
    if (!selected.length) {
      report("请选择至少一个确定重复组。", true);
      return;
    }
    busy = true;
    confirm.disabled = true;
    refresh.disabled = true;
    for (const x of body.querySelectorAll("input")) x.disabled = true;
    try {
      const saved = await api.request("/jobs/duplicates/apply", {
        method: "POST",
        body: {
          workspaceRevision: plan.workspaceRevision,
          planHash: plan.planHash,
          selectedGroupIds: selected,
        },
      });
      if (disposed) return;
      const counts = saved.counts;
      const text =
        "已清理重复实体 " +
        counts.removedEntities +
        " 条，版本内归并 " +
        counts.collapsedVersionEntries +
        " 条，涉及版本 " +
        counts.affectedVersions +
        " 个；备份 " +
        (saved.backupId || "无需备份") +
        "。";
      result.replaceChildren(
        d.createTextNode(text),
        el(d, "a", { href: "#/settings" }, "在设置中查看备份与恢复"),
      );
      report(text);
      stale = true;
      await onApplied?.(saved);
    } catch (e) {
      if (disposed) return;
      if (e.code === "duplicate_plan_stale") stale = true;
      report(
        "清理失败：" +
          operationError(e) +
          (stale ? "。请重新预览后确认。" : ""),
        true,
      );
    } finally {
      busy = false;
      refresh.disabled = false;
      confirm.disabled = stale;
      for (const x of body.querySelectorAll("input"))
        x.disabled = !!plan.groups.find((g) => g.groupId === x.value)
          ?.protected;
    }
  }
  return {
    node,
    open,
    dispose() {
      disposed = true;
      generation++;
      node.remove();
    },
  };
}
