// 本地 Web 服务：静态页面 + NDJSON 流式 API + 结果持久化/导出
// 公网部署形态：密码登录鉴权 + 安全响应头 + 并发与每日配额闸门
import http from "node:http";
import { assertInput } from "../public/js/validation-rules.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  ensureDataDirs,
  assertSafeExposure,
  ROOT,
  DATA_ROOT,
  IS_DESKTOP,
  maskKey,
} from "./config.mjs";
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
} from "./auth.mjs";
import { RunGate } from "./limits.mjs";
import { DeepSeek } from "./llm/deepseek.mjs";
import { extractResumeText, looksLikeResume } from "./resume/extract-text.mjs";
import { createApplicationContext } from "./application/context.mjs";
import { handleV2Request } from "./server/routes-v2.mjs";
import { handleV1Request } from "./server/routes-v1.mjs";
import { readJsonBody as readValidatedJsonBody } from "./server/validation.mjs";
import { VERSION } from "./version.mjs";
import { exportResult } from "./export.mjs";
import * as zhaopin from "./sources/zhaopin.mjs";
import * as shixiseng from "./sources/shixiseng.mjs";
import * as wechat from "./sources/wechat.mjs";
import * as nowcoder from "./sources/nowcoder.mjs";
import * as university from "./sources/university.mjs";
import * as chenyun from "./sources/chenyun.mjs";
import * as jiuyeqiao from "./sources/jiuyeqiao.mjs";
import * as store from "./store.mjs";
import { createDiagnosticsLog } from "./infrastructure/diagnostics/log.mjs";

const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_BODY = 40 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/* --------------------------- 响应工具 --------------------------- */

function securityHeaders(req, cfg, extra = {}) {
  const https = isSecureRequest(req, cfg.server.trustProxy);
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy":
      "geolocation=(), microphone=(), camera=(), payment=()",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...extra,
  };
  if (https)
    headers["Strict-Transport-Security"] =
      "max-age=31536000; includeSubDomains";
  return headers;
}

function sendJson(req, res, cfg, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...securityHeaders(req, cfg),
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体过大（>${(limit / 1048576).toFixed(0)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new Error(`请求体不是合法 JSON：${e.message}`);
  }
}

