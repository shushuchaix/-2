// 运行闸门：限制并发与每日配额，防止公网部署下被刷爆 API 额度或把抓取能力当免费代理
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './config.mjs';

const FILE = path.join(DATA_ROOT, 'quota.json');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class RunGate {
  constructor({
    maxConcurrent = 2,
    maxQueue = 8,
    dailyGlobal = 100,
    dailyPerIp = 10,
    perIpCooldownMs = 30000,
    // 配额落盘可防止「重启服务即重置额度」的绕过；测试可关掉或另指定文件
    persist = true,
    storageFile = FILE,
  } = {}) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxQueue = Math.max(0, maxQueue);
    this.dailyGlobal = dailyGlobal;
    this.dailyPerIp = dailyPerIp;
    this.perIpCooldownMs = perIpCooldownMs;
    this.persist = persist;
    this.file = storageFile;

    this.active = 0;
    this.queue = [];
    this.lastRunByIp = new Map();
    this.counters = this._load();
  }

  _load() {
    if (!this.persist) return { date: today(), global: 0, byIp: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.date === today()) return raw;
    } catch {
      /* 首次或跨天 */
    }
    return { date: today(), global: 0, byIp: {} };
  }

  _save() {
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.counters), 'utf8');
    } catch {
      /* 配额持久化失败不影响主流程 */
    }
  }

  _rollover() {
    const d = today();
    if (this.counters.date !== d) {
      this.counters = { date: d, global: 0, byIp: {} };
      this._save();
    }
  }

  /** 只检查不占位，用于前端展示剩余额度 */
  peek(ip) {
    this._rollover();
    return {
      remainingGlobal: Math.max(0, this.dailyGlobal - this.counters.global),
      remainingIp: Math.max(0, this.dailyPerIp - (this.counters.byIp[ip] || 0)),
      dailyGlobal: this.dailyGlobal,
      dailyPerIp: this.dailyPerIp,
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  /**
   * 申请一次运行许可。
   * 立即返回 { ok:true, release } 或 { ok:false, status, reason, retryAfterMs }
   */
  acquire(ip) {
    this._rollover();

    // 每日全局配额
    if (this.counters.global >= this.dailyGlobal) {
      return { ok: false, status: 429, reason: `全站今日检索额度已用完（${this.dailyGlobal} 次/天），请明天再来`, retryAfterMs: msUntilTomorrow() };
    }
    // 每 IP 每日配额
    if ((this.counters.byIp[ip] || 0) >= this.dailyPerIp) {
      return { ok: false, status: 429, reason: `你的今日检索次数已用完（${this.dailyPerIp} 次/天），请明天再来`, retryAfterMs: msUntilTomorrow() };
    }
    // 同一 IP 冷却
    const last = this.lastRunByIp.get(ip) || 0;
    if (Date.now() - last < this.perIpCooldownMs) {
      const wait = Math.ceil((this.perIpCooldownMs - (Date.now() - last)) / 1000);
      return { ok: false, status: 429, reason: `请求过于频繁，请 ${wait} 秒后再试`, retryAfterMs: this.perIpCooldownMs - (Date.now() - last) };
    }
    // 队列上限
    if (this.active >= this.maxConcurrent && this.queue.length >= this.maxQueue) {
      return { ok: false, status: 503, reason: '当前排队人数过多，请稍后再试', retryAfterMs: 30000 };
    }

    this.counters.global++;
    this.counters.byIp[ip] = (this.counters.byIp[ip] || 0) + 1;
    this.lastRunByIp.set(ip, Date.now());
    this._save();

    const ticket = this._enqueue();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this._dequeue(ticket);
    };
    return { ok: true, ticket, release, queued: Math.max(0, ticket.position) };
  }

  /**
   * 入队。ticket.position === 0 表示立即拿到执行名额；
   * 否则进入 FIFO 队列，position 为前面还有几个任务。
   */
  _enqueue() {
    const ticket = { position: 0 };
    if (this.active < this.maxConcurrent) {
      this.active++;
      ticket.position = 0;
    } else {
      this.queue.push(ticket);
      ticket.position = this.queue.length;
    }
    return ticket;
  }

  _dequeue(ticket) {
    const idx = this.queue.indexOf(ticket);
    if (idx >= 0) {
      // 还在排队，从未占用名额：移出即可，名额不受影响
      this.queue.splice(idx, 1);
      this.queue.forEach((t, i) => (t.position = i + 1));
      return;
    }
    // 正持有名额：把名额交给队首，否则才真正释放
    const next = this.queue.shift();
    if (next) {
      next.position = 0;
      this.queue.forEach((t, i) => (t.position = i + 1));
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  /** 阻塞直到该 ticket 拿到执行名额 */
  async waitTurn(ticket, onWait = () => {}, signal) {
    let notified = -1;
    while (ticket.position > 0) {
      if (signal?.aborted) {
        this._dequeue(ticket);
        throw new Error('已取消');
      }
      if (ticket.position !== notified) {
        notified = ticket.position;
        onWait(ticket.position);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return true;
  }
}

function msUntilTomorrow() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}
