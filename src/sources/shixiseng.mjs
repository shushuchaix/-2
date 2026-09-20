// 实习僧适配器（校招/实习主战场）
// 通道：列表页 Nuxt 内嵌载荷（函数序列化形式，需执行还原）→ interns.data[]
//
// 注意：实习僧用「每次请求随机生成的图标字体」渲染岗位标题，
// 列表数据里留下的是私有区码点。本模块通过抓少量详情页（<title> 为明文）
// 反推字体映射表，从而解码同批次全部标题，详见 fontmap.mjs。
import { evalInlinePayload, htmlToText, parseRelativeDate, decodeEntities, stripPrivateUse } from '../util/html.mjs';
import { cityCanon, cleanTitle, sanitizeText, sleep } from '../util/text.mjs';
import { extractTechTerms } from '../util/skills.mjs';
import {
  hasPua,
  learnFromPair,
  decodeWithMap,
  coverage,
  loadPersistedMap,
  persistMap,
  mapSize,
} from './fontmap.mjs';

export const meta = {
  id: 'shixiseng',
  name: '实习僧',
  homepage: 'https://www.shixiseng.com',
  supportsCityFilter: true,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function defaultHeaders() {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
  };
}

export function buildListUrl(keyword, page = 1, city = '全国') {
  const params = new URLSearchParams({ keyword });
  if (city && city !== '全国') params.set('city', city);
  if (page > 1) params.set('page', String(page));
  return `https://www.shixiseng.com/interns?${params.toString()}`;
}

/** 从 Nuxt 载荷里找出岗位数组（结构可能随版本变化，做多路径兜底） */
function findInternList(nuxt) {
  const roots = Array.isArray(nuxt?.data) ? nuxt.data : [nuxt];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    for (const value of Object.values(root)) {
      if (!value || typeof value !== 'object') continue;
      const data = value.data;
      if (Array.isArray(data) && data.length && data[0] && typeof data[0] === 'object' && 'uuid' in data[0]) {
        return data;
      }
      if (Array.isArray(value.list) && value.list.length && 'uuid' in (value.list[0] || {})) return value.list;
    }
  }
  const stack = [nuxt];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      if (cur.length && cur[0] && typeof cur[0] === 'object' && 'uuid' in cur[0] && 'cname' in cur[0]) return cur;
      stack.push(...cur.slice(0, 40));
    } else {
      stack.push(...Object.values(cur).slice(0, 60));
    }
  }
  return [];
}

function salaryText(item) {
  const min = Number(item.minsalary);
  const max = Number(item.maxsalary);
  const has = (n) => Number.isFinite(n) && n > 0;
  if (has(min) && has(max) && min !== max) return `${min}-${max}元/天`;
  if (has(max)) return `${max}元/天`;
  if (has(min)) return `${min}元/天`;
  return '';
}

/**
 * 薪资字段同时提供了「混淆串」与「明文数字」，是一对免费的已知明文，
 * 可用来学习数字字符的字体映射，无需额外请求。
 */
function salaryFontHints(item) {
  const hints = [];
  const pairs = [
    [item.maxsal, item.maxsalary],
    [item.minsal, item.minsalary],
  ];
  for (const [obfRaw, plain] of pairs) {
    const n = Number(plain);
    if (!obfRaw || !Number.isFinite(n) || n <= 0) continue;
    const obf = decodeEntities(String(obfRaw));
    if (!hasPua(obf)) continue;
    const plainStr = String(n);
    if (obf.length === plainStr.length) hints.push([obf, plainStr]);
  }
  return hints;
}

/** scale/month_num/day 字段是图标字体编码，解码后为空 → 返回空串 */
function stripIconFont(v) {
  if (v === null || v === undefined) return '';
  const s = stripPrivateUse(decodeEntities(String(v))).trim();
  return /[0-9]/.test(s) ? s : '';
}

