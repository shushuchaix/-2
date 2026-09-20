// 牛客校招岗位源
//
// 通道：https://www.nowcoder.com/jobs/school/jobs 的 SSR 内嵌 __INITIAL_STATE__
//   · 每个岗位带结构化字段 graduationYear（"2027届"/"毕业不限"）、jobKeys（技能）、
//     deliverBegin/End（投递窗口）、companyName，是「按届别筛校招」最准的来源。
//   · 该页只服务端渲染固定 20 条，查询参数无效（检索接口需登录），
//     所以定位是「高质量补充源」而非主力：拿到多少算多少，靠届别字段精准筛选。
import { htmlToText, normalizeDate } from '../util/html.mjs';
import { cityCanon, normKey, sanitizeText, truncate } from '../util/text.mjs';

export const meta = {
  id: 'nowcoder',
  name: '牛客校招',
  homepage: 'https://www.nowcoder.com/jobs/school/jobs',
  supportsCityFilter: false,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const JOBS_URL = 'https://www.nowcoder.com/jobs/school/jobs';
const SCHEDULE_URL = 'https://www.nowcoder.com/school/schedule';

async function get(url, timeoutMs = 25000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 带重试的抓取。
 * 牛客的 SSR 偶发只返回壳页面（没有 __INITIAL_STATE__），重试一次通常就能拿到。
 */
async function getWithRetry(url, { attempts = 3, timeoutMs = 25000, log = () => {} } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const html = await get(url, timeoutMs);
      if (/__INITIAL_STATE__/.test(html)) return html;
      last = new Error('页面未包含内嵌数据（可能是壳页面）');
    } catch (e) {
      last = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 900 * (i + 1)));
  }
  throw last;
}

function balancedFrom(text, startIdx) {
  let depth = 0;
  let i = startIdx;
  let inStr = false;
  let esc = false;
  let q = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = true;
      q = c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return text.slice(startIdx, i);
}

function parseState(html) {
  const m = /__INITIAL_STATE__\s*=\s*/.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (/\s/.test(html[i] || '')) i++;
  try {
    return JSON.parse(balancedFrom(html, i).replace(/;\s*$/, ''));
  } catch {
    return null;
  }
}

/** 在 state 里按字段名找数组（app 节点编号会随版本变化，不能写死） */
function findArray(root, field) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur[field]) && cur[field].length) return cur[field];
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}

/**
 * 学历编码 → 文案。
 * 该映射由样本比对得出（把 eduLevel 与 JD 正文里的学历要求对照），
 * 遇到未知编码一律返回空串，宁可不显示也不给错信息。
 */
const EDU_LEVEL = {
  1000: '学历不限',
  2000: '高中',
  3000: '大专',
  4000: '大专',
  5000: '本科',
  6000: '硕士',
  7000: '硕士',
  8000: '博士',
  9000: '博士',
};

function eduText(code) {
  return EDU_LEVEL[Number(code)] || '';
}

/** 月薪：salaryMin/Max 单位为 K，salaryMonth 为薪月数 */
function salaryText(j) {
  const min = Number(j.salaryMin);
  const max = Number(j.salaryMax);
  const months = Number(j.salaryMonth);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return '';
  const base = min && max && min !== max ? `${min}-${max}K` : `${max || min}K`;
  return months && months !== 12 ? `${base}·${months}薪` : base;
}

/** ext 是 JSON 字符串，内含 requirements / infos */
function parseExt(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function msToDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString().slice(0, 10);
}

export function normalizeNowcoderJob(j) {
  if (!j || !j.jobName) return null;
  const ext = parseExt(j.ext);
  const company = sanitizeText(j.recommendInternCompany?.companyName || j.recommendInternCompany?.name || '');
  const cities = Array.isArray(j.jobCityList) && j.jobCityList.length ? j.jobCityList : j.jobCity ? [j.jobCity] : [];
  const skills = String(j.jobKeys || '')
    .split(/[,，、]/)
    .map((s) => sanitizeText(s))
    .filter(Boolean);
  const deliverEnd = msToDate(j.deliverEnd);
  const deliverBegin = msToDate(j.deliverBegin);
  const isIntern = /实习|intern/i.test(String(j.extraInfo?.positionType_var || '')) || Number(j.recruitType) === 0;

  const descParts = [];
  if (ext.requirements) descParts.push(String(ext.requirements));
  if (ext.infos) descParts.push(String(ext.infos));
  if (j.jobAddress) descParts.push(`工作地点：${j.jobAddress}`);
  const description = htmlToText(descParts.join('\n'));

  return {
    id: `nowcoder:${j.id}`,
    source: meta.id,
    sourceName: meta.name,
    sources: [meta.id],
    title: sanitizeText(j.jobName),
    company,
    city: cityCanon(cities[0] || ''),
    district: '',
    salary: salaryText(j),
    education: eduText(j.eduLevel),
    experience: '',
    jobType: isIntern ? '实习' : '校招',
    skills,
    tags: [
      ...(j.graduationYear ? [`${j.graduationYear}`] : []),
      ...(deliverEnd ? [`投递截止 ${deliverEnd}`] : []),
    ],
    publishTime: msToDate(j.refreshTime),
    // 详情页正确路径是 /jobs/detail/{id}（/jobs/school/detail/ 会落到 SPA 空壳页）
    url: `https://www.nowcoder.com/jobs/detail/${j.id}`,
    summary: truncate(sanitizeText(String(ext.requirements || '').replace(/\s+/g, ' ')), 240),
    description,
    extra: {
      // 结构化届别字段 —— 过滤时优先级最高
      graduationYear: sanitizeText(j.graduationYear),
      positionType: sanitizeText(j.extraInfo?.positionType_var),
      deliverBegin,
      deliverEnd,
      eduLevelCode: j.eduLevel,
      recruitType: j.recruitType,
      companyId: j.companyId,
      avgProcessRate: j.avgProcessRate,
      cityList: cities.map(cityCanon).filter(Boolean),
    },
    isCampus: true,
  };
}

