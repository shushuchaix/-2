// 公网部署安全测试：鉴权、配额、并发、代理识别、fail-closed
// 采用「进程内启动服务」的方式，避免依赖管道 stdio
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;

/* ============================================================
   零、隔离运行环境（必须在任何 src 模块被 import 之前完成）
   ------------------------------------------------------------
   src/config.mjs 在模块求值时就固定 DATA_ROOT / CONFIG_PATH，
   而 ES module 有缓存 —— 只要在设置 RJR_DATA_DIR 之前碰过 config.mjs
   （直接或间接），后面再设就来不及了。
   所以临时数据目录与测试配置必须在这里先建好。

   这样做的好处：config.json / quota.json / .session-secret / runs
   全部落在临时目录，仓库里的真实配置与数据全程不被触碰。
   旧版本直接覆写仓库 config.json，一旦被 Ctrl+C 或超时杀掉，
   finally 的还原不会执行，真实配置就被测试配置永久覆盖了。
   ============================================================ */
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rjr-sectest-'));
const TEST_PASSWORD = 'test-password-12345';
const PORT = 3311;
const BASE = `http://127.0.0.1:${PORT}`;

fs.writeFileSync(
  path.join(TMP_DATA, 'config.json'),
  JSON.stringify(
    {
      sources: {
        // 安全测试只验证鉴权 / 配额 / 头部 / CSRF，与采集无关。
        // 必须把所有联网数据源都关掉：否则会真的去抓智联 / 公众号 / 牛客 / 高校就业网，
        // 既慢又不稳定（实测单是公众号+牛客+就业网就能跑满 300s 超时）。
        //
        // 【教训】新增数据源时必须同步加到这里。加了 chenyun / jiuyeqiao 之后忘了加，
        // 这个套件立刻从 1s 涨到 96s —— 因为那两个源在真联网。
        zhaopin: { enabled: false },
        shixiseng: { enabled: false },
        searchApi: { enabled: false },
        wechat: { enabled: false },
        nowcoder: { enabled: false },
        university: { enabled: false },
        chenyun: { enabled: false },
        jiuyeqiao: { enabled: false },
      },
      match: { shortlistSize: 5, enrichTopN: 0, minScore: 0 },
      server: { port: PORT, host: '127.0.0.1', trustProxy: false },
      auth: { mode: 'password', maxLoginFails: 3, lockMinutes: 1 },
      limits: { maxConcurrent: 1, maxQueue: 4 },
    },
    null,
    2,
  ),
  'utf8',
);

