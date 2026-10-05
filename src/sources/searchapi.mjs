import { sourceFetch as fetch } from "./request-context.mjs";
// 全网搜索 API 适配器：Tavily / Bocha(博查) / Serper
// 用于补齐站点直连之外的全网岗位线索（招聘页、校招公告、职位聚合页）
import { truncate } from "../util/text.mjs";
import { normalizeDate } from "../util/html.mjs";

export const meta = { id: "web", name: "全网搜索", homepage: "" };

const PROVIDERS = {
  tavily: {
    label: "Tavily",
    async search(query, { apiKey, maxResults, timeoutMs }) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok)
        throw new Error(
          `Tavily HTTP ${res.status}: ${truncate(await res.text().catch(() => ""), 200)}`,
        );
      const data = await res.json();
      return (data.results || []).map((r) => ({
        title: r.title || "",
        url: r.url || "",
        snippet: r.content || "",
        score: typeof r.score === "number" ? r.score : null,
        date: r.published_date || "",
      }));
    },
  },
  bocha: {
    label: "博查",
    async search(query, { apiKey, maxResults, timeoutMs }) {
      const res = await fetch("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          freshness: "noLimit",
          summary: true,
          count: maxResults,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok)
        throw new Error(
          `博查 HTTP ${res.status}: ${truncate(await res.text().catch(() => ""), 200)}`,
        );
      const data = await res.json();
      if (data.code && data.code !== 200)
        throw new Error(`博查返回 code=${data.code}: ${data.msg || ""}`);
      const pages = data?.data?.webPages?.value || data?.data?.webPages || [];
      return (pages || []).map((r) => ({
        title: r.name || r.title || "",
        url: r.url || "",
        snippet: r.summary || r.snippet || "",
        score: null,
        date: r.datePublished || r.dateLastCrawled || "",
      }));
    },
  },
  serper: {
    label: "Serper",
    async search(query, { apiKey, maxResults, timeoutMs }) {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
        body: JSON.stringify({
          q: query,
          gl: "cn",
          hl: "zh-cn",
          num: Math.min(20, maxResults),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok)
        throw new Error(
          `Serper HTTP ${res.status}: ${truncate(await res.text().catch(() => ""), 200)}`,
        );
      const data = await res.json();
      return (data.organic || []).map((r) => ({
        title: r.title || "",
        url: r.link || "",
        snippet: r.snippet || "",
        score: null,
        date: r.date || "",
      }));
    },
  },
};

export function providerLabel(id) {
  return PROVIDERS[id]?.label || id;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const SITE_LABELS = {
  "zhipin.com": "BOSS直聘",
  "shixiseng.com": "实习僧",
  "nowcoder.com": "牛客网",
  "zhaopin.com": "智联招聘",
  "51job.com": "前程无忧",
  "liepin.com": "猎聘",
  "lagou.com": "拉勾",
  "yingjiesheng.com": "应届生求职网",
  "maimai.cn": "脉脉",
  "linkedin.com": "LinkedIn",
  "wondercv.com": "超级简历",
  "gamersky.com": "",
};

export function siteLabel(url) {
  const host = hostOf(url);
  for (const [k, v] of Object.entries(SITE_LABELS))
    if (host.endsWith(k)) return v || host;
  return host;
}

export function normalizeWebResult(r, provider) {
  if (!r?.url) return null;
  const title = String(r.title || "").trim();
  const snippet = String(r.snippet || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title && !snippet) return null;
  return {
    id: `web:${r.url}`,
    source: "web",
    sourceName: `${providerLabel(provider)}·${siteLabel(r.url) || "网页"}`,
    sources: ["web"],
    title: title || truncate(snippet, 60),
    company: "",
    city: "",
    district: "",
    salary: "",
    education: "",
    experience: "",
    jobType: "",
    skills: [],
    tags: [],
    publishTime: normalizeDate(r.date || ""),
    url: r.url,
    summary: truncate(snippet, 500),
    description: "",
    extra: { engine: provider, site: siteLabel(r.url), engineScore: r.score },
    isWebLead: true,
  };
}

export async function searchQuery(
  query,
  { provider, apiKey, maxResults = 10, timeoutMs = 30000 },
) {
  const impl = PROVIDERS[provider];
  if (!impl) throw new Error(`未知搜索通道：${provider}`);
  if (!apiKey) throw new Error(`搜索通道 ${provider} 缺少 API Key`);
  const raw = await impl.search(query, { apiKey, maxResults, timeoutMs });
  return raw.map((r) => normalizeWebResult(r, provider)).filter(Boolean);
}

export async function searchAll(
  queries,
  {
    provider,
    apiKey,
    maxResults = 10,
    timeoutMs = 30000,
    log = () => {},
    signal,
  } = {},
) {
  const jobs = [];
  const errors = [];
  for (const q of queries) {
    if (signal?.aborted) break;
    try {
      const results = await searchQuery(q, {
        provider,
        apiKey,
        maxResults,
        timeoutMs,
      });
      jobs.push(...results);
      log(
        `${providerLabel(provider)}「${truncate(q, 40)}」→ ${results.length} 条`,
      );
    } catch (e) {
      errors.push(`${truncate(q, 30)}: ${e.message}`);
      log(`${providerLabel(provider)}「${truncate(q, 40)}」失败：${e.message}`);
    }
  }
  return { jobs, errors };
}