export function normalizeIntern(item) {
  if (!item || !item.name) return null;
  const uuid = item.uuid || '';
  const titleRaw = decodeEntities(String(item.name)); // 可能含私有区码点
  const obfuscated = hasPua(titleRaw);
  const readable = stripPrivateUse(titleRaw);

  const tags = [
    ...(Array.isArray(item.i_tags) ? item.i_tags : []),
    ...(Array.isArray(item.c_tags) ? item.c_tags : []),
  ].filter((s) => typeof s === 'string' && s.trim());
  const hope = Array.isArray(item.hope_you) ? item.hope_you.filter((s) => typeof s === 'string') : [];

  // 实习僧列表接口的 skill 字段常为空；若留空会在与其它源比较时被系统性压低，
  // 因此从标题/标签/要求文本反推技能词，保证各源评分口径一致。
  let skills = Array.isArray(item.skill) ? item.skill.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (skills.length === 0) {
    skills = extractTechTerms([readable, item.cname, item.industry, ...tags, ...hope].filter(Boolean).join(' '));
  }

  return {
    id: `shixiseng:${uuid}`,
    source: meta.id,
    sourceName: meta.name,
    sources: [meta.id],
    title: cleanTitle(readable),
    titleRaw,
    titleObfuscated: obfuscated,
    titleRepaired: !obfuscated,
    titleCoverage: obfuscated ? 0 : 1,
    fontHints: salaryFontHints(item),
    company: sanitizeText(item.cname),
    city: cityCanon(item.city || ''),
    district: '',
    salary: salaryText(item),
    education: sanitizeText(item.degree),
    experience: '',
    jobType: item.type === 'intern' ? '实习' : sanitizeText(item.type),
    skills,
    tags: [...new Set(tags.map(sanitizeText).filter(Boolean))],
    publishTime: parseRelativeDate(item.refresh || ''),
    url: uuid ? `https://www.shixiseng.com/intern/${uuid}` : '',
    summary: hope.length ? hope.map(sanitizeText).filter(Boolean).join('；') : '',
    description: '',
    extra: {
      uuid,
      industry: sanitizeText(item.industry),
      companyScale: stripIconFont(item.scale),
      months: stripIconFont(item.month_num),
      daysPerWeek: stripIconFont(item.day),
      isHirer: Boolean(item.job_label?.is_hirer),
      isQuick: Boolean(item.job_label?.is_quick),
      talkFace: item.talkFace || 0,
    },
  };
}

export async function fetchListPage(keyword, page = 1, { city = '全国', timeoutMs = 25000 } = {}) {
  const url = buildListUrl(keyword, page, city);
  const res = await fetch(url, { headers: defaultHeaders(), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`实习僧列表页 HTTP ${res.status}`);
  const html = await res.text();

  let list = [];
  const nuxt = evalInlinePayload(html, '__NUXT__');
  if (nuxt) list = findInternList(nuxt);

  if (!list.length) {
    const uuids = [...new Set([...html.matchAll(/shixiseng\.com\/intern\/(inn_[a-zA-Z0-9]+)/g)].map((m) => m[1]))];
    list = uuids.map((uuid) => ({ uuid, name: '', cname: '' }));
  }

  const jobs = list
    .map(normalizeIntern)
    .filter((j) => j && (j.title || j.titleObfuscated))
    .map((j) => ({ ...j, queryKeyword: keyword }));
  return { jobs, url, raw: list.length };
}

export async function search({ keyword, city = '全国', maxPages = 3, delayMs = 800, log = () => {}, signal } = {}) {
  const collected = [];
  const errors = [];
  const seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    if (signal?.aborted) break;
    try {
      const r = await fetchListPage(keyword, p, { city });
      const fresh = r.jobs.filter((j) => {
        if (seen.has(j.id)) return false;
        seen.add(j.id);
        return true;
      });
      collected.push(...fresh);
      log(`实习僧「${keyword}」第 ${p} 页 → ${fresh.length} 条`);
      if (fresh.length === 0) break;
    } catch (e) {
      errors.push(`p${p}: ${e.message}`);
      log(`实习僧「${keyword}」第 ${p} 页失败：${e.message}`);
    }
    if (p < maxPages) await sleep(delayMs);
  }
  return { jobs: collected, errors };
}