function serveStatic(req, res, cfg, pathname, { allowMissing = false } = {}) {
  const rel =
    pathname === "/"
      ? "index.html"
      : decodeURIComponent(pathname).replace(/^\/+/, "");
  const resolved = path.resolve(path.join(PUBLIC_DIR, rel));
  if (
    resolved !== path.resolve(PUBLIC_DIR) &&
    !resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep)
  ) {
    sendJson(req, res, cfg, 403, { error: "非法路径" });
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      if (allowMissing) {
        sendJson(req, res, cfg, 404, { error: "资源不存在" });
        return;
      }
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("404 Not Found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": MIME[".html"],
          ...securityHeaders(req, cfg),
        });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(resolved);
    // Stable asset URLs must revalidate when a new application version is installed.
    const cache = [".html", ".js", ".mjs", ".css"].includes(ext)
      ? "no-cache"
      : "public, max-age=300";
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cache,
      ...securityHeaders(req, cfg),
    });
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
    const host = String(req.headers.host || "").toLowerCase();
    if (o.host.toLowerCase() === host) return true;
    if (cfg.server.publicUrl) {
      try {
        if (
          new URL(cfg.server.publicUrl).host.toLowerCase() ===
          o.host.toLowerCase()
        )
          return true;
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

export function createServer(
  cfg,
  { dataDir = process.env.RJR_DATA_DIR || DATA_ROOT, dependencies = {} } = {},
) {
  const diagnostics =
    dependencies.diagnostics || createDiagnosticsLog({ dataDir });
  const llm = new DeepSeek(cfg);
  const exposure = assertSafeExposure(cfg);

  // 鉴权上下文：公网监听必须有口令；本地环回访问可免登录，方便自用
  const passwordHash = cfg.__envAuthPassword
    ? hashPassword(cfg.__envAuthPassword)
    : cfg.auth.passwordHash;
  const authRequired = cfg.auth.mode !== "none" && Boolean(passwordHash);
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
    storageFile: path.join(dataDir, "quota.json"),
  });

  const ready = createApplicationContext({
    cfg,
    dataDir,
    dependencies: { ...dependencies, diagnostics, runGate: gate },
  });
  ready.catch((error) => {
    void diagnostics.record(
      { operation: "http.request", stage: "startup" },
      error,
    );
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
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;
    const ip = clientIp(req, cfg.server.trustProxy);
    const secure = isSecureRequest(req, cfg.server.trustProxy);

    try {
      /* ---------------- 登录页（无需鉴权） ---------------- */
      if (pathname === "/login" && req.method === "GET") {
        return serveStatic(req, res, cfg, "/login.html", {
          allowMissing: true,
        });
      }

      /* ---------------- 会话状态（无需鉴权，供前端判断跳转） ---------------- */
      if (pathname === "/api/session" && req.method === "GET") {
        const authed = isAuthed(req);
        return sendJson(req, res, cfg, 200, {
          authenticated: authed,
          authRequired,
          exposure: exposure.publicBind ? "public" : "local",
          quota: authed ? gate.peek(ip) : null,
          allowUserKey: Boolean(cfg.deepseek.allowUserKey),
          // 桌面外壳据此切换交互：免登录、自带 Key 本地持久化、指向数据目录
          desktop: IS_DESKTOP,
          dataDir: IS_DESKTOP ? dataDir : undefined,
          deepseekConfigured: llm.available,
        });
      }

      /* ---------------- 登录 / 登出 ---------------- */
      if (pathname === "/api/login" && req.method === "POST") {
        if (!authRequired)
          return sendJson(req, res, cfg, 200, {
            ok: true,
            message: "当前未启用鉴权",
          });
        if (!originAllowed(req, cfg))
          return sendJson(req, res, cfg, 403, { error: "请求来源不被允许" });

        const guard = loginGuard.check(ip);
        if (!guard.allowed) {
          const mins = Math.ceil(guard.retryAfterMs / 60000);
          return sendJson(req, res, cfg, 429, {
            error: `登录尝试过于频繁，请 ${mins} 分钟后再试`,
          });
        }

        const body = await readJsonBody(req);
        assertInput("login", body);
        const password = body.password;

        if (!verifyPassword(password, passwordHash)) {
          const lockedUntil = loginGuard.fail(ip);
          const left = lockedUntil
            ? 0
            : Math.max(0, (Number(cfg.auth.maxLoginFails) || 5) - 1);
          return sendJson(req, res, cfg, 401, {
            code: "authentication_failed",
            fieldErrors: lockedUntil
              ? undefined
              : { password: "访问密码不正确，请核对后重试。" },
            error: lockedUntil
              ? "密码错误次数过多，账号已临时锁定"
              : `密码错误${left ? `，还可尝试 ${left} 次` : ""}`,
          });
        }

        loginGuard.succeed(ip);
        const { token } = sessions.issue({ ip });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": buildSetCookie(sessions.cookieName, token, {
            maxAge: sessions.ttlMs,
            secure,
          }),
          "Cache-Control": "no-store",
          ...securityHeaders(req, cfg),
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (pathname === "/api/logout" && req.method === "POST") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": clearCookie(sessions.cookieName),
          "Cache-Control": "no-store",
          ...securityHeaders(req, cfg),
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      /* ---------------- 健康检查 ---------------- */
      if (pathname === "/api/health" && req.method === "GET") {
        const authed = isAuthed(req);
        const base = {
          ok: true,
          version: VERSION,
          authRequired,
          authenticated: authed,
        };
        if (!authed) return sendJson(req, res, cfg, 200, base);
        return sendJson(req, res, cfg, 200, {
          ...base,
          exposure: exposure.publicBind ? "public" : "local",
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
            zhaopin: {
              enabled: cfg.sources.zhaopin.enabled,
              name: zhaopin.meta.name,
              maxPages: cfg.sources.zhaopin.maxPages,
            },
            shixiseng: {
              enabled: cfg.sources.shixiseng.enabled,
              name: shixiseng.meta.name,
              maxPages: cfg.sources.shixiseng.maxPages,
            },
            nowcoder: {
              enabled: cfg.sources.nowcoder?.enabled !== false,
              name: nowcoder.meta.name,
            },
            university: {
              enabled: cfg.sources.university?.enabled !== false,
              name: university.meta.name,
              hosts:
                (cfg.sources.university?.hosts?.length || 0) +
                university.DEFAULT_HOSTS.length,
            },
            chenyun: {
              enabled: cfg.sources.chenyun?.enabled !== false,
              name: chenyun.meta.name,
              hosts:
                (cfg.sources.chenyun?.hosts?.length || 0) +
                chenyun.CHENYUN_HOSTS.length,
            },
            jiuyeqiao: {
              enabled: cfg.sources.jiuyeqiao?.enabled !== false,
              name: jiuyeqiao.meta.name,
            },
            wechat: {
              enabled: cfg.sources.wechat?.enabled !== false,
              name: wechat.meta.name,
              maxQueries: cfg.sources.wechat?.maxQueries,
            },
            searchApi: {
              enabled: cfg.sources.searchApi.enabled,
              maxQueries: cfg.sources.searchApi.maxQueries,
            },
          },
          match: cfg.match,
          filters: cfg.filters,
          quota: gate.peek(ip),
        });
      }

      /* ---------------- 以下接口全部需要鉴权 ---------------- */
      if (pathname.startsWith("/api/") && !isAuthed(req)) {
        return sendJson(req, res, cfg, 401, {
          error: "未登录或登录已过期，请先登录",
          needLogin: true,
        });
      }
      if (pathname === "/" && authRequired && !isAuthed(req)) {
        res.writeHead(302, {
          Location: "/login",
          ...securityHeaders(req, cfg),
        });
        return res.end();
      }
      // 变更类请求做来源校验
      if (
        ["POST", "DELETE", "PUT", "PATCH"].includes(req.method) &&
        !originAllowed(req, cfg)
      ) {
        return sendJson(req, res, cfg, 403, { error: "请求来源不被允许" });
      }

      if (pathname.startsWith("/api/")) {
        const app = await ready;
        const context = {
          ...app,
          http: {
            json: (request, response, status, data) =>
              sendJson(request, response, cfg, status, data),
            readJson: readValidatedJsonBody,
            ip: (request) => clientIp(request, cfg.server.trustProxy),
          },
        };
        for (const [name, value] of Object.entries(securityHeaders(req, cfg)))
          res.setHeader(name, value);
        if (
          (await handleV2Request(req, res, context)) ||
          (await handleV1Request(req, res, context))
        )
          return;
      }

      /* ---------------- 静态资源 ---------------- */
      if (pathname.startsWith("/api/")) {
        return sendJson(req, res, cfg, 404, {
          error: `未知接口 ${req.method} ${pathname}`,
        });
      }
      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(req, res, cfg, pathname);
      }

      return sendJson(req, res, cfg, 404, { error: "未知接口" });
    } catch (e) {
      const diagnosticId =
        e.diagnosticId ||
        (await diagnostics.record({ operation: "http.request" }, e))
          .diagnosticId;
      if (!res.headersSent) {
        const storage = /ENOSPC|EACCES|EPERM|EROFS/.test(e.code || "");
        const status =
          e.status ||
          (storage
            ? 500
            : /not found|未找到|does not exist/i.test(e.message)
              ? 404
              : /Invalid|Private|Missing|forbidden|required|referenced|mismatch/i.test(
                    e.message,
                  )
                ? 400
                : 500);
        sendJson(req, res, cfg, status, {
          error: storage
            ? "存储写入失败，请检查可用空间和目录写入权限后重试。"
            : status >= 500
              ? "服务处理失败，请稍后重试；如持续出现，请提供错误编号。"
              : e.message || "请求未通过检查。",
          code: storage
            ? "storage_write_failed"
            : status >= 500
              ? "system_error"
              : e.code || "request_failed",
          ...(e.fieldErrors && status < 500
            ? { fieldErrors: e.fieldErrors }
            : {}),
          diagnosticId,
        });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });

  return { server, llm, gate, authRequired, exposure, ready, diagnostics };
}

