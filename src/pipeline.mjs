// 主流程编排：简历 → 画像 → 检索词 → 岗位采集 → 预筛 → JD 补全 → LLM 精排 → 结果
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './config.mjs';
import { analyzeResume, buildTitleKeywords, buildWebQueries, buildWechatQueries, normalizeProfile, rolesForMajor } from './resume/profile.mjs';
import { destinationQueries } from './match/destinations.mjs';
import { analyzeResumeOffline } from './resume/offline.mjs';
import { collectJobs } from './sources/index.mjs';
import * as shixiseng from './sources/shixiseng.mjs';
import { preScoreAll, scoreWithLlm, verdictOf } from './match/score.mjs';
import { enrichJobs } from './match/enrich.mjs';
import { expandArticles, triageArticle } from './match/article.mjs';
import { filterByTargetYear, yearQueryVariants } from './match/campus.mjs';
import { filterByDegree } from './match/score.mjs';
import { upsert, annotate } from './store.mjs';
import { cityMatches, dedupeJobs, truncate } from './util/text.mjs';

export const RUNS_DIR = path.join(DATA_ROOT, 'runs');

function makeRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 执行一次完整检索
 * @param {object} p
 * @param {string} p.resumeText
 * @param {import('./llm/deepseek.mjs').DeepSeek} p.llm
 * @param {object} p.cfg
 * @param {(ev:object)=>void} p.onEvent 进度事件回调
 */
