/* 简历岗位雷达 · 前端逻辑 */
'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  statusChips: $('statusChips'),
  quotaText: $('quotaText'),
  logoutBtn: $('logoutBtn'),
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  resumeText: $('resumeText'),
  resumeMeta: $('resumeMeta'),
  clearResume: $('clearResume'),
  useLlm: $('useLlm'),
  citiesInput: $('citiesInput'),
  keywordsInput: $('keywordsInput'),
  yearSelect: $('yearSelect'),
  includeInternship: $('includeInternship'),
  yearHint: $('yearHint'),
  byokBox: $('byokBox'),
  userApiKey: $('userApiKey'),
  setupHint: $('setupHint'),
  runBtn: $('runBtn'),
  runNote: $('runNote'),
  stageLabel: $('stageLabel'),
  stageTimer: $('stageTimer'),
  barFill: $('barFill'),
  queueBanner: $('queueBanner'),
  log: $('log'),
  profileCard: $('profileCard'),
  emptyState: $('emptyState'),
  resultArea: $('resultArea'),
  resultStats: $('resultStats'),
  jobList: $('jobList'),
  sortSelect: $('sortSelect'),
  sourceFilter: $('sourceFilter'),
  verdictFilter: $('verdictFilter'),
  exportCsv: $('exportCsv'),
  exportMd: $('exportMd'),
  historyBtn: $('historyBtn'),
  historyDrawer: $('historyDrawer'),
  historyList: $('historyList'),
  closeHistory: $('closeHistory'),
  drawerMask: $('drawerMask'),
  toast: $('toast'),
};

const state = {
  result: null,
  runId: null,
  running: false,
  startedAt: 0,
  timer: null,
  health: null,
  session: null,
};

const BYOK_STORAGE = 'rjr_user_api_key';

/**
 * 自带 Key 的存放位置。
 * 桌面版用 localStorage（关掉应用再打开仍在，否则每次都要重填）；
 * 网页版用 sessionStorage（关掉标签页即清除，避免公用电脑上残留）。
 */
function saveUserKey(v) {
  try {
    const s = state.session?.desktop ? localStorage : sessionStorage;
    if (v) s.setItem(BYOK_STORAGE, v);
    else s.removeItem(BYOK_STORAGE);
  } catch {
    /* 隐私模式等场景下写入会抛错，忽略即可 */
  }
}

function loadUserKey() {
  try {
    return localStorage.getItem(BYOK_STORAGE) || sessionStorage.getItem(BYOK_STORAGE) || '';
  } catch {
    return '';
  }
}

