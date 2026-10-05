import { el, field } from "../components/dom.js";
import { feedback } from "../components/feedback.js";
import { sourceTable } from "../components/source-table.js";
import { modelSettings } from "../components/model-settings.js";
import { backupPanel } from "../components/backup-panel.js";
import { jobImport } from "../components/job-import.js";
export function mountSettingsPage({ root, api, desktopBridge }) {
  const d = root.ownerDocument,
    status = feedback(d),
    sourcesRoot = el(d, "section", { className: "card" }),
    right = el(d, "div", { className: "stack" });
  let destroyed = false,
    model;
  root.replaceChildren(
    el(
      d,
      "div",
      { className: "page-head" },
      el(
        d,
        "div",
        {},
        el(d, "p", { className: "section-label" }, "SOURCES & PREFERENCES"),
        el(d, "h1", {}, "让来源与设置保持清晰"),
        el(d, "p", {}, "可采集来源、候选目录和手工线索分别标明。"),
      ),
    ),
    status.node,
    el(d, "div", { className: "grid" }, sourcesRoot, right),
  );
  const ready = (async () => {
    try {
      const [catalog, settings] = await Promise.all([
        api.request("/sources"),
        api.request("/settings"),
      ]);
      if (destroyed) return;
      const provider = el(
          d,
          "select",
          {},
          catalog.sources.map((s) =>
            el(d, "option", { value: s.sourceId }, s.name),
          ),
        ),
        siteId = el(d, "input", { required: true, placeholder: "my-school" }),
        name = el(d, "input", { required: true }),
        origin = el(d, "input", { type: "url", required: true }),
        evidence = el(d, "input", { type: "url", required: true }),
        custom = el(
          d,
          "form",
          { className: "card" },
          el(d, "h2", {}, "添加目录站点"),
          el(
            d,
            "p",
            { className: "muted" },
            "添加后先记为候选，只有取得有效详情样本才成为可用来源。",
          ),
          field(d, "来源适配器", provider),
          field(d, "站点 ID", siteId),
          field(d, "站点名称", name),
          field(d, "公开站点地址", origin),
          field(d, "归属证据链接", evidence),
          el(d, "button", { type: "submit" }, "保存候选站点"),
        );
      custom.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api.request("/sources/sites", {
            method: "POST",
            body: {
              siteId: siteId.value,
              name: name.value,
              providerId: provider.value,
              origin: origin.value,
              evidenceUrl: evidence.value,
              category: "custom",
            },
          });
          status.show("候选站点已保存，重新打开设置页检查。");
        } catch (e) {
          status.show("保存失败：" + e.message, true);
        }
      });
      sourcesRoot.replaceChildren(
        el(d, "h2", {}, "招聘来源"),
        el(
          d,
          "p",
          { className: "muted" },
          catalog.sources.length +
            " 个适配器 · " +
            catalog.sites.length +
            " 个目录站点。有效样本检查与目录数量独立。",
        ),
        sourceTable({ document: d, ...catalog, api, status }),
      );
      model = modelSettings({ document: d, settings, api, desktopBridge });
      right.replaceChildren(
        model.node,
        custom,
        jobImport({ document: d, api }),
        backupPanel({ document: d, api }),
        el(
          d,
          "p",
          { className: "muted" },
          "共享部署使用同一个工作区，登录者可看到同一份求职记录。个人使用建议在本机运行。",
        ),
      );
    } catch (e) {
      if (!destroyed) status.show(e.message, true);
    }
  })();
  return {
    ready,
    destroy() {
      destroyed = true;
      model?.destroy();
      root.replaceChildren();
    },
  };
}
