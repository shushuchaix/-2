import { el, button } from "./dom.js";
import { formatDate } from "../format.js";
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
      checkbox = el(d, "input", {
        type: "checkbox",
        checked: source.config?.enabled !== false,
      });
    checkbox.addEventListener("change", async () => {
      try {
        await api.request("/sources/" + source.sourceId + "/settings", {
          method: "PUT",
          body: { config: { ...source.config, enabled: checkbox.checked } },
        });
        status.show("来源设置已保存");
      } catch (e) {
        checkbox.checked = !checkbox.checked;
        status.show("保存失败：" + e.message, true);
      }
    });
    const section = el(
      d,
      "details",
      { className: "source-row" },
      el(
        d,
        "summary",
        {},
        source.name +
          " · " +
          sourceSites.filter((s) => s.status === "ready").length +
          " 可用 / " +
          sourceSites.length +
          " 目录站点",
      ),
      el(d, "label", { className: "inline-check" }, checkbox, "启用此来源"),
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
      const health =
          site.health || source.health?.find((h) => h.siteId === site.siteId),
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