/* ==================== 标题混淆解码 ==================== */

/** 从详情页 <title> 推出候选明文标题 */
export function titleCandidatesFromDetail(html) {
  const raw = (html.match(/<title>([^<]*)<\/title>/) || [, ''])[1].trim();
  if (!raw) return { candidates: [], raw: '' };
  const base = raw.replace(/\s*[-–|｜]\s*实习僧\s*$/, '').trim();
  const cands = new Set();
  const suit = (s) => s && s.length >= 2 && !hasPua(s);

  // 形式一：{职位}实习招聘-{公司}实习生招聘
  const segs = base.split(/[-–|｜]/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const titlePart = segs.slice(0, -1).join('-');
    for (const suf of ['实习生招聘', '实习招聘', '招聘']) {
      if (titlePart.endsWith(suf)) cands.add(titlePart.slice(0, -suf.length).trim());
    }
    cands.add(titlePart);
  }
  // 形式二：整串直接剥后缀
  for (const suf of ['实习生招聘', '实习招聘', '招聘']) {
    if (base.endsWith(suf)) cands.add(base.slice(0, -suf.length).trim());
  }
  cands.add(base);
  for (const seg of segs) {
    cands.add(seg);
    for (const suf of ['实习生招聘', '实习招聘', '招聘']) {
      if (seg.endsWith(suf)) cands.add(seg.slice(0, -suf.length).trim());
    }
  }
  return { candidates: [...cands].filter(suit), raw };
}