/** 抓取校招岗位列表 */
export async function fetchCampusJobs({ timeoutMs = 25000, log = () => {} } = {}) {
  const html = await getWithRetry(JOBS_URL, { timeoutMs, log });
  const state = parseState(html);
  if (!state) return { jobs: [], note: '未找到内嵌数据' };
  const list = findArray(state, 'jobListData') || [];
  return { jobs: list.map(normalizeNowcoderJob).filter(Boolean), raw: list.length };
}

/**
 * 抓取校招日程：公司维度的网申窗口。
 * 对「现在还能投哪些 27 届秋招」这个问题非常直接。
 */
export function normalizeScheduleItem(s) {
  if (!s || !s.name) return null;
  const cities = (Array.isArray(s.cityList) ? s.cityList : []).map(cityCanon).filter(Boolean);
  const begin = msToDate(s.wangshenBeginDate);
  const end = msToDate(s.wangshenEndDate);
  const batch = sanitizeText(s.batchName || s.batch || '');
  return {
    id: `nowcoder-schedule:${normKey(s.name)}|${normKey(batch)}`,
    source: meta.id,
    sourceName: `${meta.name}·校招日程`,
    sources: [meta.id],
    title: `${s.name} 校园招聘网申`,
    company: sanitizeText(s.name),
    city: cities[0] || '',
    district: '',
    salary: '',
    education: '',
    experience: '',
    jobType: '校招',
    skills: [],
    tags: [batch, end ? `网申截止 ${end}` : ''].filter(Boolean),
    publishTime: msToDate(s.updateTime),
    url: `https://www.nowcoder.com/company/${s.companyId}/jobs`,
    summary: `${batch || '校招'}：网申 ${begin || '已开放'} ~ ${end || '待定'}，城市 ${cities.join('/') || '不限'}`,
    description: '',
    extra: {
      batch,
      wangshenBegin: begin,
      wangshenEnd: end,
      companyJobCount: s.companyJobCount || 0,
      schedule: true,
    },
    isCompanyLead: true,
    isCampus: true,
  };
}

export async function fetchSchedule({ timeoutMs = 25000, log = () => {} } = {}) {
  const html = await getWithRetry(SCHEDULE_URL, { timeoutMs, log });
  const state = parseState(html);
  if (!state) return { items: [], note: '未找到内嵌数据' };
  const list = findArray(state, 'datas') || [];
  return { items: list.map(normalizeScheduleItem).filter(Boolean), raw: list.length };
}

/**
 * 采集入口：返回岗位 + 校招日程线索
 * @param {{targetYear?:string, includeSchedule?:boolean, maxSchedule?:number}} opts
 */
export async function collect({ targetYear = '', includeSchedule = true, maxSchedule = 6, log = () => {} } = {}) {
  const errors = [];
  const jobs = [];
  let rawJobs = 0;

  try {
    const r = await fetchCampusJobs({ log });
    rawJobs = r.raw || 0;
    jobs.push(...r.jobs);
    log(`牛客校招：${r.jobs.length} 个岗位${r.note ? `（${r.note}）` : ''}`);
  } catch (e) {
    errors.push(`牛客校招岗位抓取失败：${e.message}`);
  }

  if (includeSchedule) {
    try {
      const s = await fetchSchedule({ log });
      // 只保留与目标届别匹配的批次（batchName 形如「27届秋招」）
      const matched = targetYear
        ? s.items.filter((it) => {
            const y = Number(targetYear);
            const short = String(y).slice(2);
            return new RegExp(`${y}|${short}届`).test(`${it.extra.batch} ${it.title}`);
          })
        : s.items;
      const picked = matched.slice(0, maxSchedule);
      jobs.push(...picked);
      log(`牛客校招日程：${s.items.length} 家公司，匹配目标届别 ${matched.length} 家，取 ${picked.length} 家`);
    } catch (e) {
      errors.push(`牛客校招日程抓取失败：${e.message}`);
    }
  }

  return { jobs, errors, stats: { nowcoder: jobs.length, nowcoderRaw: rawJobs } };
}
