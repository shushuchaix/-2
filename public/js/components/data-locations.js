import { el, button } from "./dom.js";
import { feedback } from "./feedback.js";
import { operationError } from "../version-management.js";
const labels = {
  data: "工作区数据",
  history: "当前更新历史",
  backups: "完整业务备份",
  cache: "可重建缓存",
  logs: "诊断日志",
};
export function dataLocations(document, { bridge, notify } = {}) {
  const d = document,
    node = el(d, "section", { className: "card stack data-locations" }),
    status = feedback(d);
  node.append(el(d, "h2", {}, "本地数据与保存位置"));
  if (!bridge?.getDataLocations) {
    node.append(
      el(
        d,
        "p",
        {},
        "Web 浏览器使用服务端工作区。导出和备份通过浏览器下载，保存位置由浏览器决定。",
      ),
    );
    return node;
  }
  node.append(
    el(
      d,
      "p",
      {},
      "岗位、简历、目标与投递记录保存在工作区数据中的 workspace.v2.json；配置为 config.json，加密凭据为 credentials.v2.json。当前历史为 runs-v2；runs 为旧版兼容历史。",
    ),
    status.node,
  );
  void (async () => {
    try {
      const locations = await bridge.getDataLocations();
      for (const [kind, label] of Object.entries(labels)) {
        const row = el(
          d,
          "div",
          { className: "stack" },
          el(d, "strong", {}, label),
          el(d, "code", {}, locations[kind]),
        );
        let busy = false;
        for (const [operation, text] of [
          ["open", "打开"],
          ["copy", "复制路径"],
        ])
          row.append(
            button(
              d,
              text,
              async () => {
                if (busy) return;
                busy = true;
                for (const b of row.querySelectorAll("button"))
                  b.disabled = true;
                try {
                  await bridge[
                    operation === "open"
                      ? "openDataLocation"
                      : "copyDataLocation"
                  ](kind);
                  const result =
                    (operation === "open" ? "已打开" : "路径已复制") +
                    "：" +
                    label;
                  status.show(result, false, { notify: true });
                  notify?.(result);
                } catch (e) {
                  const text = operationError(e);
                  status.show(text, true, { notify: true });
                  notify?.(text, true);
                } finally {
                  busy = false;
                  for (const b of row.querySelectorAll("button"))
                    b.disabled = false;
                }
              },
              { ["data-" + operation + "-location"]: kind },
            ),
          );
        node.append(row);
      }
    } catch (e) {
      status.show("读取保存位置失败：" + operationError(e), true, {
        notify: true,
      });
    }
  })();
  return node;
}