/** 抓详情页并解析出明文标题与公司 */
export async function fetchPlainTitle(job, { timeoutMs = 20000 } = {}) {
  if (!job?.url) return null;
  const res = await fetch(job.url, { headers: defaultHeaders(), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const { candidates, raw } = titleCandidatesFromDetail(html);
  return { candidates, raw, html };
}

/**
 * 修复一批实习僧岗位的混淆标题。
 * 策略：贪心挑选能覆盖最多「未学到的码点」的样本 → 抓详情页学习映射 → 解码全部。
 */
export async function repairTitles(jobs, { maxSamples = 6, concurrency = 3, log = () => {}, signal, useCache = true } = {}) {
  const targets = jobs.filter((j) => j.titleObfuscated);
  if (!targets.length) return { learned: 0, repaired: 0, samples: 0, total: 0 };

  const baseMap = useCache ? loadPersistedMap() : new Map();
  const sessionMap = new Map();
  const before = mapSize(baseMap);

  // --- 先用免费的已知明文（薪资字段）学习数字映射 ---
  let hintLearned = 0;
  for (const j of targets) {
    for (const [obf, plain] of j.fontHints || []) {
      hintLearned += learnFromPair(obf, plain, sessionMap);
    }
  }
  if (hintLearned > 0) log(`字体映射：从薪资字段免费学到 ${hintLearned} 个字符`);

  // --- 贪心选样（样本优先覆盖本次与缓存都未覆盖的码点）---
  const chosen = [];
  const pending = [...targets];
  const covered = new Set([...baseMap.keys(), ...sessionMap.keys()]);
  while (chosen.length < maxSamples && pending.length) {
    let bestIdx = -1;
    let bestScore = 0;
    pending.forEach((j, i) => {
      const score = new Set([...j.titleRaw].filter((c) => !covered.has(c))).size;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    if (bestIdx === -1) break;
    const [job] = pending.splice(bestIdx, 1);
    chosen.push(job);
    for (const c of job.titleRaw) covered.add(c);
  }

  // --- 抓详情页学习 ---
  let fetched = 0;
  await pool(chosen, concurrency, async (job) => {
    if (signal?.aborted) return;
    try {
      const r = await fetchPlainTitle(job);
      if (!r) return;
      fetched++;
      const match = r.candidates.find((c) => c.length === job.titleRaw.length);
      if (match) {
        learnFromPair(job.titleRaw, match, sessionMap);
        job.__plainTitle = match;
      } else {
        job.__plainRaw = r.raw;
      }
    } catch (e) {
      log(`标题样本抓取失败：${e.message}`);
    }
  });

  // --- 校验缓存的映射表是否仍适用于本次字体 ---
  // 实习僧的混淆字体可能轮换；若缓存与本次实测冲突，说明缓存已失效，
  // 必须丢弃，否则会把标题「静默解码成错误内容」，比解不出更有害。
  let conflicts = 0;
  for (const [k, v] of sessionMap) {
    if (baseMap.has(k) && baseMap.get(k) !== v) conflicts++;
  }
  let cacheDropped = false;
  if (conflicts > 0) {
    const agreement = 1 - conflicts / Math.max(1, sessionMap.size);
    if (agreement < 0.8) {
      cacheDropped = true;
      log(`字体映射：缓存与本次实测冲突 ${conflicts} 处（一致率 ${(agreement * 100).toFixed(0)}%），已丢弃缓存重建`);
    }
  }

  const map = new Map(cacheDropped ? [] : [...baseMap]);
  for (const [k, v] of sessionMap) map.set(k, v);

  const learned = Math.max(0, mapSize(map) - before);
  if (mapSize(sessionMap) > 0) {
    log(`字体映射：本次学到 ${mapSize(sessionMap)} 个字符，可用映射表 ${mapSize(map)} 个（样本 ${fetched} 个）`);
    persistMap(map);
  }

  // --- 解码全部 ---
  let repaired = 0;
  for (const j of targets) {
    const cov = coverage(j.titleRaw, map);
    j.titleCoverage = Number(cov.toFixed(2));
    const decoded = decodeWithMap(j.titleRaw, map);
    const withBoxes = decoded.replace(/[\uE000-\uF8FF]/g, '□');
    j.titleDecoded = decoded;
    const meaningful = stripPrivateUse(withBoxes).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    if (cov >= 0.999) {
      j.title = cleanTitle(stripPrivateUse(decoded));
      j.titleRepaired = true;
      repaired++;
    } else if (meaningful.length >= 2) {
      j.title = cleanTitle(withBoxes);
      j.titleRepaired = false;
    }
    // 仍不可读则保留检索关键词，交给调用方兜底
    if (!j.title || j.title.length < 2) {
      j.title = `${j.queryKeyword || '实习'}（标题混淆，请打开原页查看）`;
      j.titleRepaired = false;
    }
  }

  return { learned, repaired, samples: fetched, total: targets.length, mapSize: mapSize(map), cacheDropped };
}

/** 实习僧详情页：抽取 JD 正文 */
export async function fetchDetail(job, { timeoutMs = 20000 } = {}) {
  if (!job?.url) return { description: '' };
  try {
    const res = await fetch(job.url, { headers: defaultHeaders(), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // 详情页标题是明文，可顺带修复标题
    let plainTitle = '';
    const { candidates } = titleCandidatesFromDetail(html);
    if (candidates.length) plainTitle = candidates[0];

    const nuxt = evalInlinePayload(html, '__NUXT__');
    let desc = '';
    if (nuxt) {
      const stack = [nuxt];
      const seen = new Set();
      while (stack.length && !desc) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
        seen.add(cur);
        for (const [k, v] of Object.entries(cur)) {
          if (typeof v === 'string' && v.length > 120 && /职责|要求|岗位|工作内容|任职/.test(v)) {
            desc = htmlToText(v.replace(/\\n/g, '\n'));
            break;
          }
          if (typeof v === 'object') stack.push(v);
        }
      }
    }
    if (!desc) desc = htmlToText(html).slice(0, 2500);
    return { description: desc, plainTitle };
  } catch (e) {
    return { description: '', error: e.message };
  }
}

// 局部引入并发池，避免与 util 循环依赖
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          results[idx] = await worker(items[idx], idx);
        } catch (e) {
          results[idx] = { __error: e?.message || String(e) };
        }
      }
    }),
  );
  return results;
}
