// 岗位源统一调度：并行拉取 → 归一化 → 去重合并
import * as zhaopin from './zhaopin.mjs';
import * as shixiseng from './shixiseng.mjs';
import * as searchapi from './searchapi.mjs';
import * as wechat from './wechat.mjs';
import * as nowcoder from './nowcoder.mjs';
import * as university from './university.mjs';
import * as chenyun from './chenyun.mjs';
import * as jiuyeqiao from './jiuyeqiao.mjs';
import { dedupeJobs, pool, cityMatches } from '../util/text.mjs';

export const SOURCES = { zhaopin, shixiseng, searchapi, wechat, nowcoder, university, chenyun, jiuyeqiao };

/**
 * 构造「城市 × 关键词」检索计划。
 * 首选城市覆盖全部关键词；其余城市只取前几个关键词，避免请求量随城市数线性膨胀。
 */
export function buildSearchPlan(titleKeywords, cities, { maxCities = 2, secondaryCityKeywords = 2 } = {}) {
  if (!cities || cities.length === 0) {
    return titleKeywords.map((keyword) => ({ city: '全国', keyword, primary: true }));
  }
  const plan = [];
  cities.slice(0, Math.max(1, maxCities)).forEach((city, ci) => {
    const kws = ci === 0 ? titleKeywords : titleKeywords.slice(0, Math.max(1, secondaryCityKeywords));
    for (const keyword of kws) plan.push({ city, keyword, primary: ci === 0 });
  });
  return plan;
}

/**
 * 采集岗位
 * @param {object} p
 * @param {string[]} p.titleKeywords 站点直连用的短岗位关键词
 * @param {string[]} p.webQueries    搜索 API 用的长查询
 * @param {string[]} p.cities        目标城市（第一个为主要城市）
 * @param {object}   p.profile       简历画像（高校就业网用它挑本校 + 按专业选院校）
 */