/* ------------------------------ 启动 ------------------------------ */
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

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
    console.error("\n  ✖ 启动被拒绝\n");
    console.error("  " + e.message.split("\n").join("\n  "));
    console.error("");
    process.exit(1);
  }

  const { server, gate, authRequired, exposure } = ctx;
  const port = Number(process.env.PORT) || cfg.server.port || 3210;
  const host = cfg.server.host || "127.0.0.1";

  server.listen(port, host, () => {
    const shown =
      cfg.server.publicUrl ||
      `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
    console.log("");
    console.log("  ┌──────────────────────────────────────────────┐");
    console.log("  │   简历岗位雷达 · Resume Job Radar            │");
    console.log("  └──────────────────────────────────────────────┘");
    console.log("");
    console.log(`  访问地址：${shown}`);
    if (exposure.publicBind) {
      console.log(`  暴露范围：${host}（公网/局域网可达）`);
      console.log(
        `  鉴权状态：${authRequired ? "已启用密码登录" : "⚠ 未启用（已由 ALLOW_PUBLIC_NO_AUTH 显式放行）"}`,
      );
      console.log(
        `  配额限制：并发 ${gate.maxConcurrent}，每日全站 ${gate.dailyGlobal} 次 / 每 IP ${gate.dailyPerIp} 次`,
      );
      if (cfg.server.trustProxy)
        console.log("  代理信任：已开启（按 X-Forwarded-For 识别访客 IP）");
      else
        console.log(
          "  代理信任：未开启（若部署在 nginx/Caddy 之后请设置 TRUST_PROXY=1，否则所有访客会被当成同一个 IP）",
        );
    } else {
      console.log("  暴露范围：仅本机");
      console.log(
        `  鉴权状态：${authRequired ? "已启用密码登录" : '未启用（本地自用模式，auth.mode 可为 "none" 或留空口令）'}`,
      );
    }
    console.log(
      `  DeepSeek：${cfg.deepseek.apiKey ? `已配置（${cfg.deepseek.model}，来源 ${cfg.__deepseekKeySource}）` : "未配置（将使用离线规则模式）"}`,
    );
    console.log(
      `  全网搜索：${cfg.__activeSearchProvider || "未配置（仅使用智联/实习僧直连）"}`,
    );
    console.log("");
    console.log("  按 Ctrl+C 停止服务");
    console.log("");
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `\n  端口 ${port} 已被占用。请设置环境变量 PORT 换一个端口，例如：\n    set PORT=3211 && npm start\n`,
      );
    } else {
      console.error("\n  服务启动失败：", e.message, "\n");
    }
    process.exit(1);
  });

  const shutdown = () => {
    console.log("\n  正在关闭服务…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, cfg, ctx };
}

if (isMain) startServer();