export async function runPipeline({
  resumeText,
  llm,
  cfg,
  options = {},
  onEvent = () => {},
  signal,
  runId = makeRunId(),
} = {}) {
  const started = Date.now();
  const log = (message, extra = {}) => onEvent({ type: 'log', message, ...extra });
  const stage = (id, label, extra = {}) => onEvent({ type: 'stage', stage: id, label, ...extra });

  const useLlm = options.useLlm !== false && llm?.available;
  const errors = [];
  // 结果漏斗：每一级筛选掉多少，全程记录下来并输出。
  // 起因：用户看到「去重后 320 条」却只有 17 条结果，而日志中间是断的 ——
  // shortlistSize 和 minScore 这两级硬截断此前完全不可见。
  const funnel = { raw: 0, deduped: 0, afterYear: 0, degreeCut: 0, prescored: 0, shortlisted: 0, scored: 0, returned: 0 };

  /* ---------- 1. 简历画像 ---------- */
  stage('analyze', '解析简历并提取求职画像');
  let profile;
  if (useLlm) {
    try {
      profile = await analyzeResume(llm, resumeText, { log });
    } catch (e) {
      errors.push(`LLM 画像提取失败：${e.message}`);
      log(`LLM 画像提取失败，降级为离线规则提取：${e.message}`);
      profile = normalizeProfile(analyzeResumeOffline(resumeText));
    }
  } else {
    log(useLlm ? '已按设置跳过 LLM' : '未配置 DeepSeek Key，使用离线规则提取画像');
    profile = normalizeProfile(analyzeResumeOffline(resumeText));
  }

  // 用户手动覆盖
  // 注意：这里要区分「没传」和「传了空数组」——空数组表示不限城市，
  // 是对简历推断结果的显式否定，不能当成「没提供」而跳过。
  if (Array.isArray(options.cities)) {
    profile.preferredCities = options.cities.filter(Boolean);
    log(
      profile.preferredCities.length
        ? `检索城市：${profile.preferredCities.join('、')}`
        : '检索城市：不限（全国范围）',
    );
  } else if (Array.isArray(cfg.filters?.cities)) {
    profile.preferredCities = cfg.filters.cities.filter(Boolean);
    log(
      profile.preferredCities.length
        ? `检索城市（来自配置）：${profile.preferredCities.join('、')}`
        : '检索城市：不限（全国范围，来自配置）',
    );
  }
  if (Array.isArray(options.titleKeywords) && options.titleKeywords.length) profile.titleKeywords = options.titleKeywords;

  // 配置里的画像「钉死」覆盖：把工具固定服务于某个特定目标（某校某专业），
  // 不让 LLM 每次抽取的波动影响选校、检索词与打分。
  const pin = cfg.profile || {};
  const pinned = [];
  for (const [field, val] of Object.entries(pin)) {
    if (field.startsWith('_')) continue; // _说明 之类的注释键，不是真正的画像字段
    if (val == null || val === '' || (Array.isArray(val) && !val.length)) continue;
    const before = JSON.stringify(profile[field]);
    const after = JSON.stringify(val);
    if (before === after) continue;
    profile[field] = val;
    pinned.push(`${field}: ${before ?? '(空)'} → ${after}`);
  }
  if (pinned.length) {
    // 专业被钉死、但没钉死目标岗位时，简历里那份「目标岗位」大概率属于另一个方向。
    // 必须清掉 —— 它在岗位族推导里权重是 100，会直接压过按专业推导出来的岗位族(40)，
    // 造成「专业钉死成消防工程，检索词却还是 Java后端」这种自相矛盾的结果。
    if (pin.major && !pin.targetRoles) {
      const derived = rolesForMajor(profile.major);
      if (derived.length) {
        pinned.push(`targetRoles: ${JSON.stringify(profile.targetRoles)} → ${JSON.stringify(derived)}（按钉死专业推导）`);
        profile.targetRoles = derived;
        profile.titleKeywords = [];
      }
    }
    // 重新归一化：钉死 major / targetRoles 之后，关键词与岗位词兜底要按新值重算一遍，
    // 否则会出现「专业钉死了，但检索词还是按旧专业生成的」。
    profile = normalizeProfile(profile);
    log(`画像已按配置钉死：${pinned.join('；')}`);
  }
  onEvent({ type: 'profile', profile });

  /* ---------- 2. 检索词 ---------- */
  stage('plan', '生成检索词');
  // 目标届别要在这里先算出来：检索词、公众号查询、以及后面的过滤都要用
  const targetYear = String(options.graduationYear ?? cfg.filters?.graduationYear ?? '').trim();
  const includeInternship = options.includeInternship ?? cfg.filters?.includeInternship ?? true;

  // 画像里的毕业年份要跟筛选口径一致：否则会出现「按 2027 届筛岗位、
  // 却拿 2026 届的画像去精排」的矛盾，LLM 会把对口岗位判成届别不符。
  if (targetYear && profile.graduationYear !== targetYear) {
    log(`画像毕业年份 ${profile.graduationYear || '(未识别)'} → 按目标届别校正为 ${targetYear}`);
    profile.graduationYear = targetYear;
    onEvent({ type: 'profile', profile });
  }

  const baseKeywords = buildTitleKeywords(profile, { max: options.maxTitleKeywords || 8 });
  // 毕业生去向补充词：官方就业报告里点名的岗位叫法与单位，
  // 标题里往往不含专业名（如「危险品培训专员」「应急救援」），不补就会整片漏掉
  const dest = destinationQueries(profile, { max: 8 });
  if (dest.queries.length) {
    log(`毕业生去向补充检索词（来源：学校官方专业简介）：${dest.queries.join('、')}`);
    if (dest.note) log(`  官方去向摘要：${dest.note}`);
  }
  // 招聘站上「2027届」「27届校招」这类词能直接命中校招岗，值得单独搜一轮
  const titleKeywords = targetYear
    ? [...baseKeywords, ...dest.queries, ...yearQueryVariants(targetYear).slice(0, cfg.filters?.yearQueryCount ?? 3)]
    : [...baseKeywords, ...dest.queries];
  const webQueries = buildWebQueries(profile, { cities: profile.preferredCities, max: cfg.sources.searchApi.maxQueries });
  const wechatQueries =
    cfg.sources.wechat?.enabled === false
      ? []
      : buildWechatQueries(profile, {
          cities: profile.preferredCities,
          max: cfg.sources.wechat?.maxQueries ?? 4,
          targetYear,
        });
  log(`站点检索词：${titleKeywords.join('、')}`);
  log(`全网查询：${webQueries.length} 条${wechatQueries.length ? `｜公众号查询：${wechatQueries.length} 条` : ''}`);
  if (targetYear) log(`目标届别：${targetYear} 届${includeInternship ? '（含实习）' : '（不含实习）'}`);
  onEvent({ type: 'queries', titleKeywords, webQueries, wechatQueries, targetYear });

  /* ---------- 3. 岗位采集 ---------- */
  stage('collect', '检索岗位（智联 / 实习僧 / 公众号 / 全网搜索）');
  let collected = { jobs: [], articles: [], errors: [], stats: {}, rawCount: 0 };
  try {
    collected = await collectJobs({
      titleKeywords,
      webQueries,
      wechatQueries,
      roleKeywords: [...(profile.titleKeywords || []), ...(profile.targetRoles || [])],
      profileKeywords: profile.keywords,
      profile,
      cities: profile.preferredCities,
      cfg,
      log,
      signal,
      onJobs: (jobs) => onEvent({ type: 'jobsFound', count: jobs.length }),
    });
    errors.push(...collected.errors);
    funnel.raw = collected.rawCount || 0;
    funnel.deduped = collected.jobs.length;
  } catch (e) {
    errors.push(`岗位采集失败：${e.message}`);
    log(`岗位采集失败：${e.message}`);
  }

  /* ---------- 3.2 公众号公告 → 结构化岗位 ---------- */
  // 公众号文章是散文体，一篇可能是单公司公告，也可能是多公司「信息汇编」，
  // 所以先用规则分排序挑出值得解析的篇目，再交给 LLM 逐篇抽取岗位。
  const articles = collected.articles || [];
  const expandedJobs = [];
  if (articles.length) {
    if (!useLlm) {
      log(`发现 ${articles.length} 篇公众号公告，但未启用 LLM，跳过岗位抽取`);
    } else {
      stage('expand', `从 ${articles.length} 篇公众号公告中抽取岗位`);
      try {
        const rankedArticles = preScoreAll(articles, profile);
        const expandable = rankedArticles.filter((a) => triageArticle(a).expandable);
        const skipped = rankedArticles.filter((a) => !triageArticle(a).expandable);
        for (const a of skipped.slice(0, 3)) {
          log(`  跳过「${truncate(a.title, 26)}」：${triageArticle(a).reason}`);
        }

        const maxExpand = cfg.sources.wechat?.maxExpand ?? 5;
        const picked = expandable.slice(0, maxExpand);
        if (picked.length === 0) {
          log('没有可解析的公众号公告正文（其余可能为图片海报）');
        } else {
          const r = await expandArticles(llm, profile, picked, {
            maxExpand,
            concurrency: 3,
            log,
          });
          expandedJobs.push(...r.jobs);
          log(`公众号抽取完成：${r.expanded} 篇命中招聘信息，共得到 ${r.jobs.length} 个岗位${r.noJob ? `，${r.noJob} 篇判定为非招聘内容` : ''}`);
        }

        // 正文解析不到具体岗位但相关性高的公告，保留为「公告线索」，
        // 让用户至少知道「XX集团2026秋招已启动」
        const leads = rankedArticles
          .filter((a) => !triageArticle(a).expandable && a.url && (a.extra?.relevance || 0) >= 8)
          .slice(0, 4)
          .map((a) => ({
            ...a,
            isArticleLead: true,
            summary: a.summary || `公众号「${a.extra?.account || '未知'}」发布的招聘公告`,
          }));
        if (leads.length) {
          expandedJobs.push(...leads);
          log(`另保留 ${leads.length} 篇公告线索（未解析到具体岗位，但标题相关）`);
        }
      } catch (e) {
        errors.push(`公众号岗位抽取失败：${e.message}`);
        log(`公众号岗位抽取失败：${e.message}`);
      }
    }
  }

  // 把抽取出的公众号岗位并入岗位池；此时它们才有城市字段，可做城市过滤
  if (expandedJobs.length) {
    const before = expandedJobs.length;
    const kept = profile.preferredCities.length
      ? expandedJobs.filter((j) => !j.city || cityMatches(j.city, profile.preferredCities))
      : expandedJobs;
    if (kept.length !== before) log(`公众号岗位城市过滤：${before} → ${kept.length} 条`);
    collected.jobs = dedupeJobs([...collected.jobs, ...kept]);
    collected.stats.wechatJobs = kept.length;
    log(`并入公众号岗位后岗位池：${collected.jobs.length} 条`);
  }

  // Save every collected fact before ranking or eligibility filters.
  await upsert([...collected.jobs, ...expandedJobs, ...articles.map(a=>({...a,kind:'recruitment_notice'}))], {runId,at:new Date().toISOString()});
  /* ---------- 3.6 届别过滤：只保留目标届别的校招岗位 ---------- */
  // 放在公众号岗位并入之后，保证新抽出来的岗位同样受约束。
  const strictYear = cfg.filters?.strict !== false;
  const keepConvertibleInternship = cfg.filters?.keepConvertibleInternship !== false;
  if (targetYear) {
    stage('year-filter', `按届别过滤：只保留 ${targetYear} 届校招`);
    const before = collected.jobs.length;
    const f = filterByTargetYear(collected.jobs, targetYear, {
      includeInternship,
      strict: strictYear,
      keepConvertibleInternship,
    });
    collected.jobs = f.jobs;
    collected.stats.yearFilter = { targetYear: String(targetYear), before, kept: f.stats.kept, dropped: f.stats.dropped, reasons: f.stats.reasons };
    log(`届别过滤：${before} → ${f.stats.kept} 条`);
    funnel.afterYear = f.stats.kept;
    if (f.stats.dropped) {
      log(`  剔除原因：${Object.entries(f.stats.reasons).map(([k, v]) => `${k} ${v} 条`).join('，')}`);
    }
    if (includeInternship === false) {
      log(
        keepConvertibleInternship
          ? '  实习岗位已排除（但明确写了「可转正/留用」的保留）'
          : '  实习岗位已按设置全部排除',
      );
    }
  } else {
    log('未设置目标届别（filters.graduationYear），跳过届别过滤');
  }

  // 学历下限：本科求职者不需要看「大专及以上」的岗位
  if (cfg.filters?.excludeBelowDegree !== false) {
    const d = filterByDegree(collected.jobs, profile, { minDegree: cfg.filters?.minDegree || '' });
    if (d.floor !== null && d.dropped.length) {
      collected.jobs = d.jobs;
      log(`学历下限过滤（不低于「${cfg.filters?.minDegree || profile.degree}」）：剔除 ${d.dropped.length} 条`);
      for (const x of d.dropped.slice(0, 3)) log(`    · ${x.job.title} — ${x.reason}`);
      collected.stats.degreeFilter = { floor: d.floor, dropped: d.dropped.length };
      funnel.degreeCut = d.dropped.length;
    }
  }

  if (collected.jobs.length === 0) {
    const result = finalize({ runId, started, profile, titleKeywords, webQueries, jobs: [], collected, errors, llm, cfg, funnel });
    onEvent({ type: 'result', result });
    return result;
  }

  /* ---------- 3.5 还原被字体混淆的标题 ---------- */
  const obfuscated = collected.jobs.filter((j) => j.titleObfuscated && !j.titleRepaired);
  if (obfuscated.length) {
    stage('repair', `还原混淆岗位标题（${obfuscated.length} 条待解码）`);
    try {
      const r = await shixiseng.repairTitles(collected.jobs, {
        maxSamples: cfg.sources.shixiseng.titleRepairSamples ?? 6,
        concurrency: 3,
        log,
        signal,
      });
      if (r.samples === 0) {
        log('未能取得明文样本，混淆标题将用检索关键词兜底');
      } else {
        log(`标题解码完成：完整还原 ${r.repaired}/${r.total} 条（映射表 ${r.mapSize} 字符）`);
      }
    } catch (e) {
      errors.push(`标题解码失败：${e.message}`);
      log(`标题解码失败：${e.message}`);
    }
  }

  /* ---------- 4. 规则预筛 ---------- */
  stage('prescore', '按画像做规则预筛');
  let scored = preScoreAll(collected.jobs, profile);
  const shortlist = scored.slice(0, cfg.match.shortlistSize);
  // 漏斗要显式记录下来：用户看到「去重后 320 条」却只出 17 条结果时，
  // 中间那两级**硬截断**（shortlistSize 和 minScore）此前完全没有输出，
  // 从日志上根本看不出东西是在哪一步没的。
  funnel.prescored = scored.length;
  funnel.shortlisted = shortlist.length;
  funnel.shortlistCut = Math.max(0, scored.length - shortlist.length);
  log(`预筛完成：${scored.length} 条岗位 → 入围 ${shortlist.length} 条`);
  if (funnel.shortlistCut > 0) {
    log(
      `  入围上限 shortlistSize=${cfg.match.shortlistSize} 截掉了 ${funnel.shortlistCut} 条` +
        `（规则分不够高，没送进 LLM 精排）`,
    );
  }

  /* ---------- 5. JD 补全 ---------- */
  if (cfg.match.enrichTopN > 0) {
    stage('enrich', '补全岗位详情（JD 正文）');
    try {
      const r = await enrichJobs(shortlist, {
        topN: cfg.match.enrichTopN,
        concurrency: 3,
        log,
        signal,
      });
      log(`JD 补全完成：成功 ${r.enriched}/${r.attempted}`);
    } catch (e) {
      errors.push(`JD 补全失败：${e.message}`);
    }
  }

  /* ---------- 6. LLM 精排 ---------- */
  if (useLlm && shortlist.length) {
    stage('score', `DeepSeek 精排 ${shortlist.length} 个岗位`);
    try {
      await scoreWithLlm(llm, profile, shortlist, {
        batchSize: cfg.match.scoreBatchSize,
        log,
      });
    } catch (e) {
      errors.push(`LLM 精排失败：${e.message}`);
      log(`LLM 精排失败：${e.message}`);
    }
  } else if (!useLlm) {
    log('未启用 LLM 精排，结果基于规则评分');
  }

  /* ---------- 7. 汇总 ---------- */
  stage('finalize', '汇总结果');
  let finalJobs = shortlist
    .map((j) => ({ ...j, verdict: verdictOf(j) }))
    .filter((j) => (j.score ?? 0) >= cfg.match.minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.preScore ?? 0) - (a.preScore ?? 0));

  // 第二级硬截断：LLM 打分低于 minScore 的被丢弃
  funnel.scored = shortlist.length;
  funnel.returned = finalJobs.length;
  funnel.minScoreCut = shortlist.length - finalJobs.length;
  if (funnel.minScoreCut > 0) {
    log(`  评分下限 minScore=${cfg.match.minScore} 又筛掉 ${funnel.minScoreCut} 条（${shortlist.length} 条送评 → 留 ${finalJobs.length} 条）`);
  }
  log(
    `结果漏斗：采集 ${funnel.raw} → 去重 ${funnel.deduped} → 届别过滤 ${funnel.afterYear}` +
      `${funnel.degreeCut ? ` → 学历下限 -${funnel.degreeCut}` : ''}` +
      ` → 规则预筛 ${funnel.prescored} → 入围 ${funnel.shortlisted} → 评分达标 ${funnel.returned}`,
  );

  const result = finalize({ runId, started, profile, titleKeywords, webQueries, jobs: finalJobs, collected, errors, llm, cfg, funnel });

  // 并入跨检索索引，算出「新增 / 仍在 / 消失」。
  // 放在 finalize 之后，且整体 try 包住：索引只是增强功能，失败不该影响检索结果本身。
  try {
    const diff = await upsert(result.jobs, { runId, at: result.createdAt });
    const annotated = await annotate(result.jobs, diff);
    result.jobs = annotated.jobs;
    result.tracking = {
      added: diff.stats.added,
      ongoing: diff.stats.ongoing,
      disappeared: diff.stats.disappeared,
      totalIndexed: diff.stats.total,
      newIds: diff.added,
      disappearedIds: annotated.disappearedIds,
    };
    if (diff.stats.added) log(`本次新增 ${diff.stats.added} 个岗位（索引里共 ${diff.stats.total} 个）`);
    if (diff.stats.disappeared) log(`有 ${diff.stats.disappeared} 个岗位已下架 / 不再出现`);
    if (diff.stats.pruned) log(`索引清理了 ${diff.stats.pruned} 条过期记录`);
  } catch (e) {
    errors.push(`岗位索引更新失败：${e.message}`);
    log(`岗位索引更新失败：${e.message}`);
    throw e;
  }

  onEvent({ type: 'result', result });
  return result;
}

