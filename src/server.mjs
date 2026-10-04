// 本地 Web 服务：静态页面 + NDJSON 流式 API + 结果持久化/导出
// 公网部署形态：密码登录鉴权 + 安全响应头 + 并发与每日配额闸门
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDataDirs, assertSafeExposure, ROOT, DATA_ROOT, IS_DESKTOP, maskKey } from './config.mjs';
import {
  SessionManager,
  LoginGuard,
  hashPassword,
  verifyPassword,
  parseCookies,
  buildSetCookie,
  clearCookie,
  clientIp,
  isSecureRequest,
} from './auth.mjs';
import { RunGate } from './limits.mjs';
import { DeepSeek } from './llm/deepseek.mjs';
import { extractResumeText, looksLikeResume } from './resume/extract-text.mjs';
import { runPipeline, saveRun, listRuns, loadRun, RUNS_DIR } from './pipeline.mjs';
import { exportResult } from './export.mjs';
import * as zhaopin from './sources/zhaopin.mjs';
import * as shixiseng from './sources/shixiseng.mjs';
import * as wechat from './sources/wechat.mjs';
import * as nowcoder from './sources/nowcoder.mjs';
import * as university from './sources/university.mjs';
import * as chenyun from './sources/chenyun.mjs';
import * as jiuyeqiao from './sources/jiuyeqiao.mjs';
import * as store from './store.mjs';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 40 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/* --------------------------- 响应工具 --------------------------- */

function securityHeaders(req, cfg, extra = {}) {
  const https = isSecureRequest(req, cfg.server.trustProxy);
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...extra,
  };
  if (https) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function sendJson(req, res, cfg, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...securityHeaders(req, cfg),
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体过大（>${(limit / 1048576).toFixed(0)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`请求体不是合法 JSON：${e.message}`);
  }
}

function serveStatic(req, res, cfg, pathname, { allowMissing = false } = {}) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = path.resolve(path.join(PUBLIC_DIR, rel));
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    sendJson(req, res, cfg, 403, { error: '非法路径' });
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      if (allowMissing) {
        sendJson(req, res, cfg, 404, { error: '资源不存在' });
        return;
      }
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], ...securityHeaders(req, cfg) });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(resolved);
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, ...securityHeaders(req, cfg) });
    res.end(data);
  });
}

/**
 * CSRF 防护：SameSite=Lax 已挡住跨站表单提交，
 * 这里再校验 Origin/Referer，挡住浏览器之外的构造请求。
 */
