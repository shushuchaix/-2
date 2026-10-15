// 公网部署所需的鉴权基础件：密码哈希、会话签名、登录限速、客户端 IP 解析
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DATA_ROOT } from './config.mjs';
import { publishOwnedFileLockSync, reclaimDeadFileLockSync } from './infrastructure/storage/lock.mjs';

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
    // A zero-length derived key compares equal for every password. Only accept
    // the complete salt/digest shape emitted by hashPassword, before doing KDF work.
    if (salt.length !== 16 || expected.length !== SCRYPT.keylen) return false;
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
 * HMAC 会话；HTTP 路径额外要求随机 SID 存在于有界、签名的注册表。
 * credential 只参与服务端密钥派生，不把可离线猜测的口令摘要放进 token。
 * 不传 storageFile 时保持纯内存依赖，便于隔离单元测试。
 */
export class SessionManager {
  constructor({ secret, credential = '', ttlMs = 7 * 24 * 3600 * 1000, dataDir = DATA_ROOT, storageFile, maxSessions = 20000 } = {}) {
    const rootSecret = secret || (storageFile ? loadOrCreateSecret(dataDir) : crypto.randomBytes(32));
    this.secret = credential
      ? crypto.createHmac('sha256', rootSecret).update('rjr-session-credential-v2\0').update(String(credential)).digest()
      : rootSecret;
    this.ttlMs = ttlMs;
    this.cookieName = 'rjr_session';
    this.storageFile = storageFile;
    this.maxSessions = Number.isSafeInteger(maxSessions) && maxSessions > 0 ? maxSessions : 20000;
    this.keyId = this._sign('rjr-session-registry-key-id-v1');
  }

  issue(extra = {}) {
    const payload = { ...extra, sid: crypto.randomBytes(16).toString('hex'), iat: Date.now(), exp: Date.now() + this.ttlMs };
    const body = b64url(JSON.stringify(payload));
    const sig = this._sign(body);
    if (this.storageFile) this._updateRegistry((sessions) => {
      if (sessions.size >= this.maxSessions) throw authError('auth_session_capacity', '登录会话已达上限，请退出闲置会话后重试。');
      sessions.set(payload.sid, payload.exp);
    }, { recover: true });
    return { token: `${body}.${sig}`, payload };
  }

  verify(token) {
    const payload = this._verifySignature(token);
    if (!payload) return null;
    if (this.storageFile) {
      try {
        if (this._readRegistry().get(payload.sid) !== payload.exp) return null;
      } catch { return null; }
    }
    return payload;
  }

  revoke(token) {
    const payload = this._verifySignature(token);
    if (!payload || !this.storageFile) return false;
    this._updateRegistry((sessions) => sessions.delete(payload.sid));
    return true;
  }

  _sign(body) {
    return b64url(crypto.createHmac('sha256', this.secret).update(body).digest());
  }

  _verifySignature(token) {
    if (!token || typeof token !== 'string' || token.length > 16384) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this._sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!/^[a-f0-9]{32}$/.test(payload?.sid || '') || !Number.isSafeInteger(payload.exp) || Date.now() >= payload.exp) return null;
    return payload;
  }

  _readRegistry() {
    let state;
    try {
      if (fs.statSync(this.storageFile).size > this.maxSessions * 100 + 4096) throw Error('invalid');
      state = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      if (['EACCES', 'EPERM', 'EISDIR', 'EIO'].includes(error.code)) throw error;
      throw authError('auth_session_registry_invalid', '登录会话记录未通过检查，请重新登录。');
    }
    const data = { version: state?.version, keyId: state?.keyId, sessions: state?.sessions };
    const valid = state?.version === 1 && state.keyId === this.keyId && Array.isArray(state.sessions) && state.sessions.length <= this.maxSessions;
    if (!valid || !equalSignature(state.signature, this._sign(JSON.stringify(data))))
      throw authError('auth_session_registry_invalid', '登录会话记录未通过检查，请重新登录。');
    const sessions = new Map();
    for (const item of state.sessions) {
      if (!Array.isArray(item) || item.length !== 2 || !/^[a-f0-9]{32}$/.test(item[0]) || !Number.isSafeInteger(item[1]) || sessions.has(item[0]))
        throw authError('auth_session_registry_invalid', '登录会话记录未通过检查，请重新登录。');
      if (item[1] > Date.now()) sessions.set(item[0], item[1]);
    }
    return sessions;
  }

  _updateRegistry(update, { recover = false } = {}) {
    fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
    const lockFile = this.storageFile + '.lock';
    const nonce = crypto.randomBytes(16).toString('hex');
    try {
      publishOwnedFileLockSync(lockFile, { pid: process.pid, nonce });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      reclaimDeadFileLockSync(lockFile);
      try { publishOwnedFileLockSync(lockFile, { pid: process.pid, nonce }); } catch (retry) {
        if (retry.code === 'EEXIST') throw authError('auth_session_busy', '登录会话正在保存，或存在归属不明的旧锁；请稍后重试并保留旧锁供排查。');
        throw retry;
      }
    }
    let temp;
    try {
      let sessions;
      try { sessions = this._readRegistry(); } catch (error) {
        // Only a newly authenticated login may recover a corrupt/rotated registry.
        // Rebuild empty so none of its old SID entries can become valid again.
        if (!recover || error.code !== 'auth_session_registry_invalid') throw error;
        sessions = new Map();
      }
      update(sessions);
      const data = { version: 1, keyId: this.keyId, sessions: [...sessions] };
      const content = JSON.stringify({ ...data, signature: this._sign(JSON.stringify(data)) });
      temp = this.storageFile + '.' + nonce + '.tmp';
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.storageFile);
      temp = undefined;
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
      fs.unlinkSync(lockFile);
    }
  }
}

