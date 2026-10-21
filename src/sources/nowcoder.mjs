import { sourceFetch as fetch } from "./request-context.mjs";
import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
// 牛客校招岗位源
//
// 通道：https://www.nowcoder.com/jobs/school/jobs 的 SSR 内嵌 __INITIAL_STATE__
//   · 每个岗位带结构化字段 graduationYear（"2027届"/"毕业不限"）、jobKeys（技能）、
//     deliverBegin/End（投递窗口）、companyName，是「按届别筛校招」最准的来源。
//   · 该页只服务端渲染固定 20 条，查询参数无效（检索接口需登录），
//     所以定位是「高质量补充源」而非主力：拿到多少算多少，靠届别字段精准筛选。
import { htmlToText, normalizeDate } from "../util/html.mjs";
import { cityCanon, normKey, sanitizeText, truncate } from "../util/text.mjs";

export const meta = {
  id: "nowcoder",
  name: "牛客校招",
  homepage: "https://www.nowcoder.com/jobs/school/jobs",
  supportsCityFilter: false,
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const JOBS_URL = "https://www.nowcoder.com/jobs/school/jobs";
const SCHEDULE_URL = "https://www.nowcoder.com/school/schedule";

async function get(url, timeoutMs = 25000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Read one SSR page; missing native state remains an explicit parse failure. */
async function getInitialStatePage(url, { timeoutMs = 25000 } = {}) {
  const html = await get(url, timeoutMs);
  if (!/__INITIAL_STATE__/.test(html))
    throw Error("parse_error: 页面未包含内嵌数据");
  return html;
}

function balancedFrom(text, startIdx) {
  let depth = 0;
  let i = startIdx;
  let inStr = false;
  let esc = false;
  let q = "";
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = true;
      q = c;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
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
  while (/\s/.test(html[i] || "")) i++;
  try {
    return JSON.parse(balancedFrom(html, i).replace(/;\s*$/, ""));
  } catch {
    throw Object.assign(Error("parse_error: 内嵌 JSON 无效"), {
      code: "parse_error",
    });
  }
}

/** 在 state 里按字段名找数组（app 节点编号会随版本变化，不能写死） */
function findArray(root, field) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur[field])) return cur[field];
    for (const v of Object.values(cur))
      if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

/**
 * 学历编码 → 文案。
 * 该映射由样本比对得出（把 eduLevel 与 JD 正文里的学历要求对照），
 * 遇到未知编码一律返回空串，宁可不显示也不给错信息。
 */
const EDU_LEVEL = {
  1000: "学历不限",
  2000: "高中",
  3000: "大专",
  4000: "大专",
  5000: "本科",
  6000: "硕士",
  7000: "硕士",
  8000: "博士",
  9000: "博士",
};

function eduText(code) {
  return EDU_LEVEL[Number(code)] || "";
}

