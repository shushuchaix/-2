import { sourceFetch as fetch } from './request-context.mjs';
// 晨云智慧就业管理服务系统 岗位源
//
// 为什么单独写一个源：中国民用航空飞行学院（及多所院校）用的**不是**才立方那套系统，
// 而是「晨云智慧就业管理服务系统」（技术支持：成都晨云信息技术有限责任公司）。
// 它对任意未知路径都返回首页，所以按才立方的域名/路径特征去探测会一律判为「不支持」——
// 这就是最初把 jy.cafuc.edu.cn 判错的原因。
//
// 实测接口（2026-09 验证）：
//   列表：POST /index/index/employjoblistdata.html   body: page=N
//         ⚠️ 必须是 POST + page 参数；GET 会抛 think\exception（Undefined array key "page"）
//         返回 <li> 片段，含 .post-title / .tips>span / .company-infor h3
//   详情：GET  /index/index/employjobdetail.html?data=<token>
//   搜索：列表接口**不支持**关键词过滤（keyword / search_key / key 全被忽略，title 会直接报错），
//         所以策略是「翻完全部页 → 本地按关键词排序 → 只抓高相关的详情」。
//         单校岗位量很小（实测 2 页约 50 条），全量翻页成本可接受。
import { htmlToText, decodeEntities, normalizeDate } from '../util/html.mjs';
import { cityCanon, normKey, sanitizeText, sleep, truncate } from '../util/text.mjs';
// 校名规范化与本校判定在 common.mjs 里统一实现（原先这里复制了一份，容易和 university.mjs 走偏）
import { isOwnSchool } from './common.mjs';

export { isOwnSchool };

export const meta = {
  id: 'chenyun',
  name: '高校就业网·晨云',
  homepage: 'https://jy.cafuc.edu.cn',
  supportsCityFilter: false,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 使用「晨云智慧就业管理服务系统」的高校就业网。
 * 判据：`/index/index/employjoblistdata.html` 能 POST 出列表。
 */
export const CHENYUN_HOSTS = [
  {
    name: '中国民用航空飞行学院',
    host: 'https://jy.cafuc.edu.cn',
    kind: 'aviation',
    aliases: ['中飞院', '民航飞行学院', '中国民用航空飞行学院', 'CAFUC'],
  },
];

/* ------------------------------ HTTP ------------------------------ */

async function req(host, path, { method = 'GET', form = null, timeoutMs = 20000 } = {}) {
  const res = await fetch(host + path, {
    method,
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: `${host}/index/index/employjob.html`,
      ...(method === 'POST' ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
      ...(form != null ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
    },
    body: form,
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
  // ThinkPHP 出错时会返回 array(...) 调试转储，必须显式识别，否则会被当成「没数据」静默吞掉
  if (/think\\exception|^<pre>array\(/i.test(text.trim())) {
    const m = text.match(/"message"\]\s*=>\s*string\(\d+\)\s*"([^"]+)"/);
    throw new Error(`站点返回 PHP 异常：${m ? m[1] : '未知'}`);
  }
  return text;
}

/* ------------------------------ 解析 ------------------------------ */

/** 探测某个 host 是否是晨云系统且列表可用 */
export async function probeHost(host, timeoutMs = 12000) {
  try {
    const html = await req(host, '/index/index/employjoblistdata.html', {
      method: 'POST',
      form: 'page=1',
      timeoutMs,
    });
    return parseListFragment(html).length >= 3;
  } catch {
    return false;
  }
}

/** 解析列表片段（POST employjoblistdata.html 的返回） */
export function parseListFragment(html) {
  const out = [];
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  for (const li of items) {
    const href = (li.match(/href="([^"]*employjobdetail\.html[^"]*)"/) || [, ''])[1];
    if (!href) continue;
    const title = sanitizeText(htmlToText((li.match(/class="post-title"[^>]*>([\s\S]*?)<\/a>/) || [, ''])[1]));
    if (!title) continue;
    const spans = [...li.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => sanitizeText(decodeEntities(m[1]))).filter(Boolean);
    const company = sanitizeText(
      htmlToText((li.match(/class="company-infor"[\s\S]*?<h3>\s*<a[^>]*>([\s\S]*?)<\/a>/) || [, ''])[1]),
    );
    // spans 顺序：城市 / 类型 / 学历 / 单位性质
    const city = cityCanon(spans.find((s) => /省|市|区|北京|上海|天津|重庆|全国/.test(s)) || '');
    const jobType = spans.find((s) => /^(全职|兼职|实习|不限)$/.test(s)) || '';
    const education = spans.find((s) => /(专科|本科|硕士|博士|学历不限|及以上)/.test(s)) || '';
    const nature = spans.find((s) => /企业|单位|机关|部队|其他/.test(s)) || '';
    out.push({ href, title, company, city, jobType, education, nature });
  }
  // 同一链接去重
  const seen = new Set();
  return out.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true)));
}