/* ================= 带鉴权处理的请求封装 ================= */
/** 任何接口返回 401 都说明会话失效，统一跳登录页，避免各处重复处理 */
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401 && !String(url).startsWith('/api/login')) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?next=${next}`;
    throw new Error('登录已过期');
  }
  return res;
}

/* ================= 工具 ================= */
function toast(msg, kind = '') {
  el.toast.textContent = msg;
  el.toast.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), 3600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addLog(message, kind = '') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const div = document.createElement('div');
  div.className = `log-line ${kind}`;
  div.innerHTML = `<span class="t">${t}</span><span class="m">${esc(message)}</span>`;
  el.log.appendChild(div);
  el.log.scrollTop = el.log.scrollHeight;
  while (el.log.childElementCount > 300) el.log.removeChild(el.log.firstChild);
}

const STAGE_PROGRESS = { analyze: 12, plan: 20, collect: 55, prescore: 64, enrich: 80, score: 96, finalize: 100 };

function setStage(label, stage) {
  el.stageLabel.textContent = label;
  if (stage && STAGE_PROGRESS[stage] !== undefined) {
    el.barFill.style.width = `${STAGE_PROGRESS[stage]}%`;
  }
}

function startTimer() {
  state.startedAt = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const s = ((Date.now() - state.startedAt) / 1000).toFixed(1);
    el.stageTimer.textContent = `已用时 ${s}s`;
  }, 100);
}
function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
}

/* ================= 届别过滤提示 ================= */
function updateYearHint() {
  const y = el.yearSelect.value;
  const intern = el.includeInternship.checked;
  if (!y) {
    el.yearHint.textContent = '未限定届别：社招与往届岗位也会出现在结果中。';
    return;
  }
  el.yearHint.textContent = `只保留面向 ${y} 届的校招岗位，自动剔除社招、往届与届别不明的岗位${intern ? '，并保留实习岗' : '（实习岗已排除）'}。`;
}

/* ================= 启动时读取配置状态 ================= */
function renderQuota(quota) {
  if (!quota) {
    el.quotaText.textContent = '';
    return;
  }
  const parts = [];
  if (quota.remainingIp !== undefined) parts.push(`今日剩余 ${quota.remainingIp} 次`);
  if (quota.dailyGlobal !== undefined && quota.dailyGlobal < 1000) {
    parts.push(`全站余 ${quota.remainingGlobal}`);
  }
  el.quotaText.textContent = parts.join(' · ');
}

async function loadHealth() {
  // 先确认会话状态，未登录直接跳转
  try {
    const sr = await apiFetch('/api/session');
    const s = await sr.json();
    state.session = s;
    if (s.authRequired && !s.authenticated) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login?next=${next}`;
      return;
    }
    if (s.authRequired) el.logoutBtn.classList.remove('hidden');
    if (!s.allowUserKey) el.byokBox.classList.add('hidden');
    renderQuota(s.quota);

    // 桌面版首次运行：没有内置密钥时，引导用户填自己的 Key
    if (s.desktop && !s.deepseekConfigured && !loadUserKey()) {
      el.byokBox.open = true;
      el.setupHint.innerHTML =
        '👋 <b>首次使用</b>：请先填入你的 DeepSeek API Key（' +
        '<a href="https://platform.deepseek.com/" target="_blank" rel="noopener">点此申请</a>）。' +
        '不填也能跑，但会退化成离线规则模式，岗位匹配质量明显下降。';
      el.setupHint.classList.remove('hidden');
      el.runNote.textContent = '填入 API Key 后即可开始检索';
    }
  } catch (e) {
    if (String(e.message).includes('过期')) return;
  }

  try {
    const r = await apiFetch('/api/health');
    const h = await r.json();
    state.health = h;
    const chips = [];
    if (h.deepseek?.configured) {
      chips.push(`<span class="chip ok">DeepSeek 已配置 · <b>${esc(h.deepseek.model)}</b></span>`);
    } else {
      chips.push(`<span class="chip bad">DeepSeek 未配置 · 离线规则模式</span>`);
    }
    if (h.search?.provider) {
      chips.push(`<span class="chip ok">全网搜索 · <b>${esc(h.search.provider)}</b></span>`);
    } else {
      chips.push(`<span class="chip warn">未接搜索 API · 仅智联/实习僧</span>`);
    }
    const srcCount = Object.values(h.sources || {}).filter((s) => s.enabled).length;
    chips.push(`<span class="chip">岗位源 <b>${srcCount}</b> 个</span>`);
    el.statusChips.innerHTML = chips.join('');

    // 届别过滤的默认值来自服务端配置，用户可在界面上临时改
    if (h.filters?.graduationYear) {
      const v = String(h.filters.graduationYear).replace(/届$/, '');
      if ([...el.yearSelect.options].some((o) => o.value === v)) el.yearSelect.value = v;
    }
    if (h.filters && h.filters.includeInternship === false) el.includeInternship.checked = false;
    updateYearHint();
    renderQuota(h.quota);

    if (!h.deepseek?.configured) {
      el.useLlm.checked = false;
      el.useLlm.disabled = true;
      el.runNote.textContent = '本站未配置 DeepSeek Key：可在上方填入你自己的 Key，否则以离线规则模式运行';
    }
  } catch (e) {
    el.statusChips.innerHTML = `<span class="chip bad">无法连接后端服务</span>`;
  }
}

/* ================= 简历文件上传 ================= */
async function handleFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    toast('文件超过 20MB 上限', 'err');
    return;
  }
  el.dropzone.classList.add('busy');
  el.dropzone.querySelector('p strong').textContent = '正在解析…';
  try {
    const base64 = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
    const res = await apiFetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, base64 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    el.resumeText.value = data.text;
    el.resumeMeta.textContent = `${file.name} · ${data.format.toUpperCase()} · ${data.length} 字`;
    toast(`已解析 ${file.name}（${data.length} 字）`, 'ok');
    if (!data.looksLikeResume) {
      addLog('提示：提取到的文字不太像简历，请检查内容是否正确', 'err');
    }
  } catch (e) {
    toast(e.message, 'err');
    addLog(`文件解析失败：${e.message}`, 'err');
  } finally {
    el.dropzone.classList.remove('busy');
    el.dropzone.querySelector('p strong').textContent = '点击选择';
    el.fileInput.value = '';
  }
}

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => handleFile(e.target.files?.[0]));

