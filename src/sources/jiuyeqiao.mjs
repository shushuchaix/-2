import { sourceFetch as fetch } from './request-context.mjs';
// 就业桥（全域智慧就业资讯服务平台）岗位源
//
// 为什么这个源价值最高：它是一套**按学校开子域**的商用平台，
// 实测 `{学校缩写}.jiuyeqiao.cn` 覆盖 20/20 所测试院校 —— 其中包含北邮、电子科大、杭电等
// **自建就业网抓不到**的学校。而且它还有跨校的全国岗位库，带关键词检索：
//     https://job.jiuyeqiao.cn/zhiwei/0/?keywords=消防&page=2
// 所以拉岗位**不需要枚举学校**，一次开发就能覆盖大量院校的生源岗位。
//
// 实测（2026-09）：
//   列表：GET /zhiwei/0/?keywords=<词>&page=<N>   → <ul class="ul-main-list"> 内 10 条/页
//         条目：.list-job(岗位) .list-company(公司) .salary .list-addr .list-condition .list-com-type .source
//   详情：GET /zhiwei/<id>.html
//   学校门户：GET https://{abbr}.jiuyeqiao.cn/   （新闻/事业单位/双选会，不含岗位列表）
import { htmlToText, decodeEntities, normalizeDate } from '../util/html.mjs';
import { cityCanon, normKey, sanitizeText, sleep, truncate } from '../util/text.mjs';

export const meta = {
  id: 'jiuyeqiao',
  name: '就业桥',
  homepage: 'https://job.jiuyeqiao.cn/',
  supportsCityFilter: false,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://job.jiuyeqiao.cn';

async function get(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: `${BASE}/`,
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
      /* 保留 utf8 */
    }
  }
  return text;
}

/** 探测就业桥是否可用（用它自己的检索接口试） */
export async function probeHost(timeoutMs = 12000) {
  try {
    const html = await get(`${BASE}/zhiwei/0/?keywords=${encodeURIComponent('招聘')}`, timeoutMs);
    return parseListFragment(html).length >= 3;
  } catch {
    return false;
  }
}

/* ------------------------------ 解析 ------------------------------ */

/** 解析列表片段 */
export function parseListFragment(html) {
  const out = [];
  // 只取职位推荐那个列表，避开页面上其它 ul
  const block = (html.match(/<ul[^>]*class="[^"]*ul-main-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i) || [, ''])[1];
  const source = block || html;
  // 注意：这些 div 的 class 常带额外类名（如 class="list-company fr"），
  // 所以必须用 class="[^"]*xxx[^"]*"，写死 class="xxx" 会全部匹配不到
  const field = (seg, cls) =>
    sanitizeText(
      htmlToText((seg.match(new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'i')) || [, ''])[1]),
    );
  for (const li of source.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const seg = li[1];
    const href = (seg.match(/href="([^"]*\/zhiwei\/\d+\.html)"/) || [, ''])[1];
    if (!href) continue;
    const title = field(seg, 'list-job');
    if (!title) continue;
    const salary = field(seg, 'salary');
    // 城市/类型/经验/学历/人数都在 .list-condition 里，竖杠分隔，形如：
    //   沈阳市 | 全职 | 不限 | 大专 | 招20人
    // 注意页面里还有 .list-addr 这个 class（在侧栏「热招职位」里），不能拿来当岗位城市
    const condition = field(seg, 'list-condition');
    const parts = condition
      .split(/[|｜]/)
      .map((s) => s.replace(/<!--[\s\S]*?-->/g, '').trim())
      .filter(Boolean);
    const cityRaw = parts[0] || '';
    out.push({
      href: href.startsWith('http') ? href : BASE + href,
      title,
      company: field(seg, 'list-company'),
      salary: /面议|K\/月|元\/月|万\/月|\/天|\d+\s*[-–~]\s*\d+/.test(salary) ? salary : '',
      city: /省|市|区|县|北京|上海|天津|重庆/.test(cityRaw) ? cityCanon(cityRaw) : '',
      condition,
      education: parts.find((p) => /^(博士|硕士|本科|大专|专科)$/.test(p)) || '',
      headcount: (condition.match(/招\s*(\d+)\s*人/) || [, ''])[1],
      comType: field(seg, 'list-com-type'),
      from: field(seg, 'source') || field(seg, 'job-source'),
    });
  }
  const seen = new Set();
  return out.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true)));
}