function originAllowed(req, cfg) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（curl / 脚本）
  try {
    const o = new URL(origin);
    const host = String(req.headers.host || '').toLowerCase();
    if (o.host.toLowerCase() === host) return true;
    if (cfg.server.publicUrl) {
      try {
        if (new URL(cfg.server.publicUrl).host.toLowerCase() === o.host.toLowerCase()) return true;
      } catch {
        /* publicUrl 配错则忽略 */
      }
    }
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------ 服务 ------------------------------ */

export function createServer(cfg) {
  const llm = new DeepSeek(cfg);
  const exposure = assertSafeExposure(cfg);

  // 鉴权上下文：公网监听必须有口令；本地环回访问可免登录，方便自用
  const passwordHash = cfg.__envAuthPassword ? hashPassword(cfg.__envAuthPassword) : cfg.auth.passwordHash;
  const authRequired = cfg.auth.mode !== 'none' && Boolean(passwordHash);
  const sessions = new SessionManager({
    secret: cfg.__authSecret,
    ttlMs: (Number(cfg.auth.sessionTtlHours) || 168) * 3600 * 1000,
  });
  const loginGuard = new LoginGuard({
    maxFails: Number(cfg.auth.maxLoginFails) || 5,
    lockMs: (Number(cfg.auth.lockMinutes) || 15) * 60 * 1000,
  });
  setInterval(() => loginGuard.sweep(), 10 * 60 * 1000).unref?.();

  const gate = new RunGate({
    maxConcurrent: cfg.limits.maxConcurrent,
    maxQueue: cfg.limits.maxQueue,
    dailyGlobal: cfg.limits.dailyGlobal,
    dailyPerIp: cfg.limits.dailyPerIp,
    perIpCooldownMs: cfg.limits.perIpCooldownMs,
  });

  function sessionOf(req) {
    const cookies = parseCookies(req);
    return sessions.verify(cookies[sessions.cookieName]);
  }

  /**
   * 判断本次请求是否已获授权。
   *
   * 这里刻意不做「环回地址免登录」的旁路：如果服务器部署在同机的 nginx/Caddy 之后
   * 而 TRUST_PROXY 未开启，所有访客的 socket 地址都会是 127.0.0.1，
   * 那样等于把服务完全开放给公网。本地自用请改用 auth.mode = "none"。
   */
  function isAuthed(req) {
    if (!authRequired) return true;
    return Boolean(sessionOf(req));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    const ip = clientIp(req, cfg.server.trustProxy);
    const secure = isSecureRequest(req, cfg.server.trustProxy);

    try {
      /* ---------------- 登录页（无需鉴权） ---------------- */
      if (pathname === '/login' && req.method === 'GET') {
        return serveStatic(req, res, cfg, '/login.html', { allowMissing: true });
      }

      /* ---------------- 会话状态（无需鉴权，供前端判断跳转） ---------------- */
      if (pathname === '/api/session' && req.method === 'GET') {
        const authed = isAuthed(req);
        return sendJson(req, res, cfg, 200, {
          authenticated: authed,
          authRequired,
          exposure: exposure.publicBind ? 'public' : 'local',
          quota: authed ? gate.peek(ip) : null,
          allowUserKey: Boolean(cfg.deepseek.allowUserKey),
          // 桌面外壳据此切换交互：免登录、自带 Key 本地持久化、指向数据目录
          desktop: IS_DESKTOP,
          dataDir: IS_DESKTOP ? DATA_ROOT : undefined,
          deepseekConfigured: llm.available,
        });
      }

      /* ---------------- 登录 / 登出 ---------------- */
      if (pathname === '/api/login' && req.method === 'POST') {
        if (!authRequired) return sendJson(req, res, cfg, 200, { ok: true, message: '当前未启用鉴权' });
        if (!originAllowed(req, cfg)) return sendJson(req, res, cfg, 403, { error: '请求来源不被允许' });

        const guard = loginGuard.check(ip);
        if (!guard.allowed) {
          const mins = Math.ceil(guard.retryAfterMs / 60000);
          return sendJson(req, res, cfg, 429, { error: `登录尝试过于频繁，请 ${mins} 分钟后再试` });
        }

        const body = await readJsonBody(req);
        const password = String(body.password || '');
        if (!password) return sendJson(req, res, cfg, 400, { error: '请输入访问密码' });

        if (!verifyPassword(password, passwordHash)) {
          const lockedUntil = loginGuard.fail(ip);
          const left = lockedUntil ? 0 : Math.max(0, (Number(cfg.auth.maxLoginFails) || 5) - 1);
          return sendJson(req, res, cfg, 401, {
            error: lockedUntil ? '密码错误次数过多，账号已临时锁定' : `密码错误${left ? `，还可尝试 ${left} 次` : ''}`,
          });
        }

        loginGuard.succeed(ip);
        const { token } = sessions.issue({ ip });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': buildSetCookie(sessions.cookieName, token, { maxAge: sessions.ttlMs, secure }),
          'Cache-Control': 'no-store',
          ...securityHeaders(req, cfg),
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (pathname === '/api/logout' && req.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': clearCookie(sessions.cookieName),
          'Cache-Control': 'no-store',
          ...securityHeaders(req, cfg),
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      /* ---------------- 健康检查 ---------------- */
      if (pathname === '/api/health' && req.method === 'GET') {
        const authed = isAuthed(req);
        const base = { ok: true, version: '1.1.0', authRequired, authenticated: authed };
        if (!authed) return sendJson(req, res, cfg, 200, base);
        return sendJson(req, res, cfg, 200, {
          ...base,
          exposure: exposure.publicBind ? 'public' : 'local',
          deepseek: {
            configured: llm.available,
            source: cfg.__deepseekKeySource,
            model: llm.model,
            keyMasked: maskKey(llm.apiKey),
            concurrency: llm.concurrency,
            allowUserKey: Boolean(cfg.deepseek.allowUserKey),
          },
          search: {
            provider: cfg.__activeSearchProvider || null,
            configuredKeys: Object.entries(cfg.__searchKeys)
              .filter(([, v]) => v)
              .map(([k]) => k),
          },
          sources: {
            zhaopin: { enabled: cfg.sources.zhaopin.enabled, name: zhaopin.meta.name, maxPages: cfg.sources.zhaopin.maxPages },
            shixiseng: { enabled: cfg.sources.shixiseng.enabled, name: shixiseng.meta.name, maxPages: cfg.sources.shixiseng.maxPages },
            nowcoder: { enabled: cfg.sources.nowcoder?.enabled !== false, name: nowcoder.meta.name },
            university: {
              enabled: cfg.sources.university?.enabled !== false,
              name: university.meta.name,
              hosts: (cfg.sources.university?.hosts?.length || 0) + university.DEFAULT_HOSTS.length,
            },
            chenyun: {
              enabled: cfg.sources.chenyun?.enabled !== false,
              name: chenyun.meta.name,
              hosts: (cfg.sources.chenyun?.hosts?.length || 0) + chenyun.CHENYUN_HOSTS.length,
            },
            jiuyeqiao: { enabled: cfg.sources.jiuyeqiao?.enabled !== false, name: jiuyeqiao.meta.name },
            wechat: { enabled: cfg.sources.wechat?.enabled !== false, name: wechat.meta.name, maxQueries: cfg.sources.wechat?.maxQueries },
            searchApi: { enabled: cfg.sources.searchApi.enabled, maxQueries: cfg.sources.searchApi.maxQueries },
          },
          match: cfg.match,
          filters: cfg.filters,
          quota: gate.peek(ip),
        });
      }

      /* ---------------- 以下接口全部需要鉴权 ---------------- */
      if (pathname.startsWith('/api/') && !isAuthed(req)) {
        return sendJson(req, res, cfg, 401, { error: '未登录或登录已过期，请先登录', needLogin: true });
      }
      if (pathname === '/' && authRequired && !isAuthed(req)) {
        res.writeHead(302, { Location: '/login', ...securityHeaders(req, cfg) });
        return res.end();
      }
      // 变更类请求做来源校验
      if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method) && !originAllowed(req, cfg)) {
        return sendJson(req, res, cfg, 403, { error: '请求来源不被允许' });
      }

      /* ---------------- 简历文件上传 → 文本 ---------------- */
      if (pathname === '/api/upload' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { filename = 'resume.txt', base64 = '' } = body;
        if (!base64) return sendJson(req, res, cfg, 400, { error: '缺少文件内容' });
        const buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
        if (!buf.length) return sendJson(req, res, cfg, 400, { error: '文件内容为空或 base64 解码失败' });
        try {
          const { text, format } = await extractResumeText(buf, filename);
          if (!text || text.length < 30) {
            return sendJson(req, res, cfg, 422, { error: '未能从文件中提取到有效文字（可能是扫描版图片 PDF），请改用手动粘贴简历内容' });
          }
          return sendJson(req, res, cfg, 200, { text, format, length: text.length, looksLikeResume: looksLikeResume(text), filename });
        } catch (e) {
          return sendJson(req, res, cfg, 422, { error: e.message });
        }
      }

      /* ---------------- 主流程（NDJSON 流式） ---------------- */
      if (pathname === '/api/analyze' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const resumeText = String(body.resumeText || '').trim();
        if (resumeText.length < 30) {
          return sendJson(req, res, cfg, 400, { error: '简历内容太短（至少 30 个字符），请粘贴完整简历或上传简历文件' });
        }
        if (resumeText.length > 60000) {
          return sendJson(req, res, cfg, 413, { error: '简历内容过长（上限 6 万字符）' });
        }
        const options = body.options || {};

        // 访客自带 Key：仅在内存中使用，不落盘、不写日志
        let requestLlm = llm;
        const userKey = String(body.userApiKey || '').trim();
        if (userKey) {
          if (!cfg.deepseek.allowUserKey) {
            return sendJson(req, res, cfg, 403, { error: '本站不允许使用自带 API Key' });
          }
          if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(userKey)) {
            return sendJson(req, res, cfg, 400, { error: '自带 API Key 格式不正确（应以 sk- 开头）' });
          }
          requestLlm = new DeepSeek({ ...cfg, deepseek: { ...cfg.deepseek, apiKey: userKey } });
        }

        // 配额与并发闸门
        const permit = gate.acquire(ip);
        if (!permit.ok) {
          res.writeHead(permit.status, { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders(req, cfg) });
          return res.end(JSON.stringify({ error: permit.reason, retryAfterMs: permit.retryAfterMs }));
        }

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...securityHeaders(req, cfg),
        });

        const controller = new AbortController();
        req.on('close', () => controller.abort());

        const emit = (ev) => {
          if (res.writableEnded) return;
          try {
            res.write(JSON.stringify(ev) + '\n');
          } catch {
            /* 客户端已断开 */
          }
        };
        const heartbeat = setInterval(() => emit({ type: 'ping', t: Date.now() }), 15000);

        try {
          if (permit.queued > 0) {
            emit({ type: 'log', message: `前面还有 ${permit.queued} 个任务在排队，请稍候…` });
            emit({ type: 'queued', position: permit.queued });
            await gate.waitTurn(permit.ticket, (pos) => emit({ type: 'queued', position: pos }), controller.signal);
            emit({ type: 'log', message: '已排到，开始检索' });
          }
          const result = await runPipeline({
            resumeText,
            llm: requestLlm,
            cfg,
            options,
            onEvent: emit,
            signal: controller.signal,
          });
          try {
            const file = await saveRun(result);
            emit({ type: 'saved', file: path.relative(ROOT, file), runId: result.runId });
          } catch (e) {
            emit({ type: 'log', message: `结果保存失败：${e.message}` });
          }
          emit({ type: 'quota', quota: gate.peek(ip) });
          emit({ type: 'done' });
        } catch (e) {
          emit({ type: 'error', message: e.message || String(e) });
          emit({ type: 'done' });
        } finally {
          clearInterval(heartbeat);
          permit.release();
          res.end();
        }
        return;
      }

      /* ---------------- 历史运行 ---------------- */
      if (pathname === '/api/runs' && req.method === 'GET') {
        return sendJson(req, res, cfg, 200, { runs: listRuns(100) });
      }

      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && req.method === 'GET') {
        const run = loadRun(runMatch[1]);
        if (!run) return sendJson(req, res, cfg, 404, { error: '未找到该运行记录' });
        return sendJson(req, res, cfg, 200, run);
      }
      if (runMatch && req.method === 'DELETE') {
        const safe = runMatch[1].replace(/[^a-zA-Z0-9\-]/g, '');
        const file = path.join(RUNS_DIR, `${safe}.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return sendJson(req, res, cfg, 200, { ok: true });
      }

      /* ---------------- 岗位索引 / 投递追踪 ---------------- */
      // 跨检索持久化：新增岗位、存活时长、投递状态。
      // 这是 GitHub 上同类项目（jobsync ★1255、offeros）立住的核心功能。
      if (pathname === '/api/tracking/summary' && req.method === 'GET') {
        return sendJson(req, res, cfg, 200, await store.summary());
      }
      if (pathname === '/api/tracking/jobs' && req.method === 'GET') {
        const status = url.searchParams.get('status') || '';
        const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 200);
        return sendJson(req, res, cfg, 200, { jobs: await store.listJobs({ status, limit }) });
      }
      const trackMatch = pathname.match(/^\/api\/tracking\/jobs\/([^/]+)$/);
      if (trackMatch && req.method === 'POST') {
        const id = decodeURIComponent(trackMatch[1]);
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          return sendJson(req, res, cfg, 400, { error: '请求体不是合法 JSON' });
        }
        if (!body.status) return sendJson(req, res, cfg, 400, { error: '缺少 status 字段' });
        try {
          const rec = await store.setStatus(id, String(body.status), Object.hasOwn(body,'note') ? String(body.note) : undefined);
          return sendJson(req, res, cfg, 200, { ok: true, job: rec });
        } catch (e) {
          return sendJson(req, res, cfg, 400, { error: e.message, allowed: store.STATUSES });
        }
      }

      const exportMatch = pathname.match(/^\/api\/runs\/([^/]+)\/export$/);      if (exportMatch && req.method === 'GET') {
        const run = loadRun(exportMatch[1]);
        if (!run) return sendJson(req, res, cfg, 404, { error: '未找到该运行记录' });
        const format = url.searchParams.get('format') || 'json';
        const { body, ext, mime } = exportResult(run, format);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="jobs-${stamp}.${ext}"`,
          'Cache-Control': 'no-store',
          ...securityHeaders(req, cfg),
        });
        res.end(body);
        return;
      }

      /* ---------------- 静态资源 ---------------- */
      if (pathname.startsWith('/api/')) {
        return sendJson(req, res, cfg, 404, { error: `未知接口 ${req.method} ${pathname}` });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        return serveStatic(req, res, cfg, pathname);
      }

      return sendJson(req, res, cfg, 404, { error: '未知接口' });
    } catch (e) {
      if (!res.headersSent) {
        sendJson(req, res, cfg, 500, { error: e.message || String(e) });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });

  return { server, llm, gate, authRequired, exposure };
}

