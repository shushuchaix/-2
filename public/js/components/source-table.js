import { el, button } from "./dom.js";
import { formatDate } from "../format.js";
import { bindValidation } from "./form-validation.js";
const labels = {
  ready: "可自动采集",
  candidate: "目录候选，未验证正文",
  empty: "未取得有效样本",
  restricted: "受限，需要授权或手工导入",
  parse_error: "页面结构无法解析",
  unavailable: "暂时不可访问",
  skipped: "未配置或已跳过",
};
export function sourceTable({ document: d, sources, sites, api, status }) {
  const root = el(d, "div", { className: "source-list" });
  for (const source of sources) {
    const sourceSites = sites.filter((s) => s.providerId === source.sourceId),
      currentHealth = (site) =>
        site.health || source.health?.find((h) => h.siteId === site.siteId),
      summary = el(d, "summary"),
      checkbox = el(d, "input", {
        id: "sourceEnabled-" + source.sourceId,
        type: "checkbox",
        checked: source.config?.enabled !== false,
        "aria-describedby": "sourceHint-" + source.sourceId,
      });
    function updateSummary() {
      summary.textContent =
        source.name +
        " · " +
        sourceSites.filter(
          (site) => (currentHealth(site)?.status || site.status) === "ready",
        ).length +
        " 可用 / " +
        sourceSites.length +
        " 目录站点";
    }
    updateSummary();
    const configForm = el(d, "form"),
      save = el(d, "button", { type: "submit" }, "保存来源设置"),
      stateMessage = el(d, "p", {
        className: "feedback",
        "aria-live": "polite",
      });
    configForm.append(
      el(d, "label", { className: "inline-check" }, checkbox, "启用此来源"),
      el(
        d,
        "small",
        { id: "sourceHint-" + source.sourceId },
        "修改后自动保存；若失败，勾选会保留，可点击按钮重试。",
      ),
      save,
      stateMessage,
    );
    const validation = bindValidation(configForm, {
      kind: "sourceConfig",
      fields: { enabled: checkbox },
      values: () => ({ enabled: checkbox.checked }),
      options: () => ({ sourceId: source.sourceId }),
    });
    async function saveConfig() {
      if (save.disabled || !validation.check()) return;
      save.disabled = true;
      checkbox.disabled = true;
      stateMessage.textContent = "正在保存来源设置…";
      stateMessage.className = "feedback";
      try {
        const config = { ...source.config, enabled: checkbox.checked };
        await api.request("/sources/" + source.sourceId + "/settings", {
          method: "PUT",
          body: { config },
        });
        source.config = config;
        validation.clear();
        stateMessage.textContent = "来源设置已保存";
        status.show("来源设置已保存", false, { notify: true });
      } catch (e) {
        checkbox.disabled = false;
        validation.show(e);
        stateMessage.textContent = "来源设置未保存。勾选已保留，请重试。";
        stateMessage.className = "feedback error";
        status.show("来源设置未保存：" + e.message, true);
      } finally {
        save.disabled = false;
        checkbox.disabled = false;
      }
    }
    checkbox.addEventListener("change", saveConfig);
    configForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveConfig();
    });
    const section = el(
      d,
      "details",
      { className: "source-row" },
      summary,
      configForm,
      el(
        d,
        "small",
        {},
        "能力：" +
          Object.entries(source.capabilities || {})
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(" / "),
      ),
    );
    for (const site of sourceSites.length
      ? sourceSites
      : [{ siteId: null, name: source.name, status: "candidate" }]) {
      const health = currentHealth(site),
        info = el(d, "div", { className: "card stack" }),
        state = el(
          d,
          "span",
          { className: "badge" },
          labels[health?.status || site.status] || site.status,
        ),
        attempt = el(
          d,
          "small",
          {},
          "本次尝试：" + formatDate(health?.checkedAt),
        ),
        success = el(
          d,
          "small",
          {},
          "最近成功：" +
            formatDate(
              health?.lastSuccessAt ||
                (health?.status === "ready"
                  ? health.checkedAt
                  : site.verifiedAt),
            ),
        ),
        probe = button(
          d,
          "检查来源",
          async () => {
            probe.disabled = true;
            try {
              const result = await api.request(
                "/sources/" + source.sourceId + "/probe",
                { method: "POST", body: { siteId: site.siteId || undefined } },
              );
              site.health = result;
              updateSummary();
              state.textContent = labels[result.status] || result.status;
              attempt.textContent = "本次尝试：" + formatDate(result.checkedAt);
              if (result.status === "ready")
                success.textContent =
                  "最近成功：" + formatDate(result.checkedAt);
              status.show(
                (labels[result.status] || result.status) +
                  "。" +
                  (result.issues || [])
                    .map((i) => i.message || i.code)
                    .join("；"),
              );
            } catch (e) {
              status.show("检查失败：" + e.message, true);
            } finally {
              probe.disabled = false;
            }
          },
          { "data-probe": site.siteId || source.sourceId },
        );
      info.append(
        el(d, "strong", {}, site.name),
        state,
        el(
          d,
          "small",
          {},
          "目录：" +
            (site.category || "未分类") +
            " · " +
            (site.origin || source.sourceId),
        ),
        attempt,
        success,
        el(
          d,
          "small",
          {},
          "样本：" +
            (health?.sample?.title || health?.sampleCount || "未提供") +
            " · 截断：" +
            (health?.truncated ? "是" : "未报告"),
        ),
        el(
          d,
          "div",
          { className: "prose" },
          (health?.issues || [])
            .map((i) => i.code + ": " + (i.message || ""))
            .join("\n"),
        ),
        probe,
      );
      section.append(info);
    }
    root.append(section);
  }
  return root;
}