/** 解析岗位详情页（选择器依据 2026-09 实测的页面结构） */
export function parseDetail(html) {
  // 标题：.infor-tllf > h3，注意里面还嵌了 <span class="update-time">发布于…</span>，必须剥掉
  const titleBlock = (html.match(/class="infor-tllf"[\s\S]*?<h3>([\s\S]*?)<\/h3>/i) || [, ''])[1];
  const title = sanitizeText(htmlToText(titleBlock.replace(/<span[^>]*class="update-time"[\s\S]*?<\/span>/i, '')));
  const publishTime = normalizeDate(
    (titleBlock.match(/class="update-time"[^>]*>[\s\S]*?(\d{4}-\d{2}-\d{2})/) || [, ''])[1],
  );
  const salaryRaw = sanitizeText(htmlToText((html.match(/<p[^>]*class="pay"[^>]*>([\s\S]*?)<\/p>/i) || [, ''])[1]));
  const salary = /未填写|面议|登录查看/.test(salaryRaw) ? salaryRaw === '面议' ? '面议' : '' : salaryRaw;

  // 条件行：<p class="tips-l">全职</p><p class="tips-l">专科及以上</p><p class="tips-l">招1人</p>
  const tips = [...html.matchAll(/<p[^>]*class="tips-l"[^>]*>([\s\S]*?)<\/p>/gi)].map((m) =>
    sanitizeText(htmlToText(m[1])),
  );
  const jobType = tips.find((t) => /^(全职|兼职|实习|不限)$/.test(t)) || '';
  const education = tips.find((t) => /(专科|本科|硕士|博士)/.test(t)) || '';
  const headcount = (tips.find((t) => /招\s*\d+\s*人/.test(t)) || '').replace(/[^\d]/g, '');

  const expire = normalizeDate(
    (html.match(/class="infor-foll"[\s\S]{0,200}?(\d{4}-\d{2}-\d{2})/) || [, ''])[1],
  );

  // 专业：.infor-cont 里第一块「专业 / 专业不限」
  const majorBlock = sanitizeText(htmlToText((html.match(/class="infor-cont"[^>]*>([\s\S]{0,600}?)<\/div>/i) || [, ''])[1]));
  const major = sanitizeText(majorBlock.replace(/^专业\s*/, '').split(/联系方式|邮箱|单位电话/)[0] || '');

  // 正文：这是真正装 JD 的容器
  let requirement = sanitizeText(
    htmlToText((html.match(/id="index_detail_content"[^>]*>([\s\S]*?)<\/div>/i) || [, ''])[1]),
  );
  if (!requirement) {
    // 兜底：取第一个 .job_need
    requirement = sanitizeText(htmlToText((html.match(/class="[^"]*job_need[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [, ''])[1]));
  }

  // 工作地址：详情页「工作地址」模块
  const text = htmlToText(decodeEntities(html));
  const addrIdx = text.indexOf('工作地址');
  const address = addrIdx >= 0 ? sanitizeText(text.slice(addrIdx + 4).split('\n').find((l) => l.trim()) || '') : '';

  // 公司名在「其他职位」之后那段；列表页给的公司名更可靠，这里只作兜底
  const company =
    sanitizeText(htmlToText((html.match(/class="company-name"[^>]*>([\s\S]*?)<\/[^>]+>/i) || [, ''])[1])) ||
    sanitizeText(
      (text.match(/其他职位[\s\S]{0,30}\n([^\n]{4,40}(?:公司|集团|银行|局|院|中心|机场|航空|厂|所|部))\n/) || [, ''])[1],
    );
  const industry =
    (text.match(/\n(交通运输、仓储和邮政业|制造业|建筑业|教育|金融业|科学研究和技术服务业|[^\n]{2,18}业)\n/) || [, ''])[1] || '';

  return {
    title,
    company,
    city: cityCanon(address),
    address,
    salary,
    education,
    jobType,
    headcount,
    major,
    expire,
    industry,
    requirement,
    description: truncate(
      [requirement, address ? `工作地址：${address}` : ''].filter(Boolean).join('\n'),
      3000,
    ),
    publishTime,
  };
}

/* ------------------------------ 统一结构 ------------------------------ */

function toJob(listItem, hostInfo, detail) {
  const title = sanitizeText(detail.title) || sanitizeText(listItem.title);
  if (!title || title.length < 2) return null;
  // 公司名以列表页为准：详情页的公司块混在「其他职位/单位介绍」里，容易误抓到小标题
  const company = sanitizeText(listItem.company) || sanitizeText(detail.company);
  return {
    id: `chenyun:${normKey(hostInfo.name)}:${normKey(title)}|${normKey(company)}`,
    source: meta.id,
    sourceName: `${meta.name}·${hostInfo.name}`,
    sources: [meta.id],
    title,
    company,
    city: detail.city || listItem.city || '',
    district: '',
    salary: detail.salary || '',
    education: detail.education || listItem.education || '',
    experience: '',
    jobType: detail.jobType || listItem.jobType || '校招',
    skills: [],
    tags: [
      hostInfo.name,
      ...(detail.major ? [`专业：${detail.major}`] : []),
      ...(detail.headcount ? [`招 ${detail.headcount} 人`] : []),
      ...(detail.expire ? [`截止 ${detail.expire}`] : []),
      ...(detail.industry ? [detail.industry] : []),
    ].filter(Boolean),
    publishTime: detail.publishTime || '',
    url: listItem.href.startsWith('http') ? listItem.href : `${hostInfo.host}${listItem.href}`,
    summary: truncate(detail.requirement || '', 240),
    description: detail.description || '',
    extra: {
      university: hostInfo.name,
      kind: '晨云就业系统',
      major: detail.major || '',
      headcount: detail.headcount || '',
      expire: detail.expire || '',
      address: detail.address || '',
      nature: listItem.nature || '',
    },
    isCampus: true,
  };
}

/* ------------------------------ 采集 ------------------------------ */

/**
 * 从晨云系统高校就业网采集岗位。
 * @param {object} p
 * @param {string[]} p.keywords  检索词（用于**本地排序**，站点本身不支持关键词过滤）
 * @param {object[]} [p.hosts]   高校列表；不传则用 CHENYUN_HOSTS
 */
export async function collect({
  keywords = [],
  hosts = null,
  profile = null,
  maxHosts = 2,
  maxPages = 6,
  maxDetail = 12,
  delayMs = 800,
  log = () => {},
  signal,
} = {}) {
  const errors = [];
  const jobs = [];
  const stats = { hosts: 0, listed: 0, detailed: 0, pages: 0 };
  // 显式给了 hosts 就用它；否则优先选与简历学校同名的站点，没有匹配再用全部
  let pool = hosts?.length ? hosts : CHENYUN_HOSTS;
  if (!hosts?.length && profile?.school) {
    const own = CHENYUN_HOSTS.filter((h) => isOwnSchool(h, profile));
    if (own.length) pool = own;
  }
  const activeHosts = pool.slice(0, maxHosts);

  for (const hostInfo of activeHosts) {
    if (signal?.aborted) break;
    const listed = [];
    try {
      for (let page = 1; page <= maxPages; page++) {
        if (signal?.aborted) break;
        const html = await req(hostInfo.host, '/index/index/employjoblistdata.html', {
          method: 'POST',
          form: `page=${page}`,
        });
        stats.pages++;
        const items = parseListFragment(html);
        if (!items.length) break; // 翻到空页说明到底了
        listed.push(...items);
        await sleep(delayMs);
      }
      stats.listed += listed.length;
      stats.hosts++;
      log(`  ${hostInfo.name}：翻 ${stats.pages} 页，列表 ${listed.length} 条`);
    } catch (e) {
      errors.push(`${hostInfo.name} 列表抓取失败：${e.message}`);
      log(`  ${hostInfo.name} 列表抓取失败：${e.message}`);
      continue;
    }

    // 站点不支持关键词搜索 → 本地排序，只抓最相关的详情
    // 注意：只有「消防」这类词能命中，通用校招词（2027届/校招）不该拉高排序，
    // 否则会去抓一堆与该专业无关的岗位详情。
    const SPECIFIC = keywords.filter((k) => k && k.length >= 2 && !/^\d{2}届|校招|校园招聘|应届/.test(k));
    const ranked = listed
      .map((x) => {
        let score = 0;
        const hay = `${x.title} ${x.company}`;
        for (const kw of SPECIFIC) if (kw && hay.includes(kw)) score += 10;
        if (/消防|安全|应急|机场|航空|民航/.test(hay)) score += 6;
        if (/2027|27届/.test(hay)) score += 8;
        return { ...x, score };
      })
      .sort((a, b) => b.score - a.score);

    const picked = ranked.slice(0, maxDetail);
    if (!picked.length) log(`  ${hostInfo.name}：列表为空，跳过`);
    for (const item of picked) {
      if (signal?.aborted) break;
      try {
        const url = item.href.startsWith('http') ? item.href : `${hostInfo.host}${item.href}`;
        const html = await req(hostInfo.host, url.replace(hostInfo.host, ''));
        const detail = parseDetail(html);
        stats.detailed++;
        const job = toJob(item, hostInfo, detail);
        if (job) jobs.push(job);
      } catch (e) {
        errors.push(`${hostInfo.name} 详情抓取失败：${e.message}`);
      }
      await sleep(delayMs);
    }
  }

  const names = activeHosts.map((h) => h.name).join('、') || '（无）';
  log(
    `晨云高校就业网：${names}｜翻页 ${stats.pages} 次，列表 ${stats.listed} 条，抓详情 ${stats.detailed} 条，得到 ${jobs.length} 个岗位`,
  );
  return { jobs, errors, stats: { ...stats, chenyun: jobs.length } };
}