/** 月薪：salaryMin/Max 单位为 K，salaryMonth 为薪月数 */
function salaryText(j) {
  const min = Number(j.salaryMin);
  const max = Number(j.salaryMax);
  const months = Number(j.salaryMonth);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return "";
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
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

export function normalizeNowcoderJob(j) {
  if (!j || !j.jobName) return null;
  if (
    (typeof j.id !== "string" && typeof j.id !== "number") ||
    (typeof j.id === "number" && !Number.isSafeInteger(j.id))
  )
    return null;
  const sourceRecordId = String(j.id).trim();
  if (
    !/^[A-Za-z0-9_-]{1,120}$/.test(sourceRecordId) ||
    /^(?:undefined|null|NaN|Infinity)$/i.test(sourceRecordId)
  )
    return null;
  const ext = parseExt(j.ext);
  const company = sanitizeText(
    j.recommendInternCompany?.companyName ||
      j.recommendInternCompany?.name ||
      "",
  );
  const cities =
    Array.isArray(j.jobCityList) && j.jobCityList.length
      ? j.jobCityList
      : j.jobCity
        ? [j.jobCity]
        : [];
  const skills = String(j.jobKeys || "")
    .split(/[,，、]/)
    .map((s) => sanitizeText(s))
    .filter(Boolean);
  const deliverEnd = msToDate(j.deliverEnd);
  const deliverBegin = msToDate(j.deliverBegin);
  const isIntern =
    /实习|intern/i.test(String(j.extraInfo?.positionType_var || "")) ||
    Number(j.recruitType) === 0;

  const descParts = [];
  if (ext.requirements) descParts.push(String(ext.requirements));
  if (ext.infos) descParts.push(String(ext.infos));
  if (j.jobAddress) descParts.push(`工作地点：${j.jobAddress}`);
  const description = htmlToText(descParts.join("\n"));

  return {
    id: `nowcoder:${sourceRecordId}`,
    sourceRecordId,
    source: meta.id,
    sourceName: meta.name,
    sources: [meta.id],
    title: sanitizeText(j.jobName),
    company,
    city: cityCanon(cities[0] || ""),
    district: "",
    salary: salaryText(j),
    education: eduText(j.eduLevel),
    experience: "",
    jobType: isIntern ? "实习" : "校招",
    skills,
    tags: [
      ...(j.graduationYear ? [`${j.graduationYear}`] : []),
      ...(deliverEnd ? [`投递截止 ${deliverEnd}`] : []),
    ],
    publishTime: "",
    // 详情页正确路径是 /jobs/detail/{id}（/jobs/school/detail/ 会落到 SPA 空壳页）
    url: `https://www.nowcoder.com/jobs/detail/${j.id}`,
    summary: truncate(
      sanitizeText(String(ext.requirements || "").replace(/\s+/g, " ")),
      240,
    ),
    description,
    bodyStatus: "incomplete",
    detailStatus: "incomplete",
    extra: {
      refreshTime: j.refreshTime,
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

function detailError(code, message) {
  return Object.assign(Error(`${code}: ${message}`), {
    code,
    retryable: false,
  });
}

function detailId(raw) {
  if (
    (typeof raw !== "string" && typeof raw !== "number") ||
    (typeof raw === "number" && !Number.isSafeInteger(raw))
  )
    return "";
  const id = String(raw).trim();
  return /^[A-Za-z0-9_-]{1,120}$/.test(id) &&
    !/^(?:undefined|null|NaN|Infinity)$/i.test(id)
    ? id
    : "";
}

const WINDOW_SELECTOR = ".job-detail-word .job-detail-infos > .deliver-range";
const WINDOW_PATHS = {
  startsAt: "store.jobDetail.detail.deliverBegin",
  deadlineAt: "store.jobDetail.detail.deliverEnd",
};
function readDetailWindow(html, native, job) {
  const result = {
    startsAt: null,
    deadlineAt: null,
    deadline: null,
    sourceEvidence: (job.sourceEvidence || []).filter(
      (e) => !["startsAt", "deadlineAt", "deadline"].includes(e.field),
    ),
    evidenceConflicts: (job.evidenceConflicts || []).filter(
      (e) =>
        !(
          WINDOW_PATHS[e.field] &&
          e.sourceId === meta.id &&
          e.sourcePath === WINDOW_PATHS[e.field] &&
          ["visible_structured_conflict", "invalid_structured_time"].includes(
            e.code,
          )
        ),
    ),
  };
  const conflict = (field, code) =>
    result.evidenceConflicts.push({
      field,
      code,
      sourceId: meta.id,
      sourcePath: WINDOW_PATHS[field],
    });
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll(
    'script,style,[hidden],[aria-hidden="true"]',
  ))
    node.remove();
  for (const node of document.querySelectorAll("[style]"))
    if (
      /display\s*:\s*none|visibility\s*:\s*hidden/i.test(
        node.getAttribute("style"),
      )
    )
      node.remove();
  const headings = document.querySelectorAll(".job-detail-wrap h1.title");
  const ranges = document.querySelectorAll(WINDOW_SELECTOR);
  if (
    headings.length !== 1 ||
    sanitizeText(headings[0].textContent) !== sanitizeText(native.jobName) ||
    ranges.length !== 1
  )
    return result;
  const visible = ranges[0].textContent.trim();
  if (!/投递时间|投递日期/.test(visible)) return result;
  const dates = [
    ...visible.matchAll(/(20\d\d)[年.\/-](\d{1,2})[月.\/-](\d{1,2})/g),
  ].map((m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  if (dates.length !== 2) return result;
  const fields = [
    ["startsAt", "deliverBegin", dates[0]],
    ["deadlineAt", "deliverEnd", dates[1]],
  ];
  for (const [field, key, visibleDate] of fields) {
    const value = native[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      !Number.isFinite(new Date(value).getTime()) ||
      !Number.isFinite(new Date(value + 8 * 3600000).getTime())
    ) {
      conflict(field, "invalid_structured_time");
      return result;
    }
    if (
      new Date(value + 8 * 3600000).toISOString().slice(0, 10) !== visibleDate
    ) {
      conflict(field, "visible_structured_conflict");
      return result;
    }
  }
  if (native.deliverBegin > native.deliverEnd) {
    conflict("deadlineAt", "invalid_structured_time");
    return result;
  }
  for (const [field, key] of fields) {
    const value = new Date(native[key]).toISOString();
    const sourcePath = `store.jobDetail.detail.${key}`;
    result[field] = value;
    result.sourceEvidence.push({
      evidenceId:
        "nowcoder-window-" +
        createHash("sha256")
          .update(job.url + field + value)
          .digest("hex")
          .slice(0, 24),
      field,
      value,
      status: "verified",
      sourceId: meta.id,
      sourceUrl: job.url,
      sourceKind: "native_state",
      sourcePath,
      sourceExcerpt: visible,
      location: { jsonPath: sourcePath, selector: WINDOW_SELECTOR },
      parserVersion: "nowcoder-detail-1",
      confidence: 100,
    });
  }
  return result;
}

/** Only the requested job's native detail payload can establish complete JD evidence. */
export async function fetchDetail(job, { timeoutMs = 25000 } = {}) {
  let url;
  try {
    url = new URL(job?.url);
  } catch {
    throw detailError("parse_error", "牛客详情 URL 无效");
  }
  const urlId = url.pathname.match(
    /^\/jobs\/detail\/([A-Za-z0-9_-]{1,120})\/?$/,
  )?.[1];
  const expectedId = detailId(job.sourceRecordId);
  if (
    url.origin !== "https://www.nowcoder.com" ||
    url.username ||
    url.password ||
    !expectedId ||
    urlId !== expectedId
  )
    throw detailError("parse_error", "牛客详情 URL 与岗位身份不符");
  const html = await get(url.href, timeoutMs);
  let state;
  try {
    state = parseState(html);
  } catch (error) {
    error.retryable = false;
    throw error;
  }
  const scoped = state?.store?.jobDetail;
  const native = scoped?.detail;
  if (
    !native ||
    detailId(native.id) !== expectedId ||
    (scoped.jobId !== undefined && detailId(scoped.jobId) !== expectedId) ||
    typeof native.jobName !== "string" ||
    !sanitizeText(native.jobName)
  )
    throw detailError("parse_error", "牛客原生详情缺失或岗位身份不符");
  let ext;
  try {
    if (typeof native.ext !== "string") throw Error();
    ext = JSON.parse(native.ext);
    if (
      !ext ||
      typeof ext !== "object" ||
      Array.isArray(ext) ||
      typeof ext.infos !== "string" ||
      typeof ext.requirements !== "string"
    )
      throw Error();
  } catch {
    throw detailError("parse_error", "牛客原生详情 ext JSON 或正文字段无效");
  }
  const description = htmlToText([ext.infos, ext.requirements].join("\n"));
  if (!description)
    throw detailError("detail_insufficient", "牛客原生详情正文为空");
  return {
    title: sanitizeText(native.jobName),
    company: sanitizeText(scoped.jobCompany?.companyName) || job.company || "",
    description,
    bodyStatus: "complete",
    detailStatus: "complete",
    retryEligible: false,
    extra: {
      ...job.extra,
      nativeStatus: native.status,
      deliverBegin: msToDate(native.deliverBegin),
      deliverEnd: msToDate(native.deliverEnd),
    },
    ...readDetailWindow(html, native, job),
  };
}

/** 抓取校招岗位列表 */
export async function fetchCampusJobs({
  timeoutMs = 25000,
  log = () => {},
} = {}) {
  const html = await getInitialStatePage(JOBS_URL, { timeoutMs, log });
  const state = parseState(html);
  const list = state && findArray(state, "jobListData");
  if (!list)
    throw Object.assign(Error("parse_error: 缺少内嵌岗位列表"), {
      code: "parse_error",
    });
  return {
    jobs: list.map(normalizeNowcoderJob).filter(Boolean),
    raw: list.length,
  };
}

/**
 * 抓取校招日程：公司维度的网申窗口。
 * 对「现在还能投哪些 27 届秋招」这个问题非常直接。
 */
export function normalizeScheduleItem(s) {
  if (!s || !s.name) return null;
  const cities = (Array.isArray(s.cityList) ? s.cityList : [])
    .map(cityCanon)
    .filter(Boolean);
  const begin = msToDate(s.wangshenBeginDate);
  const end = msToDate(s.wangshenEndDate);
  const batch = sanitizeText(s.batchName || s.batch || "");
  return {
    id: `nowcoder-schedule:${normKey(s.name)}|${normKey(batch)}`,
    source: meta.id,
    sourceName: `${meta.name}·校招日程`,
    sources: [meta.id],
    title: `${s.name} 校园招聘网申`,
    company: sanitizeText(s.name),
    city: cities[0] || "",
    district: "",
    salary: "",
    education: "",
    experience: "",
    jobType: "校招",
    skills: [],
    tags: [batch, end ? `网申截止 ${end}` : ""].filter(Boolean),
    publishTime: "",
    url: `https://www.nowcoder.com/company/${s.companyId}/jobs`,
    summary: `${batch || "校招"}：网申 ${begin || "已开放"} ~ ${end || "待定"}，城市 ${cities.join("/") || "不限"}`,
    description: "",
    extra: {
      updateTime: s.updateTime,
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

export async function fetchSchedule({
  timeoutMs = 25000,
  log = () => {},
} = {}) {
  const html = await getInitialStatePage(SCHEDULE_URL, { timeoutMs, log });
  const state = parseState(html);
  if (!state) return { items: [], note: "未找到内嵌数据" };
  const list = findArray(state, "datas") || [];
  return {
    items: list.map(normalizeScheduleItem).filter(Boolean),
    raw: list.length,
  };
}

/**
 * 采集入口：返回岗位 + 校招日程线索
 * @param {{targetYear?:string, includeSchedule?:boolean, maxSchedule?:number}} opts
 */
export async function collect({
  targetYear = "",
  includeSchedule = true,
  maxSchedule = 6,
  log = () => {},
} = {}) {
  const errors = [];
  const jobs = [];
  let rawJobs = 0;

  try {
    const r = await fetchCampusJobs({ log });
    rawJobs = r.raw || 0;
    jobs.push(...r.jobs);
    log(`牛客校招：${r.jobs.length} 个岗位${r.note ? `（${r.note}）` : ""}`);
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
            return new RegExp(`${y}|${short}届`).test(
              `${it.extra.batch} ${it.title}`,
            );
          })
        : s.items;
      const picked = matched.slice(0, maxSchedule);
      jobs.push(...picked);
      log(
        `牛客校招日程：${s.items.length} 家公司，匹配目标届别 ${matched.length} 家，取 ${picked.length} 家`,
      );
    } catch (e) {
      errors.push(`牛客校招日程抓取失败：${e.message}`);
    }
  }

  return {
    jobs,
    errors,
    stats: { nowcoder: jobs.length, nowcoderRaw: rawJobs },
  };
}
