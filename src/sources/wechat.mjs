// 微信公众号岗位源
//
// 通道：搜狗微信搜索（公开入口，无需登录微信）
//   1. weixin.sogou.com 按关键词搜文章 → 拿到标题/公众号/日期/摘要/加密跳转链接
//   2. 带 cookie + Referer 请求 /link?url=... → 页面用 JS 拼接出真实 mp.weixin.qq.com 地址
//   3. 抓取文章页 → 取 js_content 正文
//
// 为什么不用登录微信：个人微信自动化违反腾讯服务条款，且极易触发封号；
// 而上面这条公开通道已验证可用，能拿到真实的校招公告，没有必要拿账号去冒险。
import { htmlToText, decodeEntities, extractElementById, normalizeDate } from '../util/html.mjs';
import { normKey, sanitizeText, sleep, truncate, cityCanon } from '../util/text.mjs';
import { MAJOR_CITIES } from '../resume/cities.mjs';

export const meta = {
  id: 'wechat',
  name: '微信公众号',
  homepage: 'https://weixin.sogou.com/',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEARCH_BASE = 'https://weixin.sogou.com/weixin';

/** 搜狗用 cookie 串联搜索与跳转，必须保持同一会话，否则 /link 会被判定为爬虫 */
class SogouSession {
  constructor() {
    this.cookies = new Map();
    this.blocked = false;
  }

  _absorb(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const pair = String(c).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async get(url, { referer = '', timeoutMs = 25000, allowRedirect = false } = {}) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
        ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
      },
      redirect: allowRedirect ? 'follow' : 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    this._absorb(res);
    return res;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** 是否被搜狗反爬拦截 */
function isBlocked(html) {
  return /antispider|请输入验证码|访问过于频繁|系统检测到您的网络存在异常/i.test(html);
}

/* ------------------------------ 搜索 ------------------------------ */

export function buildSearchUrl(keyword, page = 1) {
  const params = new URLSearchParams({ type: '2', query: keyword, ie: 'utf8' });
  if (page > 1) params.set('page', String(page));
  return `${SEARCH_BASE}?${params.toString()}`;
}

/**
 * 切分搜索结果块。
 *
 * 不能用 `/<li[^>]*>[\s\S]*?<\/li>/` —— 非贪婪匹配会在块内第一个 `</li>` 处截断，
 * 导致公众号名、摘要这些排在后面的字段整批丢失。
 * 改为按结果块的 id 定位起点、以下一个结果的起点为终点切片。
 */
export function extractResultBlocks(html) {
  const marker = /<li[^>]*id="sogou_vr_[0-9a-zA-Z_]*box[0-9a-zA-Z_]*"[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = marker.exec(html))) starts.push(m.index);
  if (starts.length) {
    return starts.map((s, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, s + 30000);
      return html.slice(s, end);
    });
  }
  // 兜底：老写法
  return [...html.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map((x) => x[0]).filter((b) => b.includes('/link?url='));
}

/** 解析搜索结果列表 HTML */
export function parseSearchResults(html) {
  return extractResultBlocks(html)
    .filter((b) => b.includes('/link?url='))
    .map((b) => {
      const href = (b.match(/href="(\/link\?url=[^"]+)"/) || [, ''])[1].replace(/&amp;/g, '&');
      const title = sanitizeText(htmlToText((b.match(/<h3>([\s\S]*?)<\/h3>/) || [, ''])[1]));
      const account = sanitizeText(htmlToText((b.match(/<a[^>]*class="account"[^>]*>([\s\S]*?)<\/a>/) || [, ''])[1]));
      const summary = sanitizeText(htmlToText((b.match(/<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/) || [, ''])[1]));
      // 时间以 JS 形式内嵌：document.write(timeConvert('1700000000'))
      const ts = (b.match(/timeConvert\('(\d+)'\)/) || [, ''])[1];
      const publishTime = ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '';
      return { href, title, account, summary, publishTime };
    })
    .filter((r) => r.title && r.href);
}

/* --------------------------- 链接解析 --------------------------- */

/**
 * 搜狗跳转页把真实地址拆成多段 JS 字符串再拼接，
 * 直接跟随重定向会撞上 antispider，必须自己把片段拼回来。
 */
export function extractRealUrl(body) {
  const parts = [...body.matchAll(/url \+= '([^']*)'/g)].map((m) => m[1]);
  if (parts.length) {
    const joined = parts.join('').replace(/@/g, '');
    if (/^https?:\/\/mp\.weixin\.qq\.com/i.test(joined)) return joined;
  }
  const direct = (body.match(/href="(https:\/\/mp\.weixin\.qq\.com[^"]+)"/) || [, ''])[1];
  if (direct) return decodeEntities(direct);
  const raw = (body.match(/'(https:\/\/mp\.weixin\.qq\.com[^']+)'/) || [, ''])[1];
  return raw ? decodeEntities(raw) : '';
}

/* --------------------------- 正文抓取 --------------------------- */

/** 解析微信文章页 */
export function parseArticle(html) {
  const title = sanitizeText(htmlToText((html.match(/<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)<\/h1>/) || [, ''])[1]));
  const account = sanitizeText(htmlToText((html.match(/id="js_name"[^>]*>([\s\S]*?)<\/a>/) || [, ''])[1]));
  const ts = (html.match(/var ct = "(\d+)"/) || html.match(/var create_time = "(\d+)"/) || [, ''])[1];
  const publishTime = ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '';

  const content = extractElementById(html, 'js_content');
  const text = htmlToText(content);
  // 正文里的图片数量：校招公告常用海报图，纯图文章需要另行标注
  const imageCount = (content.match(/<img/gi) || []).length;

  let unavailable = '';
  if (/该内容已被发布者删除|此内容因违规无法查看/.test(html)) unavailable = '内容已被删除';
  else if (/环境异常|请在微信客户端打开链接/.test(html)) unavailable = '需在微信客户端打开';
  else if (/参数错误|该链接已过期/.test(html)) unavailable = '链接已失效';

  return { title, account, publishTime, text, imageCount, unavailable };
}