['dragenter', 'dragover'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag');
  }),
);
el.dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

el.clearResume.addEventListener('click', () => {
  el.resumeText.value = '';
  el.resumeMeta.textContent = '支持粘贴文本，或上传 PDF / DOCX / TXT';
});

/* ================= 主流程 ================= */
function parseList(v) {
  return String(v || '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function run() {
  if (state.running) return;
  const resumeText = el.resumeText.value.trim();
  if (resumeText.length < 30) {
    toast('请先粘贴简历内容或上传简历文件（至少 30 字）', 'err');
    return;
  }

  state.running = true;
  state.result = null;
  state.runId = null;
  el.runBtn.disabled = true;
  el.runBtn.querySelector('.btn-label').textContent = '检索中…';
  el.log.innerHTML = '';
  el.profileCard.classList.add('hidden');
  el.emptyState.classList.add('hidden');
  el.resultArea.classList.add('hidden');
  el.barFill.style.width = '2%';
  setStage('正在启动…');
  startTimer();

  const options = { useLlm: el.useLlm.checked };
  const cities = parseList(el.citiesInput.value);
  const keywords = parseList(el.keywordsInput.value);
  // 填「全国」/「不限」= 显式关闭城市限制；留空则沿用服务端配置
  if (cities.some((c) => /全国|不限/.test(c))) options.cities = [];
  else if (cities.length) options.cities = cities;
  if (keywords.length) options.titleKeywords = keywords;
  // 届别过滤：空字符串表示不过滤
  if (el.yearSelect.value) options.graduationYear = el.yearSelect.value;
  options.includeInternship = el.includeInternship.checked;

  // 访客自带 Key：只放在请求体里，浏览器本地留存，服务端不落盘
  const userApiKey = el.userApiKey.value.trim();
  saveUserKey(userApiKey);

  el.queueBanner.classList.add('hidden');

  try {
    const res = await apiFetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText, options, userApiKey: userApiKey || undefined }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const retry = data.retryAfterMs ? `（约 ${Math.ceil(data.retryAfterMs / 60000)} 分钟后可再试）` : '';
      throw new Error((data.error || `HTTP ${res.status}`) + retry);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        handleEvent(ev);
      }
    }
    if (buffer.trim()) {
      try {
        handleEvent(JSON.parse(buffer));
      } catch { /* ignore */ }
    }
  } catch (e) {
    addLog(`运行失败：${e.message}`, 'err');
    toast(e.message, 'err');
    setStage('运行失败');
  } finally {
    state.running = false;
    stopTimer();
    el.runBtn.disabled = false;
    el.runBtn.querySelector('.btn-label').textContent = '开始全网检索';
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'stage':
      setStage(ev.label, ev.stage);
      addLog(`▸ ${ev.label}`);
      break;
    case 'log':
      addLog(ev.message, /失败|错误|告警/.test(ev.message) ? 'err' : '');
      break;
    case 'profile':
      renderProfile(ev.profile);
      break;
    case 'queries':
      addLog(`站点检索词：${ev.titleKeywords.join('、')}`);
      break;
    case 'jobsFound':
      el.stageTimer.textContent = `已收集 ${ev.count} 条`;
      break;
    case 'queued': {
      const pos = Number(ev.position) || 0;
      if (pos > 0) {
        el.queueBanner.textContent = `⏳ 前面还有 ${pos} 个任务在排队，排到后会自动开始`;
        el.queueBanner.classList.remove('hidden');
      } else {
        el.queueBanner.classList.add('hidden');
      }
      break;
    }
    case 'quota':
      renderQuota(ev.quota);
      break;
    case 'result':
      state.result = ev.result;
      state.runId = ev.result.runId;
      renderResult(ev.result);
      break;
    case 'saved':
      state.runId = ev.runId;
      addLog(`结果已保存：${ev.file}`, 'ok');
      break;
    case 'error':
      addLog(`错误：${ev.message}`, 'err');
      break;
    case 'done':
      el.barFill.style.width = '100%';
      el.queueBanner.classList.add('hidden');
      stopTimer();
      addLog('完成', 'ok');
      break;
    case 'ping':
      break;
    default:
      break;
  }
}