function authError(code, message) { return Object.assign(Error(message), { code, status: 503 }); }
function equalSignature(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function loadOrCreateSecret(dataDir) {
  const file = path.join(dataDir, '.session-secret');
  try {
    return readSessionSecret(file);
  } catch (error) {
    // Only absence means first initialization. Never replace an unreadable or
    // corrupt existing root key, and never silently fall back to an in-memory key.
    if (error.code !== 'ENOENT') throw sessionSecretFailure(error);
  }
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(16).toString('hex') + '.tmp';
  let fd, created = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, crypto.randomBytes(32).toString('base64url'), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      // link is an atomic no-replace publication of an already complete file.
      // Opening the destination with wx then writing would expose a partial key.
      fs.linkSync(temp, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // Both the publisher and every contender read the same published root key.
    return readSessionSecret(file);
  } catch (error) {
    throw sessionSecretFailure(error);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.unlinkSync(temp);
  }
}
function readSessionSecret(file) {
  const secret = fs.readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, 'base64url').toString('base64url') !== secret)
    throw authError('auth_secret_invalid', '会话签名密钥不完整或已损坏，请保留原文件并检查配置，或设置 AUTH_SECRET。');
  return secret;
}
function sessionSecretFailure(error) {
  if (error.code === 'auth_secret_invalid') return error;
  return Object.assign(authError('auth_secret_unavailable', '无法安全读取或初始化会话签名密钥，请检查数据目录权限和文件系统，或设置 AUTH_SECRET。'), { cause: error });
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
    if (!k || ['__proto__', 'prototype', 'constructor'].includes(k)) continue;
    try { out[k] = decodeURIComponent(v); } catch { /* Ignore only the malformed cookie. */ }
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
  constructor({ maxFails = 5, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000, maxRecords = 20000, globalMaxFails = maxFails * 20, globalWindowMs = windowMs, now = Date.now } = {}) {
    this.maxFails = maxFails;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.records = new Map();
    this.maxRecords = Math.max(1, Number(maxRecords) || 20000);
    this.globalMaxFails = Math.max(1, Number(globalMaxFails) || maxFails * 20);
    this.globalWindowMs = globalWindowMs;
    this.globalFails = [];
    this.globalLockedUntil = 0;
    this.now = now;
  }

  _rec(ip) {
    let r = this.records.get(ip);
    if (!r) {
      if (this.records.size >= this.maxRecords) this.sweep();
      if (this.records.size >= this.maxRecords) return null;
      r = { fails: 0, firstAt: this.now(), lockedUntil: 0 };
      this.records.set(ip, r);
    }
    return r;
  }

  /** 返回 { allowed, retryAfterMs } */
  check(ip) {
    const now = this.now();
    if (this.globalLockedUntil > now) return { allowed: false, retryAfterMs: this.globalLockedUntil - now };
    this.globalFails = this.globalFails.filter(at => now - at < this.globalWindowMs);
    const r = this.records.get(ip);
    if (!r) {
      if (this.records.size >= this.maxRecords) this.sweep();
      return { allowed: this.records.size < this.maxRecords, retryAfterMs: this.records.size < this.maxRecords ? 0 : Math.max(this.windowMs, this.lockMs) };
    }
    if (r.lockedUntil > now) return { allowed: false, retryAfterMs: r.lockedUntil - now };
    if (now - r.firstAt > this.windowMs) {
      r.fails = 0;
      r.firstAt = now;
      r.lockedUntil = 0;
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(ip) {
    const now = this.now();
    if (this.globalLockedUntil > now) return this.globalLockedUntil;
    this.globalFails = this.globalFails.filter(at => now - at < this.globalWindowMs);
    this.globalFails.push(now);
    if (this.globalFails.length >= this.globalMaxFails) {
      this.globalLockedUntil = now + this.lockMs;
      this.globalFails = [];
    }
    const r = this._rec(ip);
    if (!r) return now + Math.max(this.windowMs, this.lockMs);
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
    const now = this.now();
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
export function clientIp(req, trustProxy = false, trustedHops = 1) {
  const remote = normalizeIp(req.socket?.remoteAddress || 'unknown');
  if (trustProxy) {
    if (!Number.isSafeInteger(trustedHops) || trustedHops < 1 || trustedHops > 10) return remote;
    const xff = req.headers?.['x-forwarded-for'];
    if (xff !== undefined) {
      if (typeof xff !== 'string') return remote;
      const chain = xff.split(',').map(value => value.trim());
      // Select only the address added at the explicitly trusted hop boundary.
      // Never fall back to a second header after a malformed forwarding chain.
      const value = chain[chain.length - trustedHops];
      return value && net.isIP(value) ? normalizeIp(value) : remote;
    }
    const xri = req.headers?.['x-real-ip'];
    if (trustedHops === 1 && typeof xri === 'string' && net.isIP(xri.trim())) return normalizeIp(xri.trim());
  }
  return remote;
}

function normalizeIp(ip) {
  if (!ip) return 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isSecureRequest(req, trustProxy = false) {
  if (req.socket?.encrypted) return true;
  // Shipped nginx/Caddy configs overwrite this header with one protocol value.
  // Ambiguous lists are not proof of a secure client connection.
  if (trustProxy && req.headers?.['x-forwarded-proto'] === 'https') return true;
  return false;
}

/** 判断是否为环回地址（用于「本地开发可免鉴权」的判定） */
export function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
