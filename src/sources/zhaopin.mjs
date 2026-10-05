import { sourceFetch as fetch } from "./request-context.mjs";
// 智联招聘适配器
// 通道：列表页 SSR 内嵌 __INITIAL_STATE__ → positionList[]（真实结构化岗位）
//       详情页 SSR 内嵌 jobDetail → 完整 JD 正文
import {
  extractAssignedJson,
  htmlToText,
  normalizeDate,
} from "../util/html.mjs";
import {
  cityCanon,
  cleanTitle,
  sanitizeText,
  sleep,
  truncate,
} from "../util/text.mjs";

export const meta = {
  id: "zhaopin",
  name: "智联招聘",
  homepage: "https://www.zhaopin.com",
  supportsCityFilter: false,
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 智联城市代码（jl 参数）。列表页 SSR 对 city 参数支持不稳定，因此主要依赖抓取后按 workCity 过滤。
export const CITY_CODES = {
  全国: 489,
  北京: 530,
  上海: 538,
  广州: 763,
  深圳: 765,
  天津: 531,
  重庆: 551,
  杭州: 653,
  南京: 635,
  成都: 801,
  武汉: 736,
  西安: 854,
  苏州: 639,
  长沙: 749,
  郑州: 719,
  青岛: 702,
  合肥: 664,
  厦门: 682,
  宁波: 654,
  无锡: 636,
  佛山: 768,
  东莞: 766,
  济南: 704,
  福州: 681,
  大连: 600,
  沈阳: 599,
  哈尔滨: 598,
  昆明: 831,
  南昌: 738,
  贵阳: 826,
  石家庄: 5381,
  太原: 5831,
};

function defaultHeaders() {
  return {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
    "Cache-Control": "no-cache",
  };
}

export function buildListUrl(keyword, page = 1, city = "全国") {
  const jl =
    CITY_CODES[cityCanon(city)] ?? CITY_CODES[city] ?? CITY_CODES["全国"];
  const params = new URLSearchParams({
    kw: keyword,
    jl: String(jl),
    p: String(page),
  });
  return `https://www.zhaopin.com/sou?${params.toString()}`;
}

function pickTags(pos) {
  const out = [];
  for (const t of pos.skillLabel || []) if (t?.value) out.push(String(t.value));
  for (const t of pos.jobSkillTags || []) if (t?.name) out.push(String(t.name));
  return [...new Set(out)];
}

function pickShowTags(pos) {
  const out = [];
  for (const t of pos.showSkillTags || []) if (t?.tag) out.push(String(t.tag));
  return [...new Set(out)];
}

/** 归一化为统一 Job 结构 */
export function normalizePosition(pos) {
  if (!pos || !pos.name) return null;
  const url = String(pos.positionURL || pos.positionUrl || "")
    .replace(/^http:\/\//i, "https://")
    .trim();
  const jobId = pos.jobId || pos.number || "";
  const skills = pickTags(pos);
  const showTags = pickShowTags(pos);
  return {
    id: `zhaopin:${jobId}`,
    sourceRecordId: String(jobId),
    source: meta.id,
    sourceName: meta.name,
    sources: [meta.id],
    title: cleanTitle(pos.name),
    company: sanitizeText(pos.companyName),
    city: cityCanon(pos.workCity || ""),
    district: sanitizeText(
      [pos.cityDistrict, pos.streetName].filter(Boolean).join(" "),
    ),
    salary: sanitizeText(pos.salary60 || pos.salaryReal),
    education: sanitizeText(pos.education),
    experience: sanitizeText(pos.workingExp),
    jobType: sanitizeText(pos.workType),
    skills,
    tags: showTags,
    publishTime: normalizeDate(pos.publishTime),
    url: url || (jobId ? `https://www.zhaopin.com/jobdetail/${jobId}.htm` : ""),
    summary: sanitizeText(pos.jobSummary),
    description: "",
    extra: {
      jobId,
      number: pos.number || "",
      industry: pos.industryName || "",
      companySize: pos.companySize || "",
      property: pos.property || pos.propertyName || "",
      subJobType: pos.subJobTypeLevelName || "",
      canRemoteInternship: Boolean(pos.canRemoteInternship),
      provideInternshipCertificate: Boolean(pos.provideInternshipCertificate),
      internshipMonths: pos.internshipMonths || 0,
      weeklyInternshipDays: pos.weeklyInternshipDays || 0,
      companyUrl: pos.companyUrl || "",
    },
  };
}

/** 抓取一页列表 */
export async function fetchListPage(
  keyword,
  page = 1,
  { city = "全国", timeoutMs = 25000 } = {},
) {
  const url = buildListUrl(keyword, page, city);
  const res = await fetch(url, {
    headers: defaultHeaders(),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`智联列表页 HTTP ${res.status}`);
  const html = await res.text();
  const state = extractAssignedJson(html, "__INITIAL_STATE__");
  if (!state || !Array.isArray(state.positionList))
    throw Error("parse_error: 智联列表缺少 positionList");
  const list = Array.isArray(state.positionList) ? state.positionList : [];
  const jobs = list.map(normalizePosition).filter(Boolean);
  return {
    jobs,
    pages: Number(state.pages) || 1,
    pageIndex: Number(state.pageIndex) || page,
    total: Number(state.positionCount) || jobs.length,
    url,
  };
}

/** 多页抓取 */
export async function search({
  keyword,
  city = "全国",
  maxPages = 3,
  delayMs = 600,
  log = () => {},
  signal,
} = {}) {
  const collected = [];
  const errors = [];
  let totalPages = 1;
  for (let p = 1; p <= maxPages; p++) {
    if (signal?.aborted) break;
    try {
      const r = await fetchListPage(keyword, p, { city });
      totalPages = Math.max(totalPages, r.pages || 1);
      collected.push(...r.jobs);
      log(`智联「${keyword}」第 ${p} 页 → ${r.jobs.length} 条`);
      if (r.jobs.length === 0) break;
      if (p >= (r.pages || 1)) break;
    } catch (e) {
      errors.push(`p${p}: ${e.message}`);
      log(`智联「${keyword}」第 ${p} 页失败：${e.message}`);
    }
    if (p < maxPages) await sleep(delayMs);
  }
  return { jobs: collected, errors, totalPages };
}

/** 解析详情页 state 中的 JD 正文 */
function extractDetailFromState(state) {
  const jd = state?.jobDetail;
  if (!jd) return null;
  const dp = jd.detailedPosition || {};
  const position = dp.position || dp.base || {};
  const desc =
    position.description ||
    position.positionDescription ||
    dp.description ||
    jd.jobSummary ||
    "";
  const requirement =
    position.requirement ||
    position.positionRequirement ||
    dp.requirement ||
    "";
  const parts = [desc, requirement].filter(
    (x) => typeof x === "string" && x.trim(),
  );
  return parts.length ? htmlToText(parts.join("\n")) : null;
}

/** 详情页正文兜底：从可见文本中截取「职位描述」段落 */
function extractDetailFromText(html) {
  const text = htmlToText(html);
  if (!text) return null;
  const startMarkers = ["职位描述", "岗位职责", "工作职责", "职位详情"];
  const endMarkers = [
    "公司信息",
    "公司简介",
    "工作地址",
    "工商信息",
    "竞争力分析",
    "相似职位",
    "举报",
  ];
  let start = -1;
  for (const m of startMarkers) {
    const i = text.indexOf(m);
    if (i !== -1 && (start === -1 || i < start)) start = i;
  }
  if (start === -1) return null;
  let end = text.length;
  for (const m of endMarkers) {
    const i = text.indexOf(m, start + 6);
    if (i !== -1 && i < end) end = i;
  }
  const slice = text.slice(start, Math.min(end, start + 6000)).trim();
  return slice.length > 40 ? slice : null;
}

/** 抓取单个岗位的完整 JD */
export async function fetchDetail(job, { timeoutMs = 25000 } = {}) {
  if (!job?.url) return { description: "", companyInfo: "" };
  const res = await fetch(job.url, {
    headers: defaultHeaders(),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`智联详情页 HTTP ${res.status}`);
  const html = await res.text();
  const state = extractAssignedJson(html, "__INITIAL_STATE__");
  let description = state ? extractDetailFromState(state) : null;
  if (!description) description = extractDetailFromText(html);
  if (!description) description = truncate(htmlToText(html), 2000);

  let companyInfo = "";
  const dp = state?.jobDetail?.detailedPosition || {};
  const company = dp.company || state?.jobDetail?.detailedCompany || {};
  const cname = company.companyName || company.name;
  if (cname) {
    const size = company.companySize || "";
    const ind = company.industryName || "";
    companyInfo = [cname, size, ind].filter(Boolean).join(" · ");
  }
  return { description, companyInfo };
}
