// HTML / 内嵌数据 解析工具（零依赖）
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', times: '×', copy: '©', reg: '®',
  deg: '°', yen: '¥', euro: '€', pound: '£', bull: '•', dagger: '†',
};

function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * 解码 HTML 实体（含数字实体与常见命名实体）。
 * 注意：分号是可选的 —— 实习僧等站点的图标字体实体写作 `&#xe26c` 而非 `&#xe26c;`，
 * 强制要求分号会导致这类实体被漏解，进而把整段文本误判为「无私有区字符」。
 */
export function decodeEntities(s = '') {
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]{2,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = hex ? parseInt(digits, 16) : parseInt(digits, 10);
      if (!Number.isFinite(code)) return m;
      const ch = safeFromCodePoint(code);
      return ch || m;
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** 去掉 Unicode 私有区字符（图标字体的 &#xf69b 之类，避免污染正文） */
export function stripPrivateUse(s = '') {
  return String(s)
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/[\u{F0000}-\u{FFFFD}]/gu, '')
    .replace(/[\u{100000}-\u{10FFFD}]/gu, '');
}

/** HTML → 纯文本 */
export function htmlToText(html = '') {
  const noScript = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return stripPrivateUse(decodeEntities(noScript))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * 从 startIdx 起截取括号配平的表达式片段（支持 () [] {} 混合、字符串与转义）
 * 用于提取 `window.__X__ = {...}` / `(function(){...})(...)` 这类内嵌数据。
 */
export function balancedFrom(text, startIdx) {
  const openers = '([{';
  const closers = ')]}';
  let depth = 0;
  let i = startIdx;
  let inStr = false;
  let quote = '';
  let esc = false;
  let started = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = true;
      quote = c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (openers.includes(c)) {
      depth++;
      started = true;
    } else if (closers.includes(c)) {
      depth--;
      if (started && depth === 0) {
        i++;
        break;
      }
      if (depth < 0) break;
    }
  }
  return text.slice(startIdx, i);
}

/** 提取 `变量名 = <JSON>` 并解析 */
export function extractAssignedJson(html, varName) {
  const re = new RegExp(`${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*`, '');
  const m = re.exec(html);
  if (!m) return null;
  const raw = balancedFrom(html, m.index + m[0].length);
  try {
    return JSON.parse(raw.replace(/;\s*$/, ''));
  } catch {
    return null;
  }
}

/**
 * 按标签配平取出指定 id 的元素「内容」。
 *
 * 为什么不能用正则：`<div id="js_content">([\s\S]*?)<\/div>` 这种非贪婪写法
 * 会被正文里的第一个嵌套 </div> 提前截断 —— 微信文章正文因此只抓到几百字的页头。
 * 必须做开闭标签计数扫描才能拿到完整内容。
 */
export function extractElementById(html, id, tag = 'div') {
  const open = new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const m = open.exec(html);
  if (!m) return '';
  const start = m.index + m[0].length;
  let depth = 1;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = start;
  let t;
  while ((t = tagRe.exec(html))) {
    if (t[1] === '/') {
      depth--;
      if (depth === 0) return html.slice(start, t.index);
    } else {
      depth++;
    }
  }
  return html.slice(start);
}

/**
 * 求值 Nuxt 风格的内嵌载荷：`window.__NUXT__=(function(a,b,...){...})(...args)`
 * 该类载荷是「函数序列化 + 参数压缩」形式，需要真正执行才能还原。
 */
export function evalInlinePayload(html, varName = '__NUXT__') {
  const re = new RegExp(`${varName}\\s*=\\s*`);
  const m = re.exec(html);
  if (!m) return null;
  let startIdx = m.index + m[0].length;
  while (/\s/.test(html[startIdx] || '')) startIdx++;
  const expr = balancedFrom(html, startIdx);
  if (!expr || expr.length > 4_000_000) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`"use strict";return (${expr.replace(/;\s*$/, '')});`)();
  } catch {
    return null;
  }
}

/** 相对 URL 转绝对 URL */
export function absoluteUrl(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** 网页文本里的日期归一化：返回 YYYY-MM-DD 或原串 */
export function normalizeDate(s) {
  if (!s) return '';
  const str = String(s);
  const m = str.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const m2 = str.match(/(\d{1,2})[-/月.](\d{1,2})/);
  if (m2) {
    const y = new Date().getFullYear();
    return `${y}-${String(m2[1]).padStart(2, '0')}-${String(m2[2]).padStart(2, '0')}`;
  }
  return '';
}

/** 从相对时间描述推断日期（"3天前发布" / "今天"） */
export function parseRelativeDate(s) {
  if (!s) return '';
  const str = String(s);
  const now = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (/今天|刚刚|今日/.test(str)) return fmt(now);
  if (/昨天/.test(str)) return fmt(new Date(now.getTime() - 864e5));
  const m = str.match(/(\d+)\s*(天|日|周|个月|月|小时)前/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit === '小时' ? 36e5 : unit === '天' || unit === '日' ? 864e5 : unit === '周' ? 6048e5 : 2592e6;
    return fmt(new Date(now.getTime() - n * ms));
  }
  return normalizeDate(str);
}