export async function collectJobs({
  titleKeywords = [],
  webQueries = [],
  wechatQueries = [],
  roleKeywords = [],
  profileKeywords = [],
  profile = null,
  cities = [],
  cfg,
  log = () => {},
  signal,
  onJobs = () => {},
} = {}) {
  const jobs = [];
  const errors = [];
  const stats = { zhaopin: 0, shixiseng: 0, web: 0, wechat: 0, nowcoder: 0, university: 0, chenyun: 0, jiuyeqiao: 0 };
  // 公众号文章是散文体，不能直接当岗位用，要单独交给 LLM 抽取
  let articles = [];

  const plan = buildSearchPlan(titleKeywords, cities, {
    maxCities: cfg.sources.maxCities ?? 2,
    secondaryCityKeywords: cfg.sources.secondaryCityKeywords ?? 2,
  });

  if (plan.length) {
    const byCity = new Map();
    for (const p of plan) byCity.set(p.city, (byCity.get(p.city) || 0) + 1);
    log(`检索计划：${[...byCity.entries()].map(([c, n]) => `${c}×${n}词`).join(' + ')}`);
  }

  const tasks = [];

  if (cfg.sources.zhaopin.enabled) {
    for (const { city, keyword } of plan) {
      tasks.push({
        label: `智联「${keyword}@${city}」`,
        run: async () => {
          const r = await zhaopin.search({
            keyword,
            city,
            maxPages: cfg.sources.zhaopin.maxPages,
            delayMs: cfg.sources.zhaopin.delayMs,
            log,
            signal,
          });
          if (r.jobs.length) {
            stats.zhaopin += r.jobs.length;
            jobs.push(...r.jobs);
            onJobs(r.jobs);
          }
          errors.push(...r.errors.map((e) => `智联/${keyword}@${city} ${e}`));
        },
      });
    }
  }

  if (cfg.sources.shixiseng.enabled) {
    for (const { city, keyword } of plan) {
      tasks.push({
        label: `实习僧「${keyword}@${city}」`,
        run: async () => {
          const r = await shixiseng.search({
            keyword,
            city,
            maxPages: cfg.sources.shixiseng.maxPages,
            delayMs: cfg.sources.shixiseng.delayMs,
            log,
            signal,
          });
          if (r.jobs.length) {
            stats.shixiseng += r.jobs.length;
            jobs.push(...r.jobs);
            onJobs(r.jobs);
          }
          errors.push(...r.errors.map((e) => `实习僧/${keyword}@${city} ${e}`));
        },
      });
    }
  }

  // 站点直连彼此独立，限制并发避免触发风控
  await pool(tasks, 3, async (t) => {
    try {
      await t.run();
    } catch (e) {
      errors.push(`${t.label} ${e.message}`);
      log(`${t.label} 失败：${e.message}`);
    }
  });

  // 全网搜索通道
  if (cfg.sources.searchApi.enabled && cfg.__activeSearchProvider) {
    const provider = cfg.__activeSearchProvider;
    const apiKey = cfg.__searchKeys[provider];
    const queries = webQueries.slice(0, cfg.sources.searchApi.maxQueries);
    try {
      const r = await searchapi.searchAll(queries, {
        provider,
        apiKey,
        maxResults: cfg.sources.searchApi.resultsPerQuery,
        log,
        signal,
      });
      stats.web += r.jobs.length;
      jobs.push(...r.jobs);
      onJobs(r.jobs);
      errors.push(...r.errors.map((e) => `搜索/${e}`));
    } catch (e) {
      errors.push(`搜索通道 ${e.message}`);
      log(`搜索通道失败：${e.message}`);
    }
  } else if (cfg.sources.searchApi.enabled) {
    log('未配置搜索 API Key，跳过全网搜索通道（仅使用智联/实习僧直连数据）');
  }

  // 微信公众号校招公告：产出的是「文章线索」，后续由 LLM 抽取具体岗位
  if (cfg.sources.wechat?.enabled && wechatQueries.length) {
    try {
      log(`微信公众号检索词：${wechatQueries.join('｜')}`);
      const r = await wechat.collectWechat({
        keywords: wechatQueries,
        roleKeywords,
        profileKeywords,
        cities,
        maxPages: cfg.sources.wechat.maxPages,
        maxFetch: cfg.sources.wechat.maxFetch,
        delayMs: cfg.sources.wechat.delayMs,
        cfg,
        log,
        signal,
      });
      articles = r.jobs || [];
      stats.wechat = articles.length;
      stats.wechatFetched = r.stats?.fetched || 0;
      errors.push(...r.errors.map((e) => `微信/${e}`));
    } catch (e) {
      errors.push(`微信公众号通道 ${e.message}`);
      log(`微信公众号通道失败：${e.message}`);
    }
  }

  // 牛客校招：岗位自带 graduationYear 字段，是届别筛选最可靠的来源
  if (cfg.sources.nowcoder?.enabled) {
    try {
      const r = await nowcoder.collect({
        targetYear: cfg.filters?.graduationYear || '',
        includeSchedule: cfg.sources.nowcoder.includeSchedule !== false,
        maxSchedule: cfg.sources.nowcoder.maxSchedule ?? 6,
        log,
      });
      if (r.jobs.length) {
        stats.nowcoder += r.jobs.length;
        jobs.push(...r.jobs);
        onJobs(r.jobs);
      }
      errors.push(...r.errors.map((e) => `牛客/${e}`));
    } catch (e) {
      errors.push(`牛客通道 ${e.message}`);
      log(`牛客通道失败：${e.message}`);
    }
  }

  // 高校就业网：企业发布的官方校招信息，页面可解析
  if (cfg.sources.university?.enabled) {
    try {
      // hosts 不显式传入 → 由 resolveHosts 按「本校 → 专业相关院校 → 其余」自动解析；
      // 配置里写的 hosts 作为手动补充
      const r = await university.collect({
        keywords: titleKeywords,
        profile,
        maxHosts: cfg.sources.university.maxHosts ?? 4,
        maxPerKeyword: cfg.sources.university.maxPerKeyword ?? 12,
        maxDetail: cfg.sources.university.maxDetail ?? 12,
        delayMs: cfg.sources.university.delayMs ?? 900,
        log,
        signal,
      });
      // 手动配置的额外高校（自动解析之外的）
      const extra = cfg.sources.university.hosts || [];
      if (extra.length) {
        const r2 = await university.collect({
          keywords: titleKeywords,
          hosts: extra,
          maxHosts: extra.length,
          maxPerKeyword: cfg.sources.university.maxPerKeyword ?? 12,
          maxDetail: cfg.sources.university.maxDetail ?? 12,
          delayMs: cfg.sources.university.delayMs ?? 900,
          log,
          signal,
        });
        r.jobs.push(...r2.jobs);
        r.errors.push(...r2.errors);
      }
      if (r.jobs.length) {
        stats.university += r.jobs.length;
        jobs.push(...r.jobs);
        onJobs(r.jobs);
      }
      errors.push(...r.errors.map((e) => `高校就业网/${e}`));
    } catch (e) {
      errors.push(`高校就业网通道 ${e.message}`);
      log(`高校就业网通道失败：${e.message}`);
    }
  }

  // 晨云智慧就业系统的高校就业网（中飞院等，与才立方是两套不同系统）
  if (cfg.sources.chenyun?.enabled) {
    try {
      const r = await chenyun.collect({
        keywords: titleKeywords,
        // 不显式给 hosts 时，优先选与简历学校同名的晨云站点
        profile,
        hosts: cfg.sources.chenyun.hosts?.length ? cfg.sources.chenyun.hosts : null,
        maxHosts: cfg.sources.chenyun.maxHosts ?? 2,
        maxPages: cfg.sources.chenyun.maxPages ?? 6,
        maxDetail: cfg.sources.chenyun.maxDetail ?? 12,
        delayMs: cfg.sources.chenyun.delayMs ?? 800,
        log,
        signal,
      });
      if (r.jobs.length) {
        stats.chenyun += r.jobs.length;
        jobs.push(...r.jobs);
        onJobs(r.jobs);
      }
      errors.push(...r.errors.map((e) => `晨云就业网/${e}`));
    } catch (e) {
      errors.push(`晨云就业网通道 ${e.message}`);
      log(`晨云就业网通道失败：${e.message}`);
    }
  }

  // 就业桥：一套按学校开子域的商用平台，覆盖大量自建就业网抓不到的院校
  if (cfg.sources.jiuyeqiao?.enabled) {
    try {
      const r = await jiuyeqiao.collect({
        keywords: titleKeywords,
        maxPerKeyword: cfg.sources.jiuyeqiao.maxPerKeyword ?? 10,
        maxPages: cfg.sources.jiuyeqiao.maxPages ?? 1,
        maxDetail: cfg.sources.jiuyeqiao.maxDetail ?? 8,
        delayMs: cfg.sources.jiuyeqiao.delayMs ?? 700,
        log,
        signal,
      });
      if (r.jobs.length) {
        stats.jiuyeqiao += r.jobs.length;
        jobs.push(...r.jobs);
        onJobs(r.jobs);
      }
      errors.push(...r.errors.map((e) => `就业桥/${e}`));
    } catch (e) {
      errors.push(`就业桥通道 ${e.message}`);
      log(`就业桥通道失败：${e.message}`);
    }
  }

  // 城市兜底过滤（防止站点忽略城市参数）
  // 文章线索暂不按城市过滤：公告标题常常不带城市，过滤会误杀，等 LLM 抽取后再过滤
  let filtered = jobs;
  if (cities.length) {
    filtered = jobs.filter((j) => !j.city || cityMatches(j.city, cities));
    if (filtered.length !== jobs.length) {
      log(`城市过滤：剔除 ${jobs.length - filtered.length} 条非目标城市岗位`);
    }
  }

  const deduped = dedupeJobs(filtered);
  log(`采集完成：原始 ${jobs.length} 条 → 城市过滤后 ${filtered.length} 条 → 去重后 ${deduped.length} 条`);
  if (articles.length) log(`公众号公告 ${articles.length} 篇待抽取岗位`);
  return { jobs: deduped, articles, errors, stats, rawCount: jobs.length };
}
