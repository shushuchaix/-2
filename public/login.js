/* 登录页逻辑 */
'use strict';

const form = document.getElementById('loginForm');
const input = document.getElementById('password');
const btn = document.getElementById('loginBtn');
const errBox = document.getElementById('loginError');

function showError(msg) {
  errBox.textContent = msg;
  errBox.classList.remove('hidden');
}

function clearError() {
  errBox.textContent = '';
  errBox.classList.add('hidden');
}

function setBusy(busy) {
  btn.disabled = busy;
  btn.querySelector('.btn-label').textContent = busy ? '验证中…' : '进入';
}

async function submit(e) {
  e.preventDefault();
  const password = input.value;
  if (!password) return;

  clearError();
  setBusy(true);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || `登录失败（HTTP ${res.status}）`);
      input.select();
      return;
    }
    // 登录成功：跳转到原目标页或首页
    const next = new URLSearchParams(location.search).get('next');
    location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  } catch (err) {
    showError(`网络错误：${err.message}`);
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', submit);

/* 若站点未启用鉴权，直接放行，避免用户卡在登录页 */
(async () => {
  try {
    const r = await fetch('/api/session');
    const s = await r.json();
    if (!s.authRequired || s.authenticated) location.href = '/';
  } catch {
    /* 忽略：仍显示登录框 */
  }
})();

input.focus();