/** 解析详情页 */
export function parseDetail(html) {
  // 页面 <title> 形如「消防设施操作员招聘信息_某某消防维保技术有限公司_就业桥」，
  // 岗位名与公司名都从这里取最稳。注意 company 必须用**原始 title** 匹配 ——
  // 前面把 title 截断成岗位名之后再拿去匹配公司，是取不到的。
  const rawTitle = sanitizeText((html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1]);
  const title = sanitizeText(rawTitle.split(/招聘信息|招聘-|_就业桥/)[0]);
  const company = sanitizeText((rawTitle.match(/_([^_]+?)(?:_就业桥)?$/) || [, ''])[1]);
  const metaDesc = sanitizeText((html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i) || [, ''])[1]);

  // 详情主体：class="detail" 容器（页面里唯一）
  const detailBlock = (html.match(/<div[^>]*class="detail\s*"[^>]*>([\s\S]*?)$/i) || [, ''])[1];
  let body = detailBlock ? htmlToText(decodeEntities(detailBlock)) : '';
  if (!body || body.length < 100) {
    // 兜底：整页文本里从「职位描述/岗位职责」往后截
    const all = htmlToText(decodeEntities(html));
    const i = all.search(/职位描述|岗位职责|任职要求|职位详情|工作内容/);
    body = i >= 0 ? all.slice(i, i + 3000) : all.slice(0, 1500);
  }
  body = body.replace(/\n{2,}/g, '\n').trim();

  const text = htmlToText(decodeEntities(html));
  const pick = (label, len = 40) => {
    const m = text.match(new RegExp(`${label}[:：]?\\s*([^\\n]{1,${len}})`));
    return m ? sanitizeText(m[1]) : '';
  };
  // 薪资必须带单位（K/万/元/月），否则会把页面里任意「400-633」这类数字当成薪资
  const salary = sanitizeText(
    (text.match(
      /((?:\d+(?:\.\d+)?[Kk千万]?)\s*[-–~]\s*\d+(?:\.\d+)?[Kk千万]\/?[月年天]|\d+(?:\.\d+)?[Kk千万]\/[月年天]|面议)/,
    ) || [, ''])[1],
  );
  const education = (text.match(/(博士|硕士|本科|大专|专科|学历不限)(?:及以上)?/) || [, ''])[1] || '';
  // 城市：详情页头部那行形如「岗位名 薪资 公司 沈阳市/沈河区」，直接按「市/州 + 区/县」抽最稳。
  // 不要用「地址：」去抓 —— 页面里的「公司地址：人事部门」会污染结果。
  let city = '';
  const cityMatch = text.match(/([\u4e00-\u9fa5]{2,10}(?:市|自治州))\s*[\/·]\s*([\u4e00-\u9fa5]{2,10}(?:区|县|新区|市))/);
  if (cityMatch) city = cityCanon(cityMatch[1]);
  if (!city) {
    const addrRaw = pick('工作地点') || pick('工作地址');
    if (/省|市|区|县/.test(addrRaw)) city = cityCanon(addrRaw);
  }
  const publishTime = normalizeDate(
    (text.match(/(\d{4}-\d{2}-\d{2})/) || [, ''])[1] || (html.match(/(\d{4}-\d{2}-\d{2})/) || [, ''])[1],
  );

  return {
    title,
    company,
    salary,
    city,
    education,
    publishTime,
    description: truncate(body, 3000),
    summary: truncate(metaDesc, 240),
  };
}

