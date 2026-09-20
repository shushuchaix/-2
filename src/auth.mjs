// 公网部署所需的鉴权基础件：密码哈希、会话签名、登录限速、客户端 IP 解析
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './config.mjs';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

/* ----------------------------- 密码 ----------------------------- */

/** 生成 `scrypt$N$r$p$salt$hash` 格式的密码哈希 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** 常量时间校验密码 */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ----------------------------- 会话 ----------------------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * 会话管理：HMAC-SHA256 签名的无状态 token。
 * 密钥优先取 AUTH_SECRET，否则在 data/ 下生成并持久化，
 * 避免每次重启把所有人踢下线。
 */
export class SessionManager {
  constructor({ secret, ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
    this.secret = secret || loadOrCreateSecret();
    this.ttlMs = ttlMs;
    this.cookieName = 'rjr_session';
  }

  issue(extra = {}) {
    const payload = { sid: crypto.randomBytes(16).toString('hex'), iat: Date.now(), exp: Date.now() + this.ttlMs, ...extra };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', this.secret).update(body).digest());
    return { token: `${body}.${sig}`, payload };
  }

  verify(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64url(crypto.createHmac('sha256', this.secret).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  }
}

function loadOrCreateSecret() {
  const file = path.join(DATA_ROOT, '.session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 首次生成 */
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* 写不了就用内存态密钥（重启后需重新登录） */
  }
  return secret;
}

/* --------------------------- Cookie --------------------------- */

export function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function buildSetCookie(name, value, { maxAge, secure, path: p = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) bits.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* --------------------------- 登录限速 --------------------------- */

/** 按 IP 统计失败次数，超限后锁定一段时间，抵抗暴力破解 */
export class LoginGuard {
  constructor({ maxFails = 5, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
    this.maxFails = maxFails;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.records = new Map();
  }

  _rec(ip) {
    let r = this.records.get(ip);
    if (!r) {
      r = { fails: 0, firstAt: Date.now(), lockedUntil: 0 };
      this.records.set(ip, r);
    }
    return r;
  }

  /** 返回 { allowed, retryAfterMs } */
  check(ip) {
    const r = this._rec(ip);
    const now = Date.now();
    if (r.lockedUntil > now) return { allowed: false, retryAfterMs: r.lockedUntil - now };
    if (now - r.firstAt > this.windowMs) {
      r.fails = 0;
      r.firstAt = now;
      r.lockedUntil = 0;
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(ip) {
    const r = this._rec(ip);
    const now = Date.now();
    if (now - r.firstAt > this.windowMs) {
      r.fails = 0;
      r.firstAt = now;
    }
    r.fails++;
    if (r.fails >= this.maxFails) {
      r.lockedUntil = now + this.lockMs;
      r.fails = 0;
      r.firstAt = now;
    }
    return r.lockedUntil;
  }

  succeed(ip) {
    this.records.delete(ip);
  }

  /** 清理过期记录，避免内存无限增长 */
  sweep() {
    const now = Date.now();
    for (const [ip, r] of this.records) {
      if (r.lockedUntil < now && now - r.firstAt > this.windowMs) this.records.delete(ip);
    }
  }
}

/* ------------------------- 客户端 IP / HTTPS ------------------------- */

/**
 * 解析客户端 IP。
 * 只有在显式信任反向代理时才读取 X-Forwarded-For —— 否则任何人都能伪造该头，
 * 从而绕过基于 IP 的限流与配额。
 */
export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
    const xri = req.headers['x-real-ip'];
    if (xri) return normalizeIp(String(xri).trim());
  }
  return normalizeIp(req.socket?.remoteAddress || 'unknown');
}

function normalizeIp(ip) {
  if (!ip) return 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isSecureRequest(req, trustProxy = false) {
  if (req.socket?.encrypted) return true;
  if (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return false;
}

/** 判断是否为环回地址（用于「本地开发可免鉴权」的判定） */
export function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === 'unknown';
}
