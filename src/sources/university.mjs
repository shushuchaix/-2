import { sourceFetch as fetch } from './request-context.mjs';
// 高校就业信息网岗位源
//
// 为什么加这个源：企业自研校招官网几乎全是 SPA + 需鉴权的接口（字节/华为/美团/京东
// 都实测过，拿不到岗位数据），但**企业会把官方校招信息发布到高校就业网**，
// 而这些站点用的是同一套「才立方就业」系统，页面是服务端渲染的，可直接解析。
//
// 已验证可用的系统特征：
//   检索：/search/list?type=1&keyword=X   职位信息
//         /search/list?type=4&keyword=X   招聘公告
//   详情：/job/view/id/{id}               职位（含薪资/城市/学历/需求专业）
//         /campus/view/id/{id}             公告（标题即「XX公司2027届校园招聘」）
//
// 注意：检索接口需要 X-Requested-With: XMLHttpRequest 头才返回列表片段。
import fs from 'node:fs';
import path from 'node:path';
import { htmlToText, decodeEntities, normalizeDate } from '../util/html.mjs';
import { cityCanon, normKey, sanitizeText, sleep, truncate } from '../util/text.mjs';
import { DATA_ROOT } from '../config.mjs';

export const meta = {
  id: 'university',
  name: '高校就业网',
  homepage: 'https://job.xidian.edu.cn',
  supportsCityFilter: false,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 已验证可用的高校就业网。
 *
 * 实测结论：约 50 所学校 × 8 种域名模式（job./myjob./jy./career./scc./91wllm/…）
 * 共 400 次探测，只有下面这几所命中同一套「才立方就业」系统。
 * 其余学校用的是别的系统（多为需鉴权的自研平台），抓不到。
 */
export const VERIFIED_HOSTS = [
  { name: '西安电子科技大学', host: 'https://job.xidian.edu.cn', kind: 'it', aliases: ['西电', '西安电子科技大学'] },
  { name: '东北大学秦皇岛分校', host: 'https://job.neuq.edu.cn', kind: 'it', aliases: ['东秦', '东北大学秦皇岛分校'] },
  { name: '大连海事大学', host: 'https://myjob.dlmu.edu.cn', kind: 'it', aliases: ['大连海事大学', '大连海事'] },
  { name: '山东财经大学', host: 'https://job.sdufe.edu.cn', kind: 'finance', aliases: ['山财', '山东财经大学'] },
  { name: '浙江师范大学', host: 'https://career.zjnu.edu.cn', kind: 'normal', aliases: ['浙师大', '浙江师范大学'] },
  { name: '厦门大学', host: 'https://jy.xmu.edu.cn', kind: 'general', aliases: ['厦大', '厦门大学'] },
  { name: '郑州大学', host: 'https://job.zzu.edu.cn', kind: 'general', aliases: ['郑大', '郑州大学'] },
  { name: '浙江树人学院', host: 'https://job.zjxu.edu.cn', kind: 'general', aliases: ['浙江树人学院', '树人大学'] },
];

/** 兼容旧名 */
export const DEFAULT_HOSTS = VERIFIED_HOSTS;

/**
 * 学校名 → 域名缩写。用于自动发现「用户本校」的就业网 ——
 * 本校就业网是最相关的来源（本校学生能参加的宣讲会都发在这里）。
 */
export const SCHOOL_ABBR = {
  北京邮电大学: 'bupt', 西安电子科技大学: 'xidian', 电子科技大学: 'uestc', 杭州电子科技大学: 'hdu',
  南京邮电大学: 'njupt', 重庆邮电大学: 'cqupt', 西安邮电大学: 'xupt', 北京理工大学: 'bit',
  北京航空航天大学: 'buaa', 哈尔滨工业大学: 'hit', 哈尔滨工程大学: 'hrbeu', 南京航空航天大学: 'nuaa',
  南京理工大学: 'njust', 西北工业大学: 'nwpu', 大连理工大学: 'dlut', 东北大学: 'neu',
  东北大学秦皇岛分校: 'neuq', 华南理工大学: 'scut', 华中科技大学: 'hust', 西安交通大学: 'xjtu',
  上海交通大学: 'sjtu', 中国科学技术大学: 'ustc', 东南大学: 'seu', 天津大学: 'tju',
  同济大学: 'tongji', 北京交通大学: 'bjtu', 西南交通大学: 'swjtu', 重庆大学: 'cqu',
  大连海事大学: 'dlmu', 中国矿业大学: 'cumt', 河海大学: 'hhu', 武汉理工大学: 'whut',
  合肥工业大学: 'hfut', 郑州大学: 'zzu', 浙江树人学院: 'zjxu', 上海大学: 'shu',
  苏州大学: 'suda', 深圳大学: 'szu', 江苏大学: 'ujs', 扬州大学: 'yzu',
  广州大学: 'gzhu', 宁波大学: 'nbu', 青岛大学: 'qdu', 湘潭大学: 'xtu',
  上海财经大学: 'sufe', 中央财经大学: 'cufe', 西南财经大学: 'swufe', 江西财经大学: 'jxufe',
  浙江财经大学: 'zufe', 南京审计大学: 'nau', 首都经济贸易大学: 'cueb', 北京大学: 'pku',
  清华大学: 'tsinghua', 浙江大学: 'zju', 南京大学: 'nju', 武汉大学: 'whu',
  四川大学: 'scu', 山东大学: 'sdu', 吉林大学: 'jlu', 南开大学: 'nankai',
  中山大学: 'sysu', 厦门大学: 'xmu', 湖南大学: 'hnu', 中南大学: 'csu',
  // 财经类
  东北财经大学: 'dufe', 天津财经大学: 'tjufe', 山西财经大学: 'sxufe', 云南财经大学: 'ynufe',
  山东财经大学: 'sdufe', 广东财经大学: 'gdufe', 河北经贸大学: 'hbue', 安徽财经大学: 'aufe',
  // 师范类
  北京师范大学: 'bnu', 华东师范大学: 'ecnu', 华中师范大学: 'ccnu', 南京师范大学: 'njnu',
  华南师范大学: 'scnu', 湖南师范大学: 'hunnu', 陕西师范大学: 'snnu', 东北师范大学: 'nenu',
  首都师范大学: 'cnu', 山东师范大学: 'sdnu', 浙江师范大学: 'zjnu', 福建师范大学: 'fjnu',
  // 其他综合类
  兰州大学: 'lzu', 云南大学: 'ynu', 广西大学: 'gxu', 贵州大学: 'gzu',
  南昌大学: 'ncu', 安徽大学: 'ahu', 河南大学: 'henu', 山西大学: 'sxu',
  河北大学: 'hbu', 湖北大学: 'hubu', 黑龙江大学: 'hlju', 辽宁大学: 'lnu',
  // 民航 / 交通类
  中国民用航空飞行学院: 'cafuc', 中国民航大学: 'cauc', 广州民航职业技术学院: 'gzcavtc',
  上海民航职业技术学院: 'scac', 成都航空职业技术学院: 'capc',
};

/** 探测时尝试的域名模板 */
const DOMAIN_PATTERNS = [
  (a) => `https://job.${a}.edu.cn`,
  (a) => `https://myjob.${a}.edu.cn`,
  (a) => `https://jy.${a}.edu.cn`,
  (a) => `https://career.${a}.edu.cn`,
  (a) => `https://scc.${a}.edu.cn`,
  (a) => `https://${a}.91wllm.cn`,
  (a) => `https://jyzx.${a}.edu.cn`,
];

/**
 * 专业 → 偏好院校类型。
 * 企业校招公告发在高校就业网，而理工类院校的 IT 岗位密度远高于综合类，
 * 所以按专业挑学校能显著提高命中率。
 */
const MAJOR_KINDS = [
  { match: /计算机|软件|信息|电子|通信|自动化|人工智能|数据|网络|智能|电气|机械/, kinds: ['it', 'general'] },
  // 消防/安全/应急属工科，理工类院校的安全工程岗密度更高
  { match: /消防|安全工程|安全科学|应急|职业健康|EHS/i, kinds: ['it', 'general'] },
  { match: /航空|民航|飞行|空管|交通运输|机场/, kinds: ['it', 'general'] },
  { match: /会计|财务|金融|经济|审计|税务|贸易|工商管理|市场营销/, kinds: ['finance', 'general'] },
  { match: /教育|师范|汉语|心理|文学|历史|哲学/, kinds: ['normal', 'general'] },
];

/**
 * 按专业挑出偏好的院校类型。
 * 每种专业都带上 'general' 兜底 —— 综合类大学学科覆盖广，
 * 任何专业都能在里面找到对口岗位，而财经/师范类院校目前收录得很少。
 */
export function preferredKinds(profile = {}) {
  const major = String(profile.major || '');
  if (!major) return [];
  for (const m of MAJOR_KINDS) if (m.match.test(major)) return m.kinds;
  return [];
}

// 校名规范化与本校判定已抽到 common.mjs 共用
// （注意：export ... from 只是转发，不会引入本地作用域，这里必须真的 import）
import { normSchool, isOwnSchool } from './common.mjs';

export { normSchool, isOwnSchool };

/* ---------------------- 就业网自动探测与缓存 ---------------------- */

const HOST_CACHE = path.join(DATA_ROOT, 'university-hosts.json');

/**
 * 缓存格式版本。
 * v1 的缓存里可能存着旧版选校逻辑的**错误结论**（例如旧版用双向子串匹配，
 * 把成都「电子科技大学」判成了西安电子科技大学并缓存了 xidian 的地址）。
 * 逻辑一改就该让它失效，否则错误结论会被一直复用下去。
 */
const CACHE_VERSION = 3;
export { CACHE_VERSION };

function loadHostCache() {
  try {
    return JSON.parse(fs.readFileSync(HOST_CACHE, 'utf8'));
  } catch {
    return {};
  }
}

function saveHostCache(cache) {
  try {
    // 顺手清掉旧版本条目 —— 它们永远不会再被读到，留着只会让文件越来越乱。
    // 注意 cachePut 已经给新写入的条目打上了当前版本号，所以不会被这里误删。
    const pruned = {};
    for (const [k, v] of Object.entries(cache)) if (v?.v === CACHE_VERSION) pruned[k] = v;
    fs.mkdirSync(path.dirname(HOST_CACHE), { recursive: true });
    fs.writeFileSync(HOST_CACHE, JSON.stringify(pruned, null, 2), 'utf8');
  } catch {
    /* 缓存写不了不影响主流程 */
  }
}

/**
 * 探测某个 host 是否真的可用。
 *
 * 判据是「**能不能解析出条目**」，而不是「页面里有没有某些字样」。
 * 早期版本只看 `view/id` 与 `<li` 是否出现，结果把四川大学 `jy.scu.edu.cn` 误判为可用 ——
 * 它的 `/search/list` 根本不存在，直接返回了首页 HTML（127KB），里面恰好含这两样东西。
 * 所以现在直接跑一遍真正的解析器，并要求解析出足够多的条目。
 *
 * 检索词用「招聘」：任何就业网都必然有招聘类内容，比用「Java」稳。
 */
export async function probeHost(host, timeoutMs = 10000) {
  try {
    const res = await fetch(`${host}/search/list?type=1&keyword=${encodeURIComponent('招聘')}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html, */*; q=0.01',
        Referer: `${host}/search/list`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if ((text.match(/\uFFFD/g) || []).length > text.length * 0.01) {
      try {
        text = new TextDecoder('gbk').decode(buf);
      } catch {
        /* ignore */
      }
    }
    if (/暂无数据/.test(text)) return false;
    // 必须是列表片段，不能是整页 HTML
    if (/<html[\s>]/i.test(text) || /<!DOCTYPE html>/i.test(text)) return false;
    return parseSearchFragment(text).length >= 3;
  } catch {
    return false;
  }
}

function cacheGet(cache, key) {
  const c = cache[key];
  if (!c) return null;
  if (c.v !== CACHE_VERSION) return null; // 旧格式/旧逻辑的结果一律丢弃，重新探测
  return c;
}

function cachePut(cache, key, value) {
  cache[key] = { ...value, v: CACHE_VERSION, probedAt: value.probedAt || Date.now() };
  return cache[key];
}

/**
 * 自动发现某所学校的就业网。
 * 结果（含否定结果）都会缓存到 data/university-hosts.json，避免每次检索都重试一遍。
 */
export async function discoverHost(schoolName, { log = () => {}, force = false } = {}) {
  if (!schoolName) return null;
  const cache = loadHostCache();
  const key = String(schoolName).trim();
  const cached = force ? null : cacheGet(cache, key);
  // 阳性结果直接复用；否定结果 7 天内不重试
  if (cached) {
    if (cached.host) return cached.host;
    if (Date.now() - (cached.probedAt || 0) < 7 * 864e5) return null;
  }

  const known = VERIFIED_HOSTS.find((h) => isOwnSchool(h, { school: key }));
  if (known) {
    cachePut(cache, key, { host: known.host, name: known.name });
    saveHostCache(cache);
    return known.host;
  }

  const abbr =
    SCHOOL_ABBR[key] || Object.entries(SCHOOL_ABBR).find(([n]) => key.includes(n))?.[1];
  if (!abbr) {
    log(`  未收录「${key}」的域名缩写，无法自动探测就业网（可在配置里手动指定地址）`);
    cachePut(cache, key, { host: '', note: 'unknown-abbr' });
    saveHostCache(cache);
    return null;
  }

  log(`  正在探测「${key}」的就业网…`);
  for (const pattern of DOMAIN_PATTERNS) {
    const host = pattern(abbr);
    if (await probeHost(host)) {
      log(`  ✅ 找到「${key}」就业网：${host}`);
      cachePut(cache, key, { host, name: key });
      saveHostCache(cache);
      return host;
    }
  }
  log(`  「${key}」就业网不在已支持的系统内（可在配置 sources.university.hosts 手动添加）`);
  cachePut(cache, key, { host: '', note: 'not-supported' });
  saveHostCache(cache);
  return null;
}

/**
 * 解析本次检索要用哪些就业网。
 * 优先级：本校（自动发现）> 手动配置 > 专业相关类型院校 > 其余已收录院校。
 */
export async function resolveHosts(profile = {}, { extraHosts = [], maxHosts = 4, log = () => {} } = {}) {
  const out = [];
  const push = (entry) => {
    if (!entry?.host) return;
    if (out.some((h) => h.host === entry.host)) return;
    out.push(entry);
  };

  // 1) 本校（自动发现）
  const ownHost = await discoverHost(profile.school, { log });
  if (ownHost) {
    push(VERIFIED_HOSTS.find((h) => h.host === ownHost) || { name: profile.school, host: ownHost, kind: 'own' });
  }

  // 2) 用户手动追加的
  for (const h of extraHosts) {
    if (h?.host) push({ name: h.name || h.host, host: h.host, kind: h.kind || 'custom' });
  }

  // 3) 按专业挑院校类型（kinds 里已含 general 兜底）
  const kinds = preferredKinds(profile);
  const majorLabel = profile.major || '未识别';
  if (kinds.length) {
    // 按 kinds 的先后顺序取，保证「专业对口类型」排在「general 兜底」前面
    const ordered = kinds.flatMap((k) => VERIFIED_HOSTS.filter((h) => h.kind === k));
    for (const h of ordered) push(h);
    const primary = ordered.filter((h) => h.kind === kinds[0]).length;
    if (primary) {
      log(`  专业「${majorLabel}」→ 优先 ${kinds[0]} 类院校就业网 ${primary} 所`);
    } else {
      log(`  专业「${majorLabel}」暂无 ${kinds[0]} 类院校收录，回退到综合类院校`);
    }
  } else {
    // 专业没识别出来：综合类大学学科覆盖最广，优先用它们，而不是按注册表顺序硬取
    for (const h of VERIFIED_HOSTS.filter((x) => x.kind === 'general')) push(h);
  }

  // 4) 其余补足
  for (const h of VERIFIED_HOSTS) {
    if (out.length >= maxHosts) break;
    push(h);
  }

  return out.slice(0, maxHosts);
}

/** 带 GBK 回退的抓取：高校站点大量使用 GBK，按 UTF-8 解会全是乱码 */
async function fetchText(url, { timeoutMs = 20000, xhr = false, referer = '' } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html, */*; q=0.01',
      ...(referer ? { Referer: referer } : {}),
      ...(xhr ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let text = buf.toString('utf8');
  if ((text.match(/\uFFFD/g) || []).length > text.length * 0.01) {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      /* 保留 utf8 结果 */
    }
  }
  return text;
}

/** 从列表片段里解析条目 */
export function parseSearchFragment(html) {
  const out = [];
  // 每条通常是 <li> 或 <div class="list-item">，统一按「详情链接 + 标题 + 发布时间」抓
  const itemRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  const blocks = [...html.matchAll(itemRe)].map((m) => m[1]);
  const source = blocks.length ? blocks : html.split(/(?=<a[^>]+href="[^"]*(?:view\/id|detail))/);

  for (const b of source) {
    const href = (b.match(/href="([^"]*(?:\/job\/view\/id\/|\/campus\/view\/id\/|\/company\/view\/id\/)[^"]*)"/) || [, ''])[1];
    if (!href) continue;
    // 标题可能带高亮标签，取链接内文本
    const inner = (b.match(/<a[^>]*href="[^"]*(?:view\/id|detail)[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [, ''])[1];
    const title = sanitizeText(htmlToText(inner)) || sanitizeText(htmlToText(b)).slice(0, 80);
    const dateRaw = (b.match(/发布时间[:：]\s*(\d{4}-\d{2}-\d{2})/) || [, ''])[1];
    const kind = /招聘会/.test(b) ? '招聘会' : /宣讲会/.test(b) ? '宣讲会' : /招聘公告/.test(b) ? '招聘公告' : /职位信息|职位/.test(b) ? '职位信息' : '';
    if (title) out.push({ href, title, publishTime: dateRaw, kind });
  }

  // 去重（同一链接只留一条）
  const seen = new Set();
  return out.filter((x) => {
    const k = x.href;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 从详情页提取标题（各校模板不一，逐级兜底） */
function extractDetailTitle(html, fallback = '') {
  for (const re of [
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<h2[^>]*>([\s\S]*?)<\/h2>/i,
    /class="[^"]*(?:job-?name|position-?name|detail-?title|tit)[^"]*"[^>]*>([\s\S]{2,80}?)<\//i,
  ]) {
    const m = html.match(re);
    if (!m) continue;
    const t = sanitizeText(htmlToText(m[1]));
    // 排除「XX就业信息网」这类站点名被当成标题的情况
    if (t && t.length >= 2 && t.length <= 60 && !/就业信息网|就业网|首页|欢迎访问/.test(t)) return t;
  }
  const site = sanitizeText((html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].split(/[-_|]/)[0]);
  if (site && !/就业信息网|就业网|首页/.test(site)) return site;
  return fallback;
}

/** 从正文里抽公司名：高校站常见写法是「XX公司 单位性质：…」 */
function extractCompany(text) {
  const m = text.match(/([\u4e00-\u9fa5A-Za-z()（）]{4,40}?(?:公司|集团|银行|研究院|研究所|中心|学院|大学|厂|局|院|部))\s*单位性质/);
  if (m) return sanitizeText(m[1]);
  const m2 = text.match(/单位名称[:：]\s*([^\s|｜]{4,40})/);
  if (m2) return sanitizeText(m2[1]);
  return '';
}

/**
 * 解析职位详情页。
 * 页面首行是「薪资 | 城市 | 类型 | 学历」，之后是职能类别/招聘人数/需求专业/职位详情。
 */
export function parseJobDetail(html) {
  const title = extractDetailTitle(html);

  const text = htmlToText(html);

  // 首行信息栏：薪资 | 城市 | 类型 | 学历
  let salary = '';
  let city = '';
  let jobType = '';
  let education = '';
  const barMatch = text.match(/([\d]+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?(?:及以上)?|面议)\s*[|｜]\s*([^|｜]{2,20})\s*[|｜]\s*([^|｜]{2,8})\s*[|｜]\s*([^|｜\n]{1,10})/);
  if (barMatch) {
    salary = sanitizeText(barMatch[1]);
    city = cityCanon(sanitizeText(barMatch[2]));
    jobType = sanitizeText(barMatch[3]);
    education = sanitizeText(barMatch[4]);
  }

  const pick = (label) => {
    const m = text.match(new RegExp(`${label}[:：]\\s*([^\\n|｜]{1,40})`));
    return m ? sanitizeText(m[1]) : '';
  };
  const headcount = pick('招聘人数');
  const experience = pick('工作经验');
  const major = pick('需求专业');
  const category = pick('职能类别');
  const company = extractCompany(text);

  // 职位详情段落
  let description = '';
  const descIdx = text.indexOf('职位详情');
  if (descIdx >= 0) description = truncate(text.slice(descIdx + 4).trim(), 3000);
  if (!description) {
    const main = html.match(/<div[^>]*class="[^"]*(?:detail|content|desc)[^"]*"[^>]*>([\s\S]{200,8000}?)<\/div>/i);
    if (main) description = truncate(htmlToText(main[1]), 3000);
  }

  const publishTime = normalizeDate((text.match(/(\d{4}-\d{2}-\d{2})\s*发布/) || [, ''])[1]);

  return { title, company, salary, city, jobType, education, headcount, experience, major, category, description, publishTime };
}

/** 解析公告详情页（标题通常就是「XX公司2027届校园招聘」） */
export function parseNoticeDetail(html) {
  const title = extractDetailTitle(html);
  const text = htmlToText(html);
  const expire = normalizeDate((text.match(/过期时间[:：]\s*(\d{4}-\d{2}-\d{2})/) || [, ''])[1]);
  const publishTime = normalizeDate((text.match(/发布时间[:：]\s*(\d{4}-\d{2}-\d{2})/) || [, ''])[1]);
  const company =
    extractCompany(text) ||
    sanitizeText((title.match(/^([\u4e00-\u9fa5A-Za-z()（）]{4,40}?(?:公司|集团|银行|局|院|中心|厂|所|部))/) || [, ''])[1]);

  // 公告里常带职位表格：序号 | 职位信息 | 需求专业 | 操作
  // 注意页脚也有 <table>（联系方式/电话/传真），必须排除，否则会产出「电话：xxx」这种假岗位
  const NOISE = /联系方式|用人单位服务|服务热线|就业手续|职业规划|电话[:：]|传真|邮编|邮箱|地址[:：]|^序号$|投递简历$|^操作$/;
  const positions = [];
  for (const t of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const rows = [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) =>
      [...m[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => sanitizeText(htmlToText(c[1]))),
    );
    for (const cells of rows) {
      if (cells.length < 3) continue;
      const joined = cells.join(' ');
      if (NOISE.test(joined)) continue;
      // 形如：01 | 后端工程师 | 15000及以上 | 四川省 - 成都市 | 全职 | 本科 | 不限专业 | 投递简历
      // 必须带序号列：表头行（序号|职位信息|需求专业|操作）与页脚行都不带纯数字序号，
      // 靠这一条就能把两类噪声一起挡掉。
      const nameIdx = cells.findIndex((c) => /^0?\d{1,2}$/.test(c));
      if (nameIdx < 0) continue;
      const jobName = cells[nameIdx + 1];
      if (!jobName || jobName.length < 2 || jobName.length > 30) continue;
      // 岗位名不该长这样：含冒号、含联系方式、像地址/楼宇
      if (/[:：]/.test(jobName) || /^[\d\s\-—]+$/.test(jobName)) continue;
      if (/(大学|学院).*(楼|路|号|校区)/.test(jobName) || /(路|街|号|楼|室)$/.test(jobName)) continue;
      const rest = cells.slice(nameIdx + 2);
      const sal = rest.find((c) => /\d{4,}|面议|及以上/.test(c)) || '';
      const cty = rest.find((c) => /省|市|区|北京|上海|深圳|广州|杭州/.test(c)) || '';
      const edu = rest.find((c) => /^(本科|硕士|博士|大专|不限|专科)/.test(c)) || '';
      const typ = rest.find((c) => /^(全职|兼职|实习)/.test(c)) || '';
      const maj = rest.find((c) => /专业/.test(c)) || '';
      positions.push({ name: jobName, salary: sal, city: cityCanon(cty), education: edu, jobType: typ, major: maj });
    }
  }

  return { title, company, expire, publishTime, description: truncate(text, 4000), positions };
}

/* ------------------------------ 统一结构 ------------------------------ */

function toJob(base, hostInfo, detail, kind) {
  // 列表页的标题本身就是岗位名，比详情页标题可靠（详情页常把站点名当标题）
  let title = sanitizeText(base.title);
  const dt = sanitizeText(detail.title);
  if ((!title || title.length < 2 || /就业信息网|就业网|欢迎访问/.test(title)) && dt.length >= 2) title = dt;
  if (!title) return null;
  return {
    id: `university:${normKey(hostInfo.name)}:${normKey(title)}|${normKey(detail.city)}`,
    source: meta.id,
    sourceName: `${meta.name}·${hostInfo.name}`,
    sources: [meta.id],
    title,
    company: sanitizeText(detail.company),
    city: detail.city || '',
    district: '',
    salary: detail.salary || '',
    education: detail.education || '',
    experience: detail.experience || '',
    jobType: detail.jobType || (kind === '招聘公告' ? '校招' : ''),
    skills: [],
    tags: [
      hostInfo.name,
      ...(detail.major ? [`专业：${detail.major}`] : []),
      ...(detail.headcount ? [`招 ${detail.headcount}`] : []),
      ...(detail.expire ? [`过期 ${detail.expire}`] : []),
    ].filter(Boolean),
    publishTime: detail.publishTime || normalizeDate(base.publishTime || ''),
    url: base.url,
    summary: truncate(detail.description || '', 240),
    description: detail.description || '',
    extra: {
      university: hostInfo.name,
      kind,
      major: detail.major || '',
      headcount: detail.headcount || '',
      category: detail.category || '',
      expire: detail.expire || '',
      // 公告里附带的职位表（一条公告可能对应多个岗位）
      positions: detail.positions || [],
    },
    isCampus: true,
  };
}

/* ------------------------------ 采集 ------------------------------ */

/**
 * 从高校就业网检索岗位
 * @param {object} p
 * @param {string[]} p.keywords   检索词（岗位词）
 * @param {object[]} [p.hosts]    高校列表 [{name, host}]；不传则按简历的学校/专业自动解析
 * @param {object}   [p.profile]  简历画像（用于选本校 + 按专业挑院校）
 */
export async function collect({
  keywords = [],
  hosts = null,
  profile = null,
  maxPerKeyword = 15,
  maxHosts = 4,
  maxDetail = 12,
  delayMs = 900,
  log = () => {},
  signal,
} = {}) {
  const errors = [];
  const found = [];
  const stats = { hosts: 0, listed: 0, detailed: 0, probed: 0 };
  // 没显式给 hosts 时，按「本校 → 专业相关院校 → 其余」自动解析
  const resolved = hosts?.length ? hosts : await resolveHosts(profile || {}, { maxHosts, log });
  if (!hosts?.length && profile?.school) {
    stats.ownSchool = resolved.some((h) => isOwnSchool(h, profile)) ? profile.school : '';
  }
  const activeHosts = resolved.slice(0, maxHosts);
  const kws = keywords.slice(0, 3); // 检索词不宜过多，单个站点每次请求都会返回整页

  for (const hostInfo of activeHosts) {
    if (signal?.aborted) break;
    let alive = false;
    for (const kw of kws) {
      if (signal?.aborted) break;
      for (const type of [1, 4]) {
        try {
          const url = `${hostInfo.host}/search/list?type=${type}&keyword=${encodeURIComponent(kw)}`;
          const html = await fetchText(url, { xhr: true, referer: `${hostInfo.host}/search/list` });
          if (/暂无数据/.test(html)) continue;
          const items = parseSearchFragment(html);
          alive = true;
          stats.listed += items.length;
          for (const it of items.slice(0, maxPerKeyword)) {
            found.push({
              ...it,
              hostInfo,
              url: it.href.startsWith('http') ? it.href : `${hostInfo.host}${it.href}`,
              keyword: kw,
              type,
            });
          }
          log(`  ${hostInfo.name}「${kw}」type=${type} → ${items.length} 条`);
        } catch (e) {
          errors.push(`${hostInfo.name} 检索失败：${e.message}`);
        }
        await sleep(delayMs);
      }
    }
    if (alive) stats.hosts++;
  }

  // 去重（同一详情链接）
  const seen = new Set();
  const unique = found.filter((x) => {
    const k = x.url;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 只对相关性最高的若干条抓详情
  const ranked = unique
    .map((x) => {
      let score = 0;
      for (const kw of keywords) if (kw && x.title.includes(kw)) score += 6;
      if (/校园招聘|校招|秋招|春招|届/.test(x.title)) score += 8;
      score += x.type === 1 ? 4 : 2; // 职位信息比公告更具体
      if (x.publishTime) {
        const months = (Date.now() - Date.parse(`${x.publishTime}T00:00:00Z`)) / (30 * 864e5);
        if (months > 18) score -= 20;
        else if (months > 10) score -= 6;
        else score += 4;
      }
      return { ...x, score };
    })
    .sort((a, b) => b.score - a.score);

  const jobs = [];
  for (const item of ranked.slice(0, maxDetail)) {
    if (signal?.aborted) break;
    try {
      const html = await fetchText(item.url, { referer: `${item.hostInfo.host}/search/list` });
      const isNotice = /\/campus\/view\/id\//.test(item.url);
      const detail = isNotice ? parseNoticeDetail(html) : parseJobDetail(html);
      stats.detailed++;

      const job = toJob(item, item.hostInfo, detail, item.kind || (isNotice ? '招聘公告' : '职位信息'));
      if (job) jobs.push(job);

      // 公告里附带的职位表：每条抽成独立岗位
      if (isNotice && Array.isArray(detail.positions) && detail.positions.length) {
        for (const p of detail.positions.slice(0, 8)) {
          const sub = toJob(
            item,
            item.hostInfo,
            {
              title: p.name,
              company: detail.company,
              city: p.city,
              salary: p.salary,
              education: p.education,
              jobType: p.jobType,
              major: p.major,
              description: `${detail.title}\n${detail.description}`,
              publishTime: detail.publishTime,
              expire: detail.expire,
            },
            '招聘公告-职位表',
          );
          if (sub) jobs.push(sub);
        }
      }
    } catch (e) {
      errors.push(`${item.hostInfo.name} 详情抓取失败：${e.message}`);
    }
    await sleep(delayMs);
  }

  const names = activeHosts.map((h) => h.name).join('、') || '（无）';
  log(
    `高校就业网：检索 ${names}｜${stats.hosts} 所有数据，列表 ${stats.listed} 条，抓详情 ${stats.detailed} 条，得到 ${jobs.length} 个岗位`,
  );
  return { jobs, errors, stats: { ...stats, university: jobs.length } };
}