/* ------------------------------ 采集 ------------------------------ */

/**
 * 相关性评分。
 *
 * 早期版本给「2026届」「校园招聘」这类通用词很高权重，结果把
 * 《2026届校园招聘信息汇总（三十一）》这种泛文章顶到最前，
 * 而标题里精准写着「JAVA后端开发工程师」的公告反而排到第 7。
 * 现在改为：岗位词 > 技能词 > 通用校招词，并加入时效性衰减。
 */
export function relevanceScore(article, { roleKeywords = [], profileKeywords = [], cities = [] } = {}) {
  const titleText = normKey(article.title);
  const allText = normKey(`${article.title} ${article.summary || ''}`);
  let score = 0;

  const hit = (terms, titleWeight, bodyWeight) => {
    for (const t of terms) {
      const k = normKey(t);
      if (k.length < 2) continue;
      if (titleText.includes(k)) score += titleWeight;
      else if (bodyWeight && allText.includes(k)) score += bodyWeight;
    }
  };

  hit(roleKeywords, 14, 4); // 目标岗位词出现在标题里，几乎可以确定相关
  hit(profileKeywords, 9, 2); // 技能词

  // 校招 / 实习信号：学生要的是这一类，理应压过泛社招
  if (/校园招聘|校招|秋招|春招|应届|实习生|毕业生/.test(article.title)) score += 12;

  // 地方招聘号 / 劳务中介的特征词：标题常被「急聘」「包住」「今日招聘」刷满，
  // 内容基本是本地社招，对应届生价值很低
  if (/急聘|急招|包住|包吃|月薪\d|今日.*招聘|热门.*招聘|本地招聘|期$|第\d+期/.test(article.title)) score -= 10;

  // 只说明「这是一篇招聘公告」，给低权重
  if (/招聘|校招|秋招|春招|实习|offer/.test(article.title)) score += 5;
  if (/汇总|汇编|合集/.test(article.title)) score += 2;

  // 城市：公众号里存在大量「某地招聘」地方号，内容对异地求职者毫无价值，
  // 而搜狗只支持按关键词搜，没法按城市过滤，只能在排序阶段压下去。
  const want = cities.map((c) => normKey(cityCanon(c)));
  if (cities.length) {
    if (want.some((c) => c && allText.includes(c))) score += 12;
    else {
      const other = MAJOR_CITIES.filter((c) => {
        const n = normKey(c);
        return n && !want.includes(n) && allText.includes(n);
      });
      if (other.length) score -= 14;
    }
  }
  // 公众号名里带外地城市（如「重庆汇博名企招聘」）是很强的「地方号」信号
  const account = normKey(article.account || '');
  if (account && cities.length) {
    const acctCity = MAJOR_CITIES.find((c) => account.includes(normKey(c)));
    if (acctCity && !want.includes(normKey(acctCity))) score -= 18;
    else if (acctCity) score += 8;
  }

  // 时效性：过了招聘季的公告参考价值很低
  const months = monthsSince(article.publishTime);
  if (months !== null) {
    if (months > 24) score -= 30;
    else if (months > 15) score -= 15;
    else if (months > 10) score -= 5;
    else if (months <= 6) score += 5;
  }
  return score;
}

function monthsSince(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (30 * 864e5);
}

/**
 * 采集微信公众号校招公告
 * @param {object} p
 * @param {string[]} p.keywords 检索词（通常为「岗位词 + 校招/实习」组合）
 * @param {string[]} p.profileKeywords 简历关键词，用于相关性排序
 */
