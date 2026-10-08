import { dataLocations } from "../components/data-locations.js";
import { el, field } from "../components/dom.js";
import { feedback } from "../components/feedback.js";
import { sourceTable } from "../components/source-table.js";
import { modelSettings } from "../components/model-settings.js";
import { backupPanel } from "../components/backup-panel.js";
import { jobImport } from "../components/job-import.js";
import { bindValidation } from "../components/form-validation.js";
import { diagnosticsPanel } from "../components/diagnostics-panel.js";
export function mountSettingsPage({ root, api, desktopBridge }) {
  const d = root.ownerDocument,
    status = feedback(d),
    sourcesRoot = el(d, "section", { className: "card" }),
    right = el(d, "div", { className: "stack" }),
    diagnostics = diagnosticsPanel({ document: d, api });
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
    diagnostics.node,
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
          field(
            d,
            "来源适配器",
            provider,
            "必选；选择能解析此站点的招聘来源适配器。",
          ),
          field(
            d,
            "站点 ID",
            siteId,
            "必填且不能重复；字母、数字、下划线或短横线，最多 160 字符。",
          ),
          field(d, "站点名称", name, "必填；清晰的站点名称，最多 200 字符。"),
          field(
            d,
            "公开站点地址",
            origin,
            "必填；公开 http(s) 地址，不含用户名或密码，不能指向本机或内网。",
          ),
          field(
            d,
            "归属证据链接",
            evidence,
            "必填；可证明站点归属的公开 http(s) 链接。",
          ),
          el(d, "button", { type: "submit" }, "保存候选站点"),
        );
      const values = () => ({
        siteId: siteId.value.trim(),
        name: name.value.trim(),
        providerId: provider.value,
        origin: origin.value.trim(),
        evidenceUrl: evidence.value.trim(),
        category: "custom",
      });
      const validation = bindValidation(custom, {
        kind: "site",
        fields: {
          providerId: provider,
          siteId,
          name,
          origin,
          evidenceUrl: evidence,
        },
        values,
        options: () => ({
          sourceIds: catalog.sources.map((s) => s.sourceId),
          siteIds: catalog.sites.map((s) => s.siteId),
        }),
      });
      let saving = false;
      custom.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (saving || !validation.check()) return;
        saving = true;
        const save = custom.querySelector("button");
        const site = values();
        save.disabled = true;
        status.show("");
        try {
          await api.request("/sources/sites", {
            method: "POST",
            body: site,
          });
          catalog.sites.push(site);
          status.show("候选站点已保存，重新打开设置页检查。", false, {
            notify: true,
          });
        } catch (e) {
          validation.show(e);
        } finally {
          saving = false;
          save.disabled = false;
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
        dataLocations(d, { bridge: desktopBridge }),
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
      diagnostics.destroy();
      root.replaceChildren();
    },
  };
}