function toJob(item, detail) {
  const title = sanitizeText(detail.title) || sanitizeText(item.title);
  if (!title || title.length < 2) return null;
  const company = sanitizeText(item.company) || sanitizeText(detail.company);
  // id 里带上站内 ID：同一家公司在多个城市挂同名岗位时，只靠 标题|公司|城市 会撞车
  const siteId = (item.href.match(/\/zhiwei\/(\d+)\.html/) || [, ''])[1];
  return {
    id: `${meta.id}:${siteId || `${normKey(title)}|${normKey(company)}|${normKey(item.city)}`}`,
    source: meta.id,
    sourceName: meta.name,
    sources: [meta.id],
    title,
    company,
    city: item.city || detail.city || '',
    district: '',
    salary: item.salary || detail.salary || '',
    education: item.education || detail.education || '',
    experience: (item.condition.match(/(\d+\s*[-–~]?\s*\d*\s*年)/) || [, ''])[1] || '',
    jobType: '校招',
    skills: [],
    tags: [item.comType, item.from, item.headcount ? `招 ${item.headcount} 人` : ''].filter(Boolean),
    publishTime: detail.publishTime || '',
    url: item.href,
    summary: detail.summary || truncate(detail.description, 240),
    description: detail.description || '',
    extra: { platform: '就业桥', comType: item.comType || '', source: item.from || '' },
    isCampus: true,
  };
}

/* ------------------------------ 采集 ------------------------------ */

/**
 * 按关键词从就业桥全国岗位库检索。
 * @param {object} p
 * @param {string[]} p.keywords 检索词（站点支持服务端关键词过滤）
 */
export async function collect({
  keywords = [],
  maxPerKeyword = 10,
  maxPages = 1,
  maxDetail = 8,
  delayMs = 700,
  log = () => {},
  signal,
} = {}) {
  const errors = [];
  const found = [];
  const stats = { queries: 0, listed: 0, detailed: 0 };
  const kws = keywords.filter(Boolean).slice(0, 6);

  for (const kw of kws) {
    if (signal?.aborted) break;
    for (let page = 1; page <= maxPages; page++) {
      if (signal?.aborted) break;
      try {
        const url = `${BASE}/zhiwei/0/?keywords=${encodeURIComponent(kw)}${page > 1 ? `&page=${page}` : ''}`;
        const html = await get(url);
        stats.queries++;
        const items = parseListFragment(html);
        if (!items.length) break;
        for (const it of items.slice(0, maxPerKeyword)) found.push({ ...it, keyword: kw });
        stats.listed += items.length;
        log(`  就业桥「${kw}」第 ${page} 页 → ${items.length} 条`);
      } catch (e) {
        errors.push(`就业桥「${kw}」检索失败：${e.message}`);
      }
      await sleep(delayMs);
    }
  }

  // 去重后按相关性排序，只抓最相关的详情
  const seen = new Set();
  const uniq = found.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true)));
  const ranked = uniq
    .map((x) => {
      let score = 0;
      const hay = `${x.title} ${x.company}`;
      for (const kw of kws) if (hay.includes(kw)) score += 8;
      if (/消防|安全|应急|EHS|机场|航空/.test(hay)) score += 5;
      if (/2027|27届/.test(hay)) score += 6;
      return { ...x, score };
    })
    .sort((a, b) => b.score - a.score);

  const jobs = [];
  for (const item of ranked.slice(0, maxDetail)) {
    if (signal?.aborted) break;
    try {
      const detail = parseDetail(await get(item.href));
      stats.detailed++;
      const job = toJob(item, detail);
      if (job) jobs.push(job);
    } catch (e) {
      errors.push(`就业桥详情抓取失败：${e.message}`);
    }
    await sleep(delayMs);
  }

  log(`就业桥：检索 ${stats.queries} 次，列表 ${stats.listed} 条，抓详情 ${stats.detailed} 条，得到 ${jobs.length} 个岗位`);
  return { jobs, errors, stats: { ...stats, jiuyeqiao: jobs.length } };
}
