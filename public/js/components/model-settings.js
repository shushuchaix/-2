import { el, field, button } from "./dom.js";
import { feedback } from "./feedback.js";
import { temporaryCredentials } from "../credentials.js";
export function modelSettings({ document: d, settings, api, desktopBridge }) {
  const status = feedback(d),
    form = el(d, "form", { className: "card" }),
    model = settings.model || {},
    base = el(d, "input", {
      type: "url",
      value: model.baseUrl || "",
      required: true,
    }),
    name = el(d, "input", { value: model.model || "", required: true }),
    key = el(d, "input", {
      id: "userApiKey",
      type: "password",
      autocomplete: "off",
      placeholder: "不显示已保存密钥",
    }),
    max = el(d, "input", {
      type: "number",
      min: 0,
      max: 20,
      value: settings.budgets?.maxModelRequests ?? 20,
    });
  key.addEventListener("input", () => temporaryCredentials.set(key.value));
  form.append(
    el(d, "h2", {}, "模型与预算"),
    el(
      d,
      "p",
      { className: "muted" },
      model.configured
        ? "服务端已配置模型访问。"
        : "未配置模型访问，规则模式可正常使用。",
    ),
    field(d, "兼容 API endpoint", base),
    field(d, "模型名称", name),
    field(d, "每任务模型尝试上限（0–20，重试也计数）", max),
    el(
      d,
      "p",
      { className: "muted" },
      "每次输出最多4000 tokens。实际调用与 token 数在运行记录中显示；未配置价格时不估算费用。",
    ),
    el(d, "button", { type: "submit" }, "保存模型与预算设置"),
    field(
      d,
      "桌面密钥 / 本页临时输入",
      key,
      "输入仅在内存中；离开设置页即清除。Web 临时 Key 在开始更新时填写。",
    ),
    status.node,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const n = Number(max.value);
      if (!Number.isSafeInteger(n) || n < 0 || n > 20)
        throw Error("模型预算必须为0–20");
      await api.request("/settings", {
        method: "PUT",
        body: {
          model: { baseUrl: base.value, model: name.value },
          budgets: { maxModelRequests: n },
        },
      });
      status.show("模型与预算设置已保存");
    } catch (e) {
      status.show("保存失败：" + e.message, true);
    }
  });
  if (desktopBridge)
    form.append(
      button(d, "加密保存桌面 Key", async () => {
        try {
          if (!(await desktopBridge.isAvailable()))
            throw Error("系统加密不可用，不能保存密钥");
          await desktopBridge.saveKey("deepseek", key.value);
          key.value = "";
          temporaryCredentials.clear();
          status.show("桌面密钥已加密保存");
        } catch (e) {
          status.show(e.message, true);
        }
      }),
      button(d, "清除桌面 Key", async () => {
        try {
          await desktopBridge.deleteKey("deepseek");
          status.show("桌面密钥已清除");
        } catch (e) {
          status.show(e.message, true);
        }
      }),
    );
  return {
    node: form,
    destroy() {
      key.value = "";
      temporaryCredentials.clear();
    },
  };
}