export async function collectWechat({
  keywords = [],
  roleKeywords = [],
  profileKeywords = [],
  cities = [],
  maxPages = 2,
  maxFetch = 8,
  delayMs = 1200,
  cfg,
  log = () => {},
  signal,
} = {}) {
  const session = new SogouSession();
  const errors = [];
  const seen = new Map(); // normKey(title)|account -> article
  let searchCount = 0;
  let blockedCount = 0;

  /* --- 1. 搜索 --- */
  for (const keyword of keywords.slice(0, 4)) {
    for (let page = 1; page <= maxPages; page++) {
      if (signal?.aborted) break;
      try {
        const url = buildSearchUrl(keyword, page);
        const res = await session.get(url, { referer: 'https://weixin.sogou.com/' });
        const html = await res.text();
        searchCount++;

        if (isBlocked(html)) {
          blockedCount++;
          log(`微信「${keyword}」第 ${page} 页触发搜狗反爬，已停止该关键词`);
          errors.push(`搜狗微信反爬（${keyword} p${page}）`);
          break;
        }

        const results = parseSearchResults(html);
        let added = 0;
        for (const r of results) {
          const key = `${normKey(r.title)}|${normKey(r.account)}`;
          if (seen.has(key)) continue;
          seen.set(key, { ...r, keyword });
          added++;
        }
        log(`微信「${keyword}」第 ${page} 页 → ${results.length} 条（新增 ${added}）`);
        if (results.length === 0) break;
      } catch (e) {
        errors.push(`微信搜索失败（${keyword} p${page}）：${e.message}`);
        break;
      }
      await sleep(delayMs);
    }
    await sleep(delayMs);
  }

  const all = [...seen.values()];
  if (all.length === 0) {
    return { jobs: [], errors, stats: { searched: searchCount, found: 0, fetched: 0, blocked: blockedCount } };
  }

  /* --- 2. 相关性排序，只对靠前的解析链接与抓正文 --- */
  const ranked = all
    .map((a) => ({ ...a, relevance: relevanceScore(a, { roleKeywords, profileKeywords, cities }) }))
    .sort((a, b) => b.relevance - a.relevance);

  const toFetch = ranked.slice(0, maxFetch);
  log(`微信公众号：搜到 ${all.length} 篇，按相关性选取前 ${toFetch.length} 篇解析正文`);

  let fetched = 0;
  for (const a of toFetch) {
    if (signal?.aborted) break;
    try {
      const linkUrl = `https://weixin.sogou.com${a.href}`;
      const lr = await session.get(linkUrl, { referer: buildSearchUrl(a.keyword), allowRedirect: false });
      const lbody = await lr.text();
      if (isBlocked(lbody)) {
        blockedCount++;
        log('解析文章链接时触发反爬，剩余文章跳过（已有结果不受影响）');
        errors.push('搜狗微信反爬（链接解析）');
        break;
      }
      const realUrl = extractRealUrl(lbody);
      if (!realUrl) {
        a.unavailable = '未能解析文章地址';
        continue;
      }
      a.url = realUrl;
      await sleep(delayMs);

      const ar = await session.get(realUrl, { referer: 'https://weixin.sogou.com/', allowRedirect: true, timeoutMs: 30000 });
      const ahtml = await ar.text();
      const parsed = parseArticle(ahtml);
      a.articleTitle = parsed.title || a.title;
      a.account = a.account || parsed.account;
      a.publishTime = parsed.publishTime || a.publishTime;
      a.text = parsed.text;
      a.imageCount = parsed.imageCount;
      if (parsed.unavailable) a.unavailable = parsed.unavailable;
      fetched++;
      log(`  已抓取「${truncate(a.articleTitle, 30)}」正文 ${parsed.text.length} 字 / 图 ${parsed.imageCount} 张`);
    } catch (e) {
      a.unavailable = `抓取失败：${e.message}`;
      errors.push(`微信文章抓取失败：${e.message}`);
    }
    await sleep(delayMs);
  }

  /* --- 3. 归一化为统一的「文章线索」结构 --- */
  const jobs = ranked.map((a) => normalizeArticle(a));

  return {
    jobs,
    errors,
    stats: {
      searched: searchCount,
      found: all.length,
      fetched,
      blocked: blockedCount,
    },
  };
}

/** 文章线索 → 统一 Job 结构（后续由 LLM 抽取真实岗位） */
export function normalizeArticle(a) {
  const account = sanitizeText(a.account);
  const title = sanitizeText(a.articleTitle || a.title);
  const text = a.text || '';
  return {
    id: `wechat:${normKey(title)}|${normKey(account)}`,
    source: meta.id,
    sourceName: `${meta.name}·${account || '未知公众号'}`,
    sources: [meta.id],
    title,
    company: '',
    city: '',
    district: '',
    salary: '',
    education: '',
    experience: '',
    jobType: /实习/.test(title) ? '实习' : /校招|秋招|春招|校园招聘/.test(title) ? '校招' : '',
    skills: [],
    tags: account ? [`公众号：${account}`] : [],
    publishTime: normalizeDate(a.publishTime || ''),
    url: a.url || '',
    summary: truncate(a.summary || '', 300),
    description: text,
    extra: {
      account,
      articleTitle: title,
      imageCount: a.imageCount || 0,
      keyword: a.keyword || '',
      unavailable: a.unavailable || '',
      relevance: a.relevance || 0,
      textLength: text.length,
    },
    isArticle: true,
  };
}
