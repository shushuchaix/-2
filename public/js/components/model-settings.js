import { el, field, button } from "./dom.js";
import { feedback } from "./feedback.js";
import { temporaryCredentials } from "../credentials.js";
import { bindValidation } from "./form-validation.js";
import { isVerifiedCostModel } from "../validation-rules.js";
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
      value: Math.min(20, settings.budgets?.maxModelRequests ?? 20),
    }),
    cost = el(d, "input", {
      type: "number",
      min: 0,
      max: 10,
      step: "0.01",
      value:
        settings.budgets?.maxCostCny ?? (isVerifiedCostModel(model) ? 10 : ""),
    });
  key.addEventListener("input", () => temporaryCredentials.set(key.value));
  const keyRoot = el(d, "div", { className: "stack" });
  const maxField = field(
    d,
    "每任务模型尝试上限（0–20，重试也计数）",
    max,
    "请求次数模式填写整数 0–20；0 表示不发起模型调用。",
  );
  const moneyMode = () => cost.value !== "";
  let savedMoney = settings.budgets?.maxCostCny != null;
  const budgetValues = () => ({
    maxModelRequests: moneyMode() ? 1000 : max.value,
    ...(moneyMode()
      ? { maxCostCny: cost.value }
      : savedMoney
        ? { maxCostCny: null }
        : {}),
  });
  const updateBudgetMode = () => {
    maxField.hidden = moneyMode();
  };
  let costTouched = false;
  cost.addEventListener("input", () => {
    costTouched = true;
    updateBudgetMode();
  });
  for (const input of [base, name])
    input.addEventListener("input", () => {
      if (
        !costTouched &&
        !moneyMode() &&
        isVerifiedCostModel({
          baseUrl: base.value.trim(),
          model: name.value.trim(),
        })
      )
        cost.value = "10";
      updateBudgetMode();
    });
  updateBudgetMode();
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
    field(
      d,
      "兼容 API endpoint",
      base,
      "填写模型配置时必填；使用完整 http(s) 地址，本地模型地址也可使用。不要在地址中填写用户名或密码。",
    ),
    field(
      d,
      "模型名称",
      name,
      "填写模型配置时必填；按服务商提供的名称填写，最多 200 字符。",
    ),
    field(
      d,
      "每任务模型费用上限（元）",
      cost,
      "官方 deepseek-flash 可填写 0–10，最多两位小数；0 表示不发起模型调用。其他兼容模型留空，使用请求次数预算。",
    ),
    maxField,
    el(
      d,
      "p",
      { className: "muted" },
      "费用预算按官方 deepseek-flash 的最高输入单价 2 元、输出单价 8 元 / 百万 tokens 计算费用上界，包含正在进行和用量不确定的调用。费用模式不在 20 次调用时停止，另有 1000 次辅助上限。每次输出最多4000 tokens；未配置价格时不估算费用。",
    ),
    el(d, "button", { type: "submit" }, "保存模型与预算设置"),
    keyRoot,
    status.node,
  );
  keyRoot.append(
    field(
      d,
      "桌面密钥 / 本页临时输入",
      key,
      "可空，不修改已保存密钥；最多 512 字符，不含空白或换行，支持兼容服务商 Key。输入仅在内存中，离开设置页即清除；保存桌面 Key 时需填写完整密钥。",
    ),
  );
  const validation = bindValidation(form, {
    kind: "settings",
    fields: {
      "model.baseUrl": base,
      "model.model": name,
      "budgets.maxModelRequests": max,
      "budgets.maxCostCny": cost,
    },
    values: () => ({
      model: { baseUrl: base.value, model: name.value },
      budgets: budgetValues(),
    }),
  });
  const keyValidation = bindValidation(keyRoot, {
    kind: "key",
    fields: { userApiKey: key },
    values: () => ({ userApiKey: key.value }),
  });
  let busy = false;
  const setBusy = (value) => {
    busy = value;
    for (const control of form.querySelectorAll("button"))
      control.disabled = value;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || !validation.check()) return;
    setBusy(true);
    status.show("");
    try {
      const budgets = budgetValues();
      await api.request("/settings", {
        method: "PUT",
        body: {
          model: { baseUrl: base.value.trim(), model: name.value.trim() },
          budgets: Object.fromEntries(
            Object.entries(budgets).map(([key, value]) => [
              key,
              value === null ? null : Number(value),
            ]),
          ),
        },
      });
      savedMoney = budgets.maxCostCny != null;
      status.show("模型与预算设置已保存", false, { notify: true });
    } catch (e) {
      validation.show(e);
    } finally {
      setBusy(false);
    }
  });
  if (desktopBridge)
    keyRoot.append(
      button(d, "加密保存桌面 Key", async () => {
        if (busy) return;
        if (!key.value.trim()) {
          keyValidation.show({
            fieldErrors: { userApiKey: "请填写需要加密保存的完整 Key。" },
          });
          return;
        }
        if (!keyValidation.check()) return;
        setBusy(true);
        status.show("");
        try {
          if (!(await desktopBridge.isAvailable()))
            throw Error("系统加密不可用，不能保存密钥");
          await desktopBridge.saveKey("deepseek", key.value.trim());
          key.value = "";
          temporaryCredentials.clear();
          status.show("桌面密钥已加密保存", false, { notify: true });
        } catch (e) {
          keyValidation.show(e);
        } finally {
          setBusy(false);
        }
      }),
      button(d, "清除桌面 Key", async () => {
        if (busy) return;
        setBusy(true);
        status.show("");
        try {
          await desktopBridge.deleteKey("deepseek");
          status.show("桌面密钥已清除", false, { notify: true });
        } catch (e) {
          keyValidation.show(e);
        } finally {
          setBusy(false);
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
