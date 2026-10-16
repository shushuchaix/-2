import { bindValidation } from "./js/components/form-validation.js";

const form = document.getElementById("loginForm");
const input = document.getElementById("password");
const btn = document.getElementById("loginBtn");
const validation = bindValidation(form, {
  kind: "login",
  fields: { password: input },
  values: () => ({ password: input.value }),
});

function setBusy(busy) {
  btn.disabled = busy;
  input.disabled = busy;
  btn.querySelector(".btn-label").textContent = busy ? "验证中…" : "进入";
}

async function submit(e) {
  e.preventDefault();
  if (btn.disabled || !validation.check()) return;
  const password = input.value;

  setBusy(true);
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      input.disabled = false;
      validation.show({
        message: data.error || `登录失败（HTTP ${res.status}）`,
        fieldErrors:
          data.fieldErrors ||
          (res.status === 401
            ? { password: data.error || "访问密码不正确，请重新输入。" }
            : undefined),
      });
      return;
    }
    // 登录成功：跳转到原目标页或首页
    const next = new URLSearchParams(location.search).get("next");
    location.href =
      next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  } catch (err) {
    input.disabled = false;
    validation.show({
      message: `网络错误：${err.message}。密码已保留，可稍后重试。`,
    });
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", submit);

/* 若站点未启用鉴权，直接放行，避免用户卡在登录页 */
(async () => {
  try {
    const r = await fetch("/api/session");
    const s = await r.json();
    if (!s.authRequired || s.authenticated) location.href = "/";
  } catch {
    /* 忽略：仍显示登录框 */
  }
})();

input.focus();
