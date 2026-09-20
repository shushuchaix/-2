// Web 层端到端测试：走 /api/upload + /api/analyze 流式接口，验证前端会看到什么
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3210';

/* 0. 会话与登录（部署版需要鉴权时自动登录） */
let cookie = '';
{
  const s = await (await fetch(`${BASE}/api/session`)).json();
  console.log(`会话状态: authenticated=${s.authenticated} authRequired=${s.authRequired}`);
  if (s.authRequired && !s.authenticated) {
    const pw = process.env.AUTH_PASSWORD;
    if (!pw) {
      console.error('服务已启用鉴权，请通过环境变量 AUTH_PASSWORD 提供密码后重跑本测试。');
      process.exit(1);
    }
    const r = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (!r.ok) {
      console.error('登录失败：', (await r.json()).error);
      process.exit(1);
    }
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    console.log('登录成功，已获取会话 Cookie');
  }
}

/** 统一带上会话 Cookie */
function api(path, opts = {}) {
  return fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
}

/* 1. 健康检查 */
const h = await (await api('/api/health')).json();
console.log('健康检查:', JSON.stringify(h.deepseek), '| 搜索通道:', h.search?.provider);

/* 2. 上传简历（走 base64 通道，模拟浏览器 FileReader） */
const resumePath = 'tools/sample-resume.txt';
const b64 = fs.readFileSync(resumePath).toString('base64');
const up = await api('/api/upload', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: 'sample-resume.txt', base64: b64 }),
});
const upData = await up.json();
console.log(`上传接口: HTTP ${up.status} | 提取 ${upData.length} 字 | 格式 ${upData.format} | 像简历: ${upData.looksLikeResume}`);

/* 3. 流式检索 */
console.log('\n开始流式检索（模拟前端 fetch + ReadableStream 解析）...\n');
const t0 = Date.now();
const res = await api('/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resumeText: upData.text,
    options: { useLlm: true, cities: ['北京', '杭州'] },
  }),
});
console.log('响应:', res.status, res.headers.get('content-type'));

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let result = null;
let runId = null;
let eventCount = 0;
const eventTypes = {};

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
      console.log('  [无法解析的行]', line.slice(0, 120));
      continue;
    }
    eventCount++;
    eventTypes[ev.type] = (eventTypes[ev.type] || 0) + 1;
    if (ev.type === 'stage') console.log(`▶ ${ev.label}`);
    else if (ev.type === 'log') console.log(`   ${ev.message}`);
    else if (ev.type === 'profile') console.log(`   画像：${ev.profile.degree} · ${ev.profile.targetRoles.join('、')} · 城市 ${ev.profile.preferredCities.join('/')}`);
    else if (ev.type === 'result') result = ev.result;
    else if (ev.type === 'saved') runId = ev.runId;
    else if (ev.type === 'error') console.log(`   错误：${ev.message}`);
  }
}

console.log(`\n流式结束：收到 ${eventCount} 个事件，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('事件类型统计:', eventTypes);

if (!result) {
  console.error('❌ 未收到最终结果');
  process.exit(1);
}

console.log(`\n结果：${result.jobs.length} 个岗位 | runId=${runId}`);
console.log('来源分布:', result.stats.bySource);
console.log('评级分布:', result.stats.byVerdict);
console.log('\n前 5 个岗位：');
result.jobs.slice(0, 5).forEach((j, i) => {
  console.log(`  ${i + 1}. [${j.score}分 ${j.verdict}] ${j.title} @ ${j.company} · ${j.city} · ${j.salary || '-'}`);
});

/* 4. 导出接口 */
for (const fmt of ['csv', 'md', 'json']) {
  const r = await api(`/api/runs/${runId}/export?format=${fmt}`);
  const body = await r.text();
  const cd = r.headers.get('content-disposition') || '';
  console.log(`\n导出 ${fmt.toUpperCase()}: HTTP ${r.status} | ${body.length} 字节 | ${cd.slice(0, 60)}`);
  if (fmt === 'csv') {
    const lines = body.replace(/^\uFEFF/, '').split('\r\n');
    console.log('  CSV 表头:', lines[0]);
    console.log('  首行数据:', lines[1]?.slice(0, 150));
  }
  if (fmt === 'md') console.log('  Markdown 前 3 行:', body.split('\n').slice(0, 3).join(' / '));
}

/* 5. 历史记录 */
const runs = await (await api('/api/runs')).json();
console.log(`\n历史记录: ${runs.runs.length} 条，最新: ${runs.runs[0]?.runId}（${runs.runs[0]?.returned} 个岗位）`);

/* 6. 错误处理 */
const bad = await api('/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ resumeText: '太短' }),
});
console.log(`\n短简历校验: HTTP ${bad.status} | ${JSON.stringify(await bad.json())}`);

const notFound = await api('/api/does-not-exist');
console.log(`未知接口: HTTP ${notFound.status} | ${JSON.stringify(await notFound.json())}`);

console.log('\n✅ Web 层端到端通过');
process.exit(0);