/* ================= 渲染画像 ================= */
function renderProfile(p) {
  if (!p) return;
  const skills = (p.skills || []).map((s) => s.name).filter(Boolean);
  const items = [
    ['学历', p.degree],
    ['学校', p.school],
    ['专业', p.major],
    ['毕业年份', p.graduationYear],
    ['求职类型', (p.jobTypes || []).join('、')],
  ].filter(([, v]) => v);

  el.profileCard.innerHTML = `
    <h3>🧭 求职画像${p.__offline ? ' <span class="tag">离线规则提取</span>' : ''}</h3>
    ${p.summary ? `<p style="font-size:12.5px;color:var(--text-2);margin-bottom:9px">${esc(p.summary)}</p>` : ''}
    <div class="pc-grid">
      ${items.map(([k, v]) => `<div class="pc-item"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
    </div>
    ${p.targetRoles?.length ? `<div class="pc-tags"><span class="label">目标岗位</span>${p.targetRoles.map((r) => `<span class="tag hit">${esc(r)}</span>`).join('')}</div>` : ''}
    ${p.preferredCities?.length ? `<div class="pc-tags"><span class="label">期望城市</span>${p.preferredCities.map((c) => `<span class="tag city">${esc(c)}</span>`).join('')}</div>` : ''}
    ${skills.length ? `<div class="pc-tags"><span class="label">技能</span>${skills.slice(0, 24).map((s) => `<span class="tag skill">${esc(s)}</span>`).join('')}</div>` : ''}
  `;
  el.profileCard.classList.remove('hidden');
}

/* ================= 渲染结果 ================= */
function scoreClass(n) {
  if (n >= 85) return 's-high';
  if (n >= 70) return 's-mid';
  if (n >= 50) return 's-low';
  return 's-bad';
}

// 状态选择用事件委托挂在结果容器上（只挂一次，避免每次渲染重复绑定）
if (!renderResult._bound) {
  renderResult._bound = true;
  document.addEventListener('change', (e) => {
    const sel = e.target.closest && e.target.closest('.status-picker');
    if (sel) setStatus(sel.dataset.id, sel.value, sel);
  });
}

function renderResult(result) {
  const jobs = result.jobs || [];
  const st = result.stats || {};
  const f = result.funnel || {};
  // 把漏斗摊开显示。
  // 起因：用户看到「去重后 320 条」却只出十几个结果，而中间两级硬截断
  // （shortlistSize 入围上限、minScore 评分下限）此前完全不可见，
  // 光看「320 → 17」根本不知道东西是在哪一步没的。
  const steps = [
    ['采集原始', f.raw ?? st.rawCount],
    ['去重后', f.deduped ?? st.afterDedupe],
    ['届别过滤后', f.afterYear],
    f.degreeCut ? ['学历下限', `-${f.degreeCut}`] : null,
    ['规则预筛', f.prescored],
    ['送 LLM 精排', f.shortlisted],
    ['评分达标', f.returned ?? jobs.length],
  ].filter(Boolean);
  const funnelHtml = steps
    .map(([label, val], i) => {
      const sep = i > 0 ? '<i class="funnel-arrow">›</i>' : '';
      return `${sep}<span class="funnel-step"><em>${esc(label)}</em><b>${val ?? '-'}</b></span>`;
    })
    .join('');
  const cutHint =
    f.shortlistCut || f.minScoreCut
      ? `<div class="funnel-hint">漏斗收缩主要来自两处上限：${
          f.shortlistCut ? `入围上限截掉 <b>${f.shortlistCut}</b> 条（规则分不够高）` : ''
        }${f.shortlistCut && f.minScoreCut ? '；' : ''}${
          f.minScoreCut ? `评分下限（&lt;${result.match?.minScore ?? 40} 分）筛掉 <b>${f.minScoreCut}</b> 条` : ''
        }</div>`
      : '';
  el.resultStats.innerHTML = `
    <div class="result-headline">
      <span>共 <b>${jobs.length}</b> 个推荐岗位</span>
      ${result.tracking?.added ? `<span class="hl-new">本次新增 <b>${result.tracking.added}</b> 个</span>` : ''}
      ${result.tracking?.disappeared ? `<span class="hl-gone">已下架 <b>${result.tracking.disappeared}</b> 个</span>` : ''}
      ${result.tracking?.totalIndexed ? `<span>累计记录 <b>${result.tracking.totalIndexed}</b> 个</span>` : ''}
      <span>耗时 <b>${((result.durationMs || 0) / 1000).toFixed(1)}s</b></span>
    </div>
    <div class="funnel">${funnelHtml}</div>
    ${cutHint}
  `;

  // 来源与评级筛选
  const sources = [...new Set(jobs.map((j) => j.sourceName || j.source))];
  el.sourceFilter.innerHTML =
    `<option value="">全部来源</option>` + sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  const verdicts = [...new Set(jobs.map((j) => j.verdict).filter(Boolean))];
  el.verdictFilter.innerHTML =
    `<option value="">全部评级</option>` + verdicts.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

  renderJobs();
  el.resultArea.classList.remove('hidden');
  el.emptyState.classList.add('hidden');
}

function currentJobs() {
  const jobs = [...(state.result?.jobs || [])];
  const src = el.sourceFilter.value;
  const vd = el.verdictFilter.value;
  let out = jobs;
  if (src) out = out.filter((j) => (j.sourceName || j.source) === src);
  if (vd) out = out.filter((j) => j.verdict === vd);

  const sort = el.sortSelect.value;
  if (sort === 'score') out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  else if (sort === 'preScore') out.sort((a, b) => (b.preScore ?? 0) - (a.preScore ?? 0));
  else if (sort === 'publishTime') out.sort((a, b) => String(b.publishTime || '').localeCompare(String(a.publishTime || '')));
  else if (sort === 'salary') out.sort((a, b) => salaryValue(b.salary) - salaryValue(a.salary));
  return out;
}

function salaryValue(s) {
  if (!s) return 0;
  const nums = String(s).match(/[\d.]+/g);
  if (!nums) return 0;
  let v = parseFloat(nums[0]);
  if (/万/.test(s)) v *= 10000;
  else if (/千|k/i.test(s)) v *= 1000;
  return v;
}

function renderJobs() {
  const jobs = currentJobs();
  if (!jobs.length) {
    el.jobList.innerHTML = `<div class="empty"><p>没有符合筛选条件的岗位</p></div>`;
    return;
  }
  el.jobList.innerHTML = jobs.map(jobCard).join('');
}

function jobCard(j) {
  const score = j.score ?? 0;
  const t = j.tracking || {};
  // 跨检索追踪标记：新增 / 挂了多久 / 投递状态
  const trackBadges = [
    t.isNew ? '<span class="tk tk-new">新增</span>' : '',
    // 挂了 30 天以上且没处理 —— 长期招不到人的岗位值得警惕
    t.daysListed >= 30 && ['new', 'seen'].includes(t.status || 'new')
      ? `<span class="tk tk-stale" title="这个岗位上架很久了，可能薪资不符/要求过高/中介挂靠">已挂 ${t.daysListed} 天</span>`
      : t.daysListed > 0
        ? `<span class="tk">上架 ${t.daysListed} 天</span>`
        : '',
    t.expire ? `<span class="tk tk-expire">截止 ${esc(t.expire)}</span>` : '',
  ].filter(Boolean).join('');

  const meta = [
    j.city ? `<span class="m">📍 ${esc(j.city)}${j.district ? ' ' + esc(j.district) : ''}</span>` : '',
    j.salary ? `<span class="m salary">💰 ${esc(j.salary)}</span>` : '',
    j.education ? `<span class="m">🎓 ${esc(j.education)}</span>` : '',
    j.experience ? `<span class="m">🧳 ${esc(j.experience)}</span>` : '',
    j.jobType ? `<span class="m">🏷 ${esc(j.jobType)}</span>` : '',
    j.publishTime ? `<span class="m">🕒 ${esc(j.publishTime)}</span>` : '',
  ].filter(Boolean).join('');

  const skills = (j.skills || []).slice(0, 10);
  const matched = new Set((j.matchedKeywords || []).map((s) => String(s).toLowerCase()));
  const tags = skills
    .map((s) => `<span class="tag ${matched.has(String(s).toLowerCase()) ? 'hit' : ''}">${esc(s)}</span>`)
    .join('');

  const reasons = (j.reasons || []).slice(0, 5);
  const gaps = (j.gaps || []).slice(0, 3);
  const why = [
    ...reasons.map((r) => `<div class="why-line"><span class="ic">✅</span><span class="tx">${esc(r)}</span></div>`),
    ...gaps.map((g) => `<div class="why-line gap"><span class="ic">⚠️</span><span class="tx">${esc(g)}</span></div>`),
  ].join('');

  const jd = j.description
    ? `<details class="jd"><summary>查看岗位描述（JD）</summary><div class="jd-body">${esc(j.description.slice(0, 4000))}</div></details>`
    : '';

  const summary = !j.description && j.summary ? `<div class="why-line"><span class="ic">📝</span><span class="tx">${esc(j.summary.slice(0, 200))}</span></div>` : '';

  return `
  <article class="job">
    <div class="job-top">
      <div class="score ${scoreClass(score)}">
        <span class="n">${score}</span>
        <span class="l">${esc(j.verdict || '匹配分')}</span>
      </div>
      <div class="job-main">
        <div class="job-title-row">
          <span class="job-title">${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a>` : esc(j.title)}</span>
          ${j.company ? `<span class="job-company">· ${esc(j.company)}</span>` : ''}
          ${
            j.titleObfuscated && !j.titleRepaired
              ? `<span class="tag" title="实习僧用图标字体混淆了岗位标题，此处显示的是检索关键词兜底；点击岗位页可看到真实标题">标题待确认</span>`
              : ''
          }
          ${
            j.yearMatch
              ? `<span class="tag year" title="已通过「${j.yearMatch.year} 届校招」筛选：${esc(j.yearMatch.reason)}">${
                  j.yearMatch.years?.length ? `${j.yearMatch.years.join('/')} 届` : `${j.yearMatch.year} 届校招`
                }</span>`
              : ''
          }
          ${
            j.fromArticle
              ? `<span class="tag hit" title="该岗位由 DeepSeek 从微信公众号公告正文中抽取，点开可看公告原文摘录">来自公众号公告</span>`
              : ''
          }
          ${
            j.isArticleLead
              ? `<span class="tag" title="只检索到招聘公告标题，未能解析出具体岗位；点开可看公告原文">公告线索</span>`
              : ''
          }
          ${
            j.isCompanyLead
              ? `<span class="tag year" title="来自牛客校招日程，这是公司的网申窗口而非具体岗位；点开可看该公司在招职位">校招日程</span>`
              : ''
          }
        </div>
        <div class="job-meta">${meta}</div>
        ${tags ? `<div class="job-tags">${tags}</div>` : ''}
        ${why || summary ? `<div class="job-why">${why}${summary}</div>` : ''}
        ${jd}
        <div class="job-foot">
          <span class="src-badge">${esc(j.sourceName || j.source)}${(j.sources || []).length > 1 ? ' · 多源命中' : ''}</span>
          ${trackBadges ? `<span class="track-badges">${trackBadges}</span>` : ''}
          ${statusPicker(j)}
          <span class="links">
            ${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">${j.fromArticle || j.isArticleLead ? '查看公告原文' : j.isCompanyLead ? '查看该公司在招职位' : '打开岗位页'} ↗</a>` : ''}
            ${j.company ? `<a href="https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(j.company)}" target="_blank" rel="noopener">在同站搜该公司 ↗</a>` : ''}
          </span>
        </div>
      </div>
    </div>
  </article>`;
}

/* ================= 投递追踪 ================= */
// 状态按钮。这是 GitHub 同类项目（jobsync ★1255 / offeros）立住的核心功能：
// 不靠数据源、不靠算法，就靠「记录我投了哪些、结果如何」。
function statusPicker(j) {
  const cur = j.tracking?.status || 'new';
  const opts = Object.entries(STATUS_LABELS)
    .map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`)
    .join('');
  return `<select class="status-picker st-${cur}" data-id="${esc(j.id)}" title="标记投递状态（会保存到本地索引，跨次检索保留）">${opts}</select>`;
}