function finalize({ runId, started, profile, titleKeywords, webQueries, jobs, collected, errors, llm, cfg, funnel }) {
  const result = {
    runId,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    resumeProfile: profile,
    queries: { titleKeywords, webQueries },
    // 结果漏斗：每一级筛掉了多少。用户问「320 条为什么只出 17 条」时，
    // 这个字段就是答案，不需要再去翻日志。
    funnel: funnel || null,
    stats: {
      ...collected.stats,
      rawCount: collected.rawCount,
      // 【注意】不能再写成 collected.jobs.length ——
      // 到这个函数被调用时，collected.jobs 已经被「届别过滤 + 学历下限」就地改写过了，
      // 于是「去重后」这个字段实际显示的是「过滤后剩多少」，数字对不上、也没法和采集量对照。
      // 真实的去重后数量由 funnel.deduped 记录。
      afterDedupe: funnel?.deduped ?? collected.jobs.length,
      afterFilter: collected.jobs.length,
      returned: jobs.length,
      bySource: countBySource(jobs),
      byVerdict: countByVerdict(jobs),
    },
    config: {
      searchProvider: cfg.__activeSearchProvider || 'none',
      deepseekKeySource: cfg.__deepseekKeySource,
    },
    errors: errors.slice(0, 50),
    llmUsage: llm?.usage || null,
    jobs,
  };
  return result;
}

function countBySource(jobs) {
  const out = {};
  for (const j of jobs) out[j.sourceName || j.source] = (out[j.sourceName || j.source] || 0) + 1;
  return out;
}

function countByVerdict(jobs) {
  const out = {};
  for (const j of jobs) out[j.verdict || '未评级'] = (out[j.verdict || '未评级'] || 0) + 1;
  return out;
}

/** 持久化一次运行结果 */
export async function saveRun(result) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${result.runId}.json`);
  const slim = {
    ...result,
    jobs: result.jobs.map((j) => ({ ...j, description: j.description ? j.description.slice(0, 4000) : '' })),
  };
  fs.writeFileSync(file, JSON.stringify(slim, null, 2), 'utf8');
  return file;
}

export function listRuns(limit = 50) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = path.join(RUNS_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
          runId: data.runId,
          createdAt: data.createdAt,
          returned: data.stats?.returned ?? data.jobs?.length ?? 0,
          targetRoles: data.resumeProfile?.targetRoles || [],
          cities: data.resumeProfile?.preferredCities || [],
          size: fs.statSync(file).size,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

export function loadRun(runId) {
  const safe = String(runId).replace(/[^a-zA-Z0-9\-]/g, '');
  const file = path.join(RUNS_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