/* ------------------------------ 启动 ------------------------------ */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * 启动服务。抽成函数是为了让 start-public.mjs 等启动器也能复用，
 * 否则它们 import 本模块时 isMain 判定为 false，服务根本不会起来。
 */
export function startServer() {
  ensureDataDirs();
  const cfg = loadConfig();

  let ctx;
  try {
    ctx = createServer(cfg);
  } catch (e) {
    console.error('\n  ✖ 启动被拒绝\n');
    console.error('  ' + e.message.split('\n').join('\n  '));
    console.error('');
    process.exit(1);
  }

  const { server, gate, authRequired, exposure } = ctx;
  const port = Number(process.env.PORT) || cfg.server.port || 3210;
  const host = cfg.server.host || '127.0.0.1';

  server.listen(port, host, () => {
    const shown = cfg.server.publicUrl || `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │   简历岗位雷达 · Resume Job Radar            │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log('');
    console.log(`  访问地址：${shown}`);
    if (exposure.publicBind) {
      console.log(`  暴露范围：${host}（公网/局域网可达）`);
      console.log(`  鉴权状态：${authRequired ? '已启用密码登录' : '⚠ 未启用（已由 ALLOW_PUBLIC_NO_AUTH 显式放行）'}`);
      console.log(`  配额限制：并发 ${gate.maxConcurrent}，每日全站 ${gate.dailyGlobal} 次 / 每 IP ${gate.dailyPerIp} 次`);
      if (cfg.server.trustProxy) console.log('  代理信任：已开启（按 X-Forwarded-For 识别访客 IP）');
      else console.log('  代理信任：未开启（若部署在 nginx/Caddy 之后请设置 TRUST_PROXY=1，否则所有访客会被当成同一个 IP）');
    } else {
      console.log('  暴露范围：仅本机');
      console.log(`  鉴权状态：${authRequired ? '已启用密码登录' : '未启用（本地自用模式，auth.mode 可为 "none" 或留空口令）'}`);
    }
    console.log(`  DeepSeek：${cfg.deepseek.apiKey ? `已配置（${cfg.deepseek.model}，来源 ${cfg.__deepseekKeySource}）` : '未配置（将使用离线规则模式）'}`);
    console.log(`  全网搜索：${cfg.__activeSearchProvider || '未配置（仅使用智联/实习僧直连）'}`);
    console.log('');
    console.log('  按 Ctrl+C 停止服务');
    console.log('');
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  端口 ${port} 已被占用。请设置环境变量 PORT 换一个端口，例如：\n    set PORT=3211 && npm start\n`);
    } else {
      console.error('\n  服务启动失败：', e.message, '\n');
    }
    process.exit(1);
  });

  const shutdown = () => {
    console.log('\n  正在关闭服务…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, cfg, ctx };
}

if (isMain) startServer();