const STATUS_LABELS = {
  new: '未处理',
  seen: '已看过',
  interested: '感兴趣',
  applied: '已投递',
  interviewing: '面试中',
  offer: '已录用',
  rejected: '已拒',
  ignored: '不感兴趣',
};

async function setStatus(id, status, sel) {
  try {
    const res = await apiFetch('/api/tracking/jobs/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    if (sel) sel.className = `status-picker st-${status}`;
    toast(`已标记为「${STATUS_LABELS[status] || status}」`, 'ok');
  } catch (e) {
    toast('标记失败：' + e.message, 'err');
  }
}

/* ================= 导出 ================= */
function download(format) {
  if (!state.runId) {
    toast('本次结果尚未保存，无法导出', 'err');
    return;
  }
  window.location.href = `/api/runs/${encodeURIComponent(state.runId)}/export?format=${format}`;
}

/* ================= 历史记录 ================= */
async function openHistory() {
  el.historyDrawer.classList.remove('hidden');
  el.drawerMask.classList.remove('hidden');
  el.historyList.innerHTML = '<p style="color:var(--text-3);font-size:12.5px">加载中…</p>';
  try {
    const r = await apiFetch('/api/runs');
    const { runs } = await r.json();
    if (!runs?.length) {
      el.historyList.innerHTML = '<p style="color:var(--text-3);font-size:12.5px">还没有历史记录</p>';
      return;
    }
    el.historyList.innerHTML = runs
      .map(
        (h) => `
      <div class="history-item" data-id="${esc(h.runId)}">
        <div class="hi-top">
          <span class="hi-time">${new Date(h.createdAt).toLocaleString('zh-CN')}</span>
          <span class="hi-n">${h.returned} 个岗位</span>
        </div>
        <div class="hi-sub">${esc((h.targetRoles || []).join('、') || '未识别岗位')}${h.cities?.length ? ' · ' + esc(h.cities.join('/')) : ''}</div>
      </div>`,
      )
      .join('');
    el.historyList.querySelectorAll('.history-item').forEach((node) => {
      node.addEventListener('click', () => loadHistory(node.dataset.id));
    });
  } catch (e) {
    el.historyList.innerHTML = `<p style="color:var(--danger);font-size:12.5px">加载失败：${esc(e.message)}</p>`;
  }
}

async function loadHistory(runId) {
  try {
    const r = await apiFetch(`/api/runs/${encodeURIComponent(runId)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '加载失败');
    state.result = data;
    state.runId = data.runId;
    renderProfile(data.resumeProfile);
    renderResult(data);
    el.log.innerHTML = '';
    addLog(`已载入历史记录 ${data.runId}`, 'ok');
    setStage('历史记录', 'finalize');
    el.barFill.style.width = '100%';
    closeHistory();
    toast(`已载入 ${data.jobs.length} 个岗位`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function closeHistory() {
  el.historyDrawer.classList.add('hidden');
  el.drawerMask.classList.add('hidden');
}

/* ================= 事件绑定 ================= */
el.runBtn.addEventListener('click', run);
el.sortSelect.addEventListener('change', renderJobs);
el.yearSelect.addEventListener('change', updateYearHint);
el.includeInternship.addEventListener('change', updateYearHint);
el.sourceFilter.addEventListener('change', renderJobs);
el.verdictFilter.addEventListener('change', renderJobs);
el.exportCsv.addEventListener('click', () => download('csv'));
el.exportMd.addEventListener('click', () => download('md'));
el.historyBtn.addEventListener('click', openHistory);
el.closeHistory.addEventListener('click', closeHistory);
el.drawerMask.addEventListener('click', closeHistory);

el.resumeText.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
});

el.logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    /* 忽略 */
  }
  location.href = '/login';
});

/* 自带 Key 在浏览器本地留存：桌面版跨重启保留，网页版关掉标签页即清除 */el.userApiKey.addEventListener('change', () => {
  saveUserKey(el.userApiKey.value.trim());
});

/* 填了 Key 就把首次使用引导收起来 */
el.userApiKey.addEventListener('input', () => {
  if (el.userApiKey.value.trim()) {
    el.setupHint.classList.add('hidden');
    if (state.session?.desktop && !state.session?.deepseekConfigured) {
      el.runNote.textContent = '将使用你填写的 DeepSeek API Key';
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHistory();
});

/* 恢复上次填写的自带 Key */
(() => {
  const saved = loadUserKey();
  if (saved) {
    el.userApiKey.value = saved;
    el.byokBox.open = true;
  }
})();

loadHealth();
