// 文本归一化与岗位去重
import { decodeEntities, stripPrivateUse } from './html.mjs';

/**
 * 字段清洗：解码 HTML 实体 + 去掉图标字体私有区字符 + 压缩空白。
 * 招聘站常用图标字体渲染薪资/规模，会在数据里留下 &#xf69b 这类噪声。
 */
export function sanitizeText(s = '') {
  return stripPrivateUse(decodeEntities(String(s ?? '')))
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}

/** 归一化用于比较的字符串：去空白、标点、全角转半角、转小写 */
export function normKey(s = '') {
  return String(s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[()[\]{}（）【】《》<>「」『』,，.。;；:：!！?？'"“”‘’`~～@#$%^&*_+=|\\/、\-—–]/g, '')
    .toLowerCase();
}

/** 清洗岗位标题：去实体噪声与常见前缀后缀 */
export function cleanTitle(title = '') {
  return sanitizeText(title)
    .replace(/^[\[【(（]\s*(急招|热招|高薪|急聘|诚聘)\s*[\]】)）]\s*/g, '')
    .replace(/[\s\-_|·]+$/g, '')
    .trim();
}

/** 城市名归一化：'省-石家庄市' → '石家庄'；'北京 朝阳 朝外' → '北京' */
export function normCity(raw = '') {
  let s = String(raw).trim();
  if (!s) return '';
  if (s.includes('-')) {
    const parts = s.split('-').map((x) => x.trim()).filter(Boolean);
    s = parts[parts.length - 1] || s;
  }
  s = s.split(/[\s,，/]+/)[0] || s;
  s = s.replace(/[市省区县]$/g, '');
  return s.replace(/自治州$|地区$|特别行政区$/, '').trim();
}

/** 大区归一：把区县合并回主要城市（用于城市匹配） */
const CITY_ALIAS = new Map(Object.entries({
  北京市: '北京', 上海市: '上海', 天津市: '天津', 重庆市: '重庆',
  深圳市: '深圳', 广州市: '广州', 杭州市: '杭州', 南京市: '南京',
  成都市: '成都', 武汉市: '武汉', 西安市: '西安', 苏州市: '苏州',
  长沙市: '长沙', 郑州市: '郑州', 青岛市: '青岛', 合肥市: '合肥',
  厦门市: '厦门', 宁波市: '宁波', 无锡市: '无锡', 佛山市: '佛山',
}));

export function cityCanon(raw = '') {
  const c = normCity(raw);
  return CITY_ALIAS.get(c) || CITY_ALIAS.get(c + '市') || c;
}

/** 判断岗位城市是否命中用户偏好（含"全国/不限/远程"视为命中） */
export function cityMatches(jobCity, preferred = []) {
  const jc = cityCanon(jobCity);
  if (!jc) return true;
  if (/全国|不限|远程|remote/i.test(String(jobCity))) return true;
  if (!preferred || preferred.length === 0) return true;
  return preferred.some((p) => {
    const pc = cityCanon(p);
    if (!pc) return false;
    return jc === pc || jc.includes(pc) || pc.includes(jc);
  });
}

/** 岗位唯一键：优先用 URL，其次 公司+标题 */
export function jobKey(job) {
  const url = (job.url || '').split('?')[0].replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (url && !/^www\.(zhaopin|shixiseng)\.com$/.test(url)) return `u:${url}`;
  return `t:${normKey(job.company)}|${normKey(job.title)}|${cityCanon(job.city)}`;
}

/** 标题相似度（基于字符 bigram Jaccard），用于合并"同岗不同源" */
export function titleSimilarity(a, b) {
  const A = normKey(a);
  const B = normKey(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return A === B ? 1 : 0;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/**
 * 岗位去重合并：
 *  1) URL 完全一致 → 合并
 *  2) 同公司 + 标题相似度 ≥ 0.82 → 合并（保留信息更全的一条，来源标记为多源）
 */
export function dedupeJobs(jobs) {
  const byUrl = new Map();
  const kept = [];
  for (const j of jobs) {
    const key = jobKey(j);
    if (byUrl.has(key)) {
      mergeInto(byUrl.get(key), j);
      continue;
    }
    byUrl.set(key, j);
    kept.push(j);
  }

  const out = [];
  const used = new Array(kept.length).fill(false);
  for (let i = 0; i < kept.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const base = kept[i];
    for (let k = i + 1; k < kept.length; k++) {
      if (used[k]) continue;
      const other = kept[k];
      if (normKey(base.company) && normKey(base.company) === normKey(other.company) && titleSimilarity(base.title, other.title) >= 0.82) {
        used[k] = true;
        mergeInto(base, other);
      }
    }
    out.push(base);
  }
  return out;
}

function richness(j) {
  return (j.description ? 400 : 0) + (j.skills?.length || 0) * 8 + (j.tags?.length || 0) * 3 + (j.salary ? 10 : 0) + (j.summary ? 20 : 0);
}

function mergeInto(target, src) {
  if (richness(src) > richness(target)) {
    const keepSource = target.sources || [target.source];
    Object.assign(target, src);
    target.sources = [...new Set([...(src.sources || [src.source]), ...keepSource])];
  } else {
    target.sources = [...new Set([...(target.sources || [target.source]), ...(src.sources || [src.source])])];
  }
  target.skills = [...new Set([...(target.skills || []), ...(src.skills || [])])];
  target.tags = [...new Set([...(target.tags || []), ...(src.tags || [])])];
  if (!target.description && src.description) target.description = src.description;
  if (!target.summary && src.summary) target.summary = src.summary;
  if (!target.salary && src.salary) target.salary = src.salary;
  if (!target.publishTime && src.publishTime) target.publishTime = src.publishTime;
}

/** 截断长文本，按字符数 */
export function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n) + '…';
}

/** 把数组按固定大小切块 */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 简单并发池：限制同时执行的任务数 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { __error: e?.message || String(e) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