process.env.RJR_DATA_DIR = TMP_DATA;
process.env.AUTH_PASSWORD = TEST_PASSWORD;
process.env.PORT = String(PORT);
process.env.PER_IP_COOLDOWN_MS = '0';
process.env.IP_DAILY_LIMIT = '3';
process.env.DAILY_LIMIT = '100';

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`);
  }
}

function section(t) {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

/* ============================================================
   一、单元测试：密码哈希与会话签名
   ============================================================ */
section('一、鉴权基础件（单元测试）');

const auth = await import('../src/auth.mjs');

{
  const hash = auth.hashPassword(TEST_PASSWORD);
  check('密码哈希可校验通过', auth.verifyPassword(TEST_PASSWORD, hash));
  check('错误密码被拒绝', !auth.verifyPassword('wrong-password', hash));
  check('哈希不含明文密码', !hash.includes(TEST_PASSWORD));
  check('同一密码两次哈希不同（含随机盐）', auth.hashPassword(TEST_PASSWORD) !== hash);
  check('损坏的哈希不会抛异常而是返回 false', auth.verifyPassword('x', 'not-a-hash') === false);
}

{
  const sm = new auth.SessionManager({ secret: 'unit-test-secret-0123456789abcdef', ttlMs: 60000 });
  const { token } = sm.issue({ ip: '1.2.3.4' });
  const payload = sm.verify(token);
  check('签发的会话可通过校验', Boolean(payload) && payload.ip === '1.2.3.4');

  // 篡改签名
  const tampered = token.slice(0, -3) + 'abc';
  check('篡改签名的会话被拒绝', sm.verify(tampered) === null);

  // 篡改载荷（换个 sid 但仍保留原签名）
  const [body, sig] = token.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
  decoded.ip = '9.9.9.9';
  const forgedBody = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  check('篡改载荷的会话被拒绝', sm.verify(`${forgedBody}.${sig}`) === null);

  // 过期
  const expired = new auth.SessionManager({ secret: 'unit-test-secret-0123456789abcdef', ttlMs: -1000 });
  check('过期会话被拒绝', expired.verify(expired.issue().token) === null);

  // 换密钥签发的会话不可用
  const other = new auth.SessionManager({ secret: 'another-secret-0123456789abcdefgh', ttlMs: 60000 });
  check('其他密钥签发的会话被拒绝', sm.verify(other.issue().token) === null);
}

{
  const lg = new auth.LoginGuard({ maxFails: 3, windowMs: 60000, lockMs: 1000 });
  check('初次登录允许', lg.check('5.5.5.5').allowed);
  lg.fail('5.5.5.5');
  lg.fail('5.5.5.5');
  check('未达阈值仍允许', lg.check('5.5.5.5').allowed);
  lg.fail('5.5.5.5');
  const after = lg.check('5.5.5.5');
  check('达到阈值后锁定', !after.allowed && after.retryAfterMs > 0);
  check('其他 IP 不受影响', lg.check('6.6.6.6').allowed);
}

{
  const fakeReq = (headers, remote) => ({ headers, socket: { remoteAddress: remote } });
  check(
    'TRUST_PROXY 关闭时忽略 X-Forwarded-For（防伪造绕过限流）',
    auth.clientIp(fakeReq({ 'x-forwarded-for': '1.1.1.1' }, '10.0.0.5'), false) === '10.0.0.5',
  );
  check(
    'TRUST_PROXY 开启时采用 X-Forwarded-For 首个地址',
    auth.clientIp(fakeReq({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '10.0.0.5'), true) === '1.1.1.1',
  );
  check(
    'IPv4-mapped IPv6 归一化',
    auth.clientIp(fakeReq({}, '::ffff:192.168.1.9'), false) === '192.168.1.9',
  );
}

/* ============================================================
   二、单元测试：并发与配额闸门
   ============================================================ */
section('二、并发与配额闸门（单元测试）');

const { RunGate } = await import('../src/limits.mjs');

{
  // 并发与排队
  const g = new RunGate({ persist: false, maxConcurrent: 1, maxQueue: 3, dailyGlobal: 100, dailyPerIp: 100, perIpCooldownMs: 0 });
  const a = g.acquire('1.1.1.1');
  const b = g.acquire('2.2.2.2');
  const c = g.acquire('3.3.3.3');
  check('第一个请求立即获得名额', a.ok && a.ticket.position === 0);
  check('第二个请求进入排队（并发上限生效）', b.ok && b.ticket.position === 1);
  check('第三个请求排队位置为 2', c.ok && c.ticket.position === 2);

  const d = g.acquire('4.4.4.4');
  check('排队达到上限（3 个）仍可接受', d.ok && d.ticket.position === 3);

  const e5 = g.acquire('5.5.5.5');
  check('超过队列上限直接拒绝', !e5.ok && e5.status === 503, e5.ok ? '居然被接受了' : e5.reason);

  a.release();
  check('释放名额后队首递补（position 归零）', b.ticket.position === 0);
  check('后续排队位置前移', c.ticket.position === 1);

  // 真正的并发互斥验证
  const g2 = new RunGate({ persist: false, maxConcurrent: 1, maxQueue: 5, dailyGlobal: 100, dailyPerIp: 100, perIpCooldownMs: 0 });
  const order = [];
  const t1 = (async () => {
    const p = g2.acquire('a');
    await g2.waitTurn(p.ticket);
    order.push('t1-start');
    await new Promise((r) => setTimeout(r, 200));
    order.push('t1-end');
    p.release();
  })();
  await new Promise((r) => setTimeout(r, 30));
  const t2 = (async () => {
    const p = g2.acquire('b');
    await g2.waitTurn(p.ticket);
    order.push('t2-start');
    p.release();
  })();
  await Promise.all([t1, t2]);
  check('并发上限为 1 时任务严格串行', JSON.stringify(order) === JSON.stringify(['t1-start', 't1-end', 't2-start']), order.join(' → '));
}

{
  // 每 IP 每日配额
  const g = new RunGate({ persist: false, maxConcurrent: 5, maxQueue: 5, dailyGlobal: 100, dailyPerIp: 2, perIpCooldownMs: 0 });
  const r1 = g.acquire('7.7.7.7');
  const r2 = g.acquire('7.7.7.7');
  const r3 = g.acquire('7.7.7.7');
  check('配额内允许', r1.ok && r2.ok);
  check('超出每 IP 配额返回 429', !r3.ok && r3.status === 429 && /今日/.test(r3.reason));
  check('其他 IP 配额独立', g.acquire('8.8.8.8').ok);

  // 全局配额
  const g2 = new RunGate({ persist: false, maxConcurrent: 5, maxQueue: 5, dailyGlobal: 2, dailyPerIp: 100, perIpCooldownMs: 0 });
  g2.acquire('1.1.1.1');
  g2.acquire('2.2.2.2');
  const over = g2.acquire('3.3.3.3');
  check('超出全站每日配额返回 429', !over.ok && over.status === 429 && /全站/.test(over.reason));
}

{
  // 冷却
  const g = new RunGate({ persist: false, maxConcurrent: 5, maxQueue: 5, dailyGlobal: 100, dailyPerIp: 100, perIpCooldownMs: 60000 });
  g.acquire('9.9.9.9');
  const again = g.acquire('9.9.9.9');
  check('同 IP 冷却期内被拒绝', !again.ok && /频繁/.test(again.reason));
}

/* ============================================================
   三、fail-closed 启动校验（单元测试）
   ============================================================ */
section('三、公网暴露的 fail-closed 校验');

const { assertSafeExposure } = await import('../src/config.mjs');

function cfgWith(host, mode, { password = false, hash = false } = {}) {
  return {
    server: { host },
    auth: { mode, passwordHash: hash ? 'scrypt$...' : '' },
    __envAuthPassword: password ? 'x' : '',
  };
}

try {
  const r = assertSafeExposure(cfgWith('127.0.0.1', 'password'));
  check('环回地址免鉴权可启动（本地自用）', r.publicBind === false && r.devMode === true);
} catch (e) {
  check('环回地址免鉴权可启动（本地自用）', false, e.message.split('\n')[0]);
}

try {
  assertSafeExposure(cfgWith('0.0.0.0', 'password'));
  check('公网监听但无口令 → 拒绝启动', false, '居然没抛错');
} catch (e) {
  check('公网监听但无口令 → 拒绝启动', /拒绝启动/.test(e.message));
}

try {
  const r = assertSafeExposure(cfgWith('0.0.0.0', 'password', { password: true }));
  check('公网监听 + 环境变量口令 → 允许启动', r.publicBind === true && r.authEnabled === true);
} catch (e) {
  check('公网监听 + 环境变量口令 → 允许启动', false, e.message.split('\n')[0]);
}

try {
  const r = assertSafeExposure(cfgWith('0.0.0.0', 'password', { hash: true }));
  check('公网监听 + 配置哈希 → 允许启动', r.authEnabled === true);
} catch (e) {
  check('公网监听 + 配置哈希 → 允许启动', false, e.message.split('\n')[0]);
}

delete process.env.ALLOW_PUBLIC_NO_AUTH;
try {
  assertSafeExposure(cfgWith('0.0.0.0', 'none'));
  check('mode=none 且公网监听 → 拒绝启动', false, '居然没抛错');
} catch (e) {
  check('mode=none 且公网监听 → 拒绝启动', /拒绝启动/.test(e.message));
}

process.env.ALLOW_PUBLIC_NO_AUTH = '1';
try {
  const r = assertSafeExposure(cfgWith('0.0.0.0', 'none'));
  check('显式 ALLOW_PUBLIC_NO_AUTH=1 才放行', r.authEnabled === false);
} catch (e) {
  check('显式 ALLOW_PUBLIC_NO_AUTH=1 才放行', false, e.message.split('\n')[0]);
}
delete process.env.ALLOW_PUBLIC_NO_AUTH;

/* ============================================================
   四、HTTP 集成测试
   ============================================================ */
section('四、HTTP 集成测试（进程内启动，全数据源关闭以便快速跑通）');

// 隔离环境与测试配置已在文件顶部的「零、隔离运行环境」中建好，
// 这里只需启动服务（config.mjs 会自己读到 TMP_DATA/config.json）。
let server, started;
try {
  const { startServer } = await import('../src/server.mjs');
  started = startServer();
  server = started.server;
  await new Promise((r) => server.once('listening', r));

  let cookie = '';
  const api = (p, opts = {}) =>
    fetch(`${BASE}${p}`, {
      ...opts,
      headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
    });

  // --- 未登录 ---
  let r = await api('/api/session');
  let j = await r.json();
  check('未登录时 /api/session 返回 authenticated=false', j.authenticated === false && j.authRequired === true);

  r = await api('/api/health');
  j = await r.json();
  check('未登录时 /api/health 不泄露密钥信息', j.ok === true && !j.deepseek, `字段：${Object.keys(j).join(',')}`);

  r = await api('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeText: '张三 本科 计算机 2026届 Java Spring Boot MySQL Redis 项目经历 实习经历' }),
  });
  check('未登录调用 /api/analyze 被拦截', r.status === 401, `HTTP ${r.status}`);

  r = await api('/api/runs');
  check('未登录调用 /api/runs 被拦截', r.status === 401, `HTTP ${r.status}`);

  r = await fetch(`${BASE}/`, { redirect: 'manual' });
  check('未登录访问首页被重定向到登录页', r.status === 302 && r.headers.get('location') === '/login', `${r.status} → ${r.headers.get('location')}`);

  r = await fetch(`${BASE}/login`);
  check('登录页本身可公开访问', r.status === 200);

  // --- 安全响应头 ---
  r = await fetch(`${BASE}/login`);
  const csp = r.headers.get('content-security-policy') || '';
  check('返回 CSP 响应头', csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'"));
  check('返回 X-Frame-Options / nosniff', r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff');

  // --- 登录 ---
  r = await api('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  check('错误密码返回 401', r.status === 401, `HTTP ${r.status}`);

  r = await api('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  check('跨站来源的登录请求被拒绝（CSRF 防护）', r.status === 403, `HTTP ${r.status}`);

  r = await api('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  j = await r.json();
  const setCookie = r.headers.get('set-cookie') || '';
  check('正确密码登录成功', r.status === 200 && j.ok === true, `HTTP ${r.status}`);
  check('下发 HttpOnly + SameSite=Lax 会话 Cookie', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));
  check('Cookie 带 Max-Age（会话有时效）', /Max-Age=\d+/i.test(setCookie));
  cookie = setCookie.split(';')[0];

  // --- 登录后 ---
  r = await api('/api/session');
  j = await r.json();
  check('登录后 /api/session 返回 authenticated=true', j.authenticated === true);
  check('返回配额信息', j.quota && typeof j.quota.remainingIp === 'number', JSON.stringify(j.quota));

  r = await api('/api/health');
  j = await r.json();
  check('登录后可读取完整健康信息', Boolean(j.deepseek) && Boolean(j.match));
  check('健康信息中的密钥已脱敏', !j.deepseek.keyMasked?.includes(TEST_PASSWORD) && j.deepseek.keyMasked !== process.env.DEEPSEEK_API_KEY);

  r = await api('/api/runs');
    check('登录后无目标范围的历史访问明确拒绝', r.status === 409 && (await r.json()).code==='version_scope_required');

  // --- 会话伪造 ---
  const savedCookie = cookie;
  cookie = 'rjr_session=forged.token.value';
  r = await api('/api/runs');
  check('伪造会话 Cookie 被拒绝', r.status === 401, `HTTP ${r.status}`);
  cookie = savedCookie;

  // --- 自带 Key 校验 ---
  r = await api('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeText: '张三 本科 计算机 2026届 Java Spring Boot MySQL Redis 项目 实习', userApiKey: 'invalid key with spaces' }),
  });
  check('非法自带 Key 被拒绝', r.status === 400, `HTTP ${r.status}`);

  // --- 简历长度校验 ---
  r = await api('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeText: '太短' }),
  });
  check('过短简历被拒绝', r.status === 400, `HTTP ${r.status}`);

  // --- 真实跑通一次（关闭数据源 + 离线模式，秒级完成） ---
  const runOnce = async (label) => {
    const res = await api('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resumeText:
          '张明 本科 北京邮电大学 计算机科学与技术 2026届\n技能：Java、Spring Boot、MySQL、Redis、Docker、Git\n实习经历：某科技公司 后端开发实习生\n项目经历：校园二手交易平台 分布式短链接系统\n求职意向：Java后端开发工程师 北京',
        options: { useLlm: false },
      }),
    });
    if (res.status !== 200) {
      const data = await res.json().catch(() => ({}));
      return { status: res.status, error: data.error };
    }
    const text = await res.text();
    const events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { status: 200, events, types: events.map((e) => e.type) };
  };

  const run1 = await runOnce('first');
  check('已登录可正常发起检索（NDJSON 流）', run1.status === 200 && run1.types.includes('done'), `事件：${(run1.types || []).join(',')}`);
  check('流中包含 result 事件', (run1.types || []).includes('result'));
  check('流中包含配额事件', (run1.types || []).includes('quota'));

  // --- 每 IP 每日配额（测试环境设为 3） ---
  const run2 = await runOnce('second');
  check('第 2 次检索仍可用（配额 3）', run2.status === 200);
  const run3 = await runOnce('third');
  check('第 3 次检索仍可用（配额 3）', run3.status === 200);
  const run4 = await runOnce('fourth');
  check('第 4 次检索被配额拦截（429）', run4.status === 429, `HTTP ${run4.status} — ${run4.error || ''}`);

  // --- 登出 ---
  r = await api('/api/logout', { method: 'POST' });
  const logoutCookie = r.headers.get('set-cookie') || '';
  check('登出清理会话 Cookie', /Max-Age=0/i.test(logoutCookie));
  cookie = logoutCookie.split(';')[0];
  r = await api('/api/runs');
  check('登出后接口重新被拦截', r.status === 401, `HTTP ${r.status}`);

  // --- 未知接口 ---
  cookie = savedCookie;
  r = await api('/api/definitely-not-exist');
  check('未知 API 返回 404 JSON', r.status === 404 && (await r.json()).error);
} catch (e) {
  check('HTTP 集成测试执行', false, e.message);
  if (process.env.DEBUG) console.error(e.stack);
} finally {
  // Stop HTTP callbacks and drain startup/log writes before removing their temporary directory.
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await (await started.ctx.ready).close?.();
    await started.ctx.diagnostics.list({limit:1});
  }
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
}

/* ============================================================
   汇总
   ============================================================ */
console.log(`\n${'='.repeat(70)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'='.repeat(70)}\n`);

delete process.env.AUTH_PASSWORD;
delete process.env.ALLOW_PUBLIC_NO_AUTH;

process.exit(fail === 0 ? 0 : 1);
