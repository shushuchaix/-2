// 届别识别与岗位分类
//
// 目标场景：只要「2027届校招」，把社招、往届、以及其他届别的岗位挡在外面。
import { isSoftRequirement } from './requirements.mjs';
//
// 难点在于各源的信号强弱差别很大：
//   · 牛客有显式字段 graduationYear（"2027届" / "毕业不限"）
//   · 智联有 workType === '校园' 官方校招标记
//   · 实习僧全是实习岗，本身没有届别
//   · 公众号要靠 LLM 抽出的 batch（"2027届秋季校园招聘"）
//   · 大量岗位完全没有届别信息，只能靠标题/描述里的线索推断
// 所以这里做的是「分层判定」：先看显式字段，再看文本线索，最后兜底。

const YEAR_MIN = 2020;
const YEAR_MAX = 2035;

/**
 * 从文本中提取毕业届别年份。
 * 只认「届 / 年毕业 / 应届 / 校园招聘」等上下文里的年份，
 * 避免把项目里的 2024 这种普通年份误判成届别。
 */
export function extractGraduationYears(text) {
  const s = String(text || '');
  if (!s) return [];
  const years = new Set();

  // 2027届 / 2027 届 / 2027届毕业生
  for (const m of s.matchAll(/20(\d{2})\s*届/g)) years.add(2000 + Number(m[1]));
  // 2027年毕业 / 2027 年应届
  for (const m of s.matchAll(/20(\d{2})\s*年?\s*(?:毕业|应届)/g)) years.add(2000 + Number(m[1]));
  // 2027校园招聘 / 2027 秋招 / 2027暑期实习
  for (const m of s.matchAll(/20(\d{2})\s*年?\s*(?:校园招聘|校招|秋招|春招|暑期实习)/g)) years.add(2000 + Number(m[1]));
  // 27届 / '27届 —— 前面不能紧跟数字，否则会把 2027届 里的 "27" 也算一遍（结果相同但来源混乱）
  for (const m of s.matchAll(/(?<![\d])(\d{2})\s*届/g)) {
    const y = 2000 + Number(m[1]);
    if (y >= YEAR_MIN && y <= YEAR_MAX) years.add(y);
  }

  return [...years].filter((y) => y >= YEAR_MIN && y <= YEAR_MAX).sort();
}

/** 解析经验年限要求：「3年以上」→3，「1-3年」→1，「经验不限」→0，未提及→null */
export function parseExperienceYears(text) {
  const s = String(text || '');
  if (!s) return null;
  if (/不限|无经验|应届|在校|无须/.test(s)) return 0;
  const m = s.match(/(\d+)\s*[-–~至]?\s*(\d+)?\s*年/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 判定一个岗位的属性。
 * @returns {{category:'campus'|'intern'|'social'|'unknown', years:number[], explicitYears:boolean,
 *            isIntern:boolean, expYears:number|null, signals:string[]}}
 */
export function classifyJob(job = {}) {
  const extra = job.extra || {};
  const signals = [];

  // --- 显式字段 ---
  const explicitYearRaw = String(extra.graduationYear || '');
  const workType = String(extra.workType || job.jobType || '');
  // 两档，强度不同：
  //   isZhaopinCampus —— 平台结构化字段（智联 workType="校园"），强信号
  //   sourceCampus     —— 来源自己声明的类型（高校就业网/就业桥把 jobType 设成「校招」），中信号
  // 中信号不能当强信号用：就业桥的岗位库里混着社招内容（它自己的页面标题就写着「社会人才招聘」），
  // 一律放行会把社招漏进来。它的作用只是**避免**后面「无校招迹象的全职 → 社招」这条兜底规则误伤。
  const isZhaopinCampus = /校园/.test(workType);
  const sourceCampus = /校招/.test(workType);
  if (isZhaopinCampus) signals.push('平台标记为校园招聘');

  // --- 文本线索 ---
  const hay = [
    job.title,
    job.jobType,
    job.experience,
    ...(job.tags || []),
    job.summary,
    String(job.description || '').slice(0, 1200),
    extra.batch,
    explicitYearRaw,
  ]
    .filter(Boolean)
    .join(' ');

  const years = new Set(extractGraduationYears(hay));
  // 牛客的 graduationYear 是结构化字段，优先级最高
  for (const y of extractGraduationYears(explicitYearRaw)) years.add(y);
  const explicitYears = years.size > 0;
  // 「毕业不限」表示任何届别都可投，对目标届别应当放行
  const yearAgnostic = /不限/.test(explicitYearRaw) || /届别不限|毕业不限/.test(hay);

  /**
   * 校招信号分强弱 —— 这是过滤准确率的关键。
   *
   * 早期只判断「有没有出现应届/毕业生」，结果把大量
   * 「java后端开发工程师（接受应届毕业生）」「【高薪兜底｜应届可冲】」
   * 这类**社招但接受应届**的岗位当成了校招放行。
   * 真正的校招项目会写明「校园招聘 / 校招 / 秋招 / 春招 / 管培生」，
   * 而「应届」单独出现往往只是社招在放宽门槛。
   */
  const strongCampus = /校园招聘|校招|秋招|春招|管培生|培训生|校园/.test(hay);
  const weakCampus = /应届|毕业生/.test(hay);

  const isIntern =
    /实习/.test(String(job.jobType || '')) || job.source === 'shixiseng' || /实习/.test(String(job.title || ''));
  // 实习能不能转正，是完全不同的两件事：
  //   「实习生（表现优秀可转正）」值得投；「只实习、不转正」对一个找 2027 届正式岗的人来说是白干。
  // 所以实习排除逻辑要按这个再分一层，而不是一刀切。
  //
  // 注意否定：`/转正/` 会命中「**不**转正」「**无**转正机会」，而那正是要排除的那类。
  // 所以先看有没有明确的否定措辞，再看肯定措辞。
  const internText = [job.title, job.jobType, job.experience, ...(job.tags || []), job.summary, String(job.description || '').slice(0, 1200)]
    .filter(Boolean)
    .join(' ');
  const convertibleNegated = /不转正|无转正|非转正|不能转正|不提供转正|无留用|不留用|实习结束即离职|仅实习/.test(internText);
  const convertible =
    !convertibleNegated && /转正|留用|可录用|优秀可留|留任|转正式/.test(internText);

  const expYears = parseExperienceYears(job.experience);
  // 「社招/社会招聘」是硬标记，可以采信。
  // 但**不能**把「有工作经验者优先」算进来 —— 那是软性措辞（有更好、没有也能投），
  // 而 category='social' 在届别过滤里是直接剔除的，
  // 等于因为一句「优先」把本来能投的岗位删掉了。
  const socialWord = /社招|社会招聘/.test(hay);  // 数据源自己标了「社招」时直接采信：公众号文章常在页脚写「2027届求职群」之类，
  // 会让年份检测出现假阳性，而岗位类型是逐岗位字段，比从正文里捞年份可靠得多。
  const explicitSocial =
    /社招|社会招聘/.test(String(job.jobType || '')) || /^社招/.test(String(extra.positionType || ''));

  // 要求 1 年以上经验、又没有任何强校招信号 → 判定为社招。
  // 但「1 年以上经验者优先」不是门槛（应届照样能投），不能拿它当社招证据 ——
  // 这条会**直接剔除**岗位，误伤代价比降分大得多。
  const expSoft = isSoftRequirement(String(job.experience || ''), /\d+\s*[-–~至]?\s*\d*\s*年/);
  const looksExperienced =
    expYears !== null && expYears >= 1 && !expSoft && !strongCampus && !isZhaopinCampus;

  let category;
  if (explicitSocial || looksExperienced) {
    category = 'social';
    if (looksExperienced) signals.push(`要求 ${expYears} 年经验`);
  } else if (isZhaopinCampus || strongCampus || years.size > 0) {
    category = 'campus';
  } else if (isIntern) {
    category = 'intern';
  } else if (socialWord) {
    category = 'social';
  } else if (/全职|兼职/.test(String(job.jobType || ''))) {
    // 招聘站上没写届别、也没有校招措辞的「全职」，基本都是社招
    category = 'social';
  } else if (sourceCampus) {
    // 来源声明是校招、又没有任何社招迹象 → 按校招放行
    // （放在「全职 → 社招」之后：jobType 已经是「校招」的岗位根本不会走到上面那条）
    category = 'campus';
    signals.push('来源声明为校招');
  } else if (weakCampus) {
    // 只写了「应届/毕业生」但没有任何校招项目措辞 —— 不足以判定为校招
    category = 'unknown';
    signals.push('仅提到应届，无校招项目措辞');
  } else {
    category = 'unknown';
  }

  // 实习岗单独标注，便于「要不要含实习」「要不要保留可转正实习」的开关
  if (isIntern && category === 'campus') signals.push('校招实习');
  if (isIntern && convertible) signals.push('可转正');

  return { category, years: [...years].sort(), explicitYears, yearAgnostic, isIntern, convertible, expYears, signals };
}

/**
 * 判断岗位是否符合「目标届别的校招」。
 * @param {object} job
 * @param {string|number} targetYear 目标届别，如 '2027'；留空表示不过滤
 * @param {{includeInternship?:boolean, strict?:boolean}} opts
 * @returns {{keep:boolean, reason:string, info:object}}
 */
export function matchTargetYear(
  job,
  targetYear,
  { includeInternship = true, strict = true, keepConvertibleInternship = true } = {},
) {
  const info = classifyJob(job);

  if (!targetYear) return { keep: true, reason: '未设置届别过滤', info };
  const target = Number(targetYear);
  if (!Number.isFinite(target)) return { keep: true, reason: '届别配置无效', info };

  // 1) 明确写了别的届别 → 直接排除
  if (info.years.length && !info.years.includes(target)) {
    return { keep: false, reason: `面向 ${info.years.join('/')} 届，非 ${target} 届`, info };
  }

  // 2) 社招 → 排除
  if (info.category === 'social') {
    const why = info.expYears ? `要求 ${info.expYears} 年经验` : '社招岗位';
    return { keep: false, reason: `${why}，非校招`, info };
  }

  // 3) 实习岗：按开关决定。
  //    但「只实习不转正」和「可转正实习」价值完全不同 —— 前者对找正式岗的人是白干，
  //    后者是正经的入职通道。所以 keepConvertibleInternship 打开时，明确写了
  //    转正/留用的实习继续保留，只排除那些纯实习的。
  if (info.isIntern && !includeInternship) {
    if (keepConvertibleInternship && info.convertible) {
      return { keep: true, reason: '可转正实习（按设置保留）', info };
    }
    return { keep: false, reason: '只实习、不转正的岗位（已按设置排除）', info };
  }

  // 4) 明确是本届校招
  if (info.years.includes(target)) {
    return { keep: true, reason: `明确面向 ${target} 届`, info };
  }

  // 5) 标注了「不限届别」的校招
  if (info.category === 'campus' && info.yearAgnostic) {
    return { keep: true, reason: '校招且不限届别', info };
  }

  // 6) 校招/实习但没写届别
  if (info.category === 'campus' || info.isIntern) {
    return { keep: true, reason: info.isIntern ? '实习岗，通常不限届别' : '校招岗，未标注具体届别', info };
  }

  // 7) 什么线索都没有：严格模式下排除
  if (strict) {
    return { keep: false, reason: '未标明届别，无法确认是校招', info };
  }
  return { keep: true, reason: '未标明届别（宽松模式保留）', info };
}

/**
 * 批量过滤，返回保留的岗位与剔除统计。
 */
export function filterByTargetYear(jobs, targetYear, opts = {}) {
  if (!targetYear) return { jobs, dropped: [], stats: { kept: jobs.length, dropped: 0, reasons: {} } };

  const kept = [];
  const dropped = [];
  const reasons = {};
  for (const j of jobs) {
    const r = matchTargetYear(j, targetYear, opts);
    if (r.keep) {
      j.yearMatch = { year: Number(targetYear), reason: r.reason, years: r.info.years, category: r.info.category };
      kept.push(j);
    } else {
      dropped.push({ job: j, reason: r.reason });
      // 归并统计口径，避免每种措辞各占一行
      const bucket = /非 \d+ 届/.test(r.reason) ? '其他届别' : /社招|经验/.test(r.reason) ? '社招' : /实习/.test(r.reason) ? '实习（已排除）' : '届别不明';
      reasons[bucket] = (reasons[bucket] || 0) + 1;
    }
  }
  return { jobs: kept, dropped, stats: { kept: kept.length, dropped: dropped.length, reasons } };
}

/** 为检索词补上届别，提升「搜到的就是目标届」的比例 */
export function yearQueryVariants(targetYear) {
  const y = Number(targetYear);
  if (!Number.isFinite(y)) return [];
  const short = String(y).slice(2);
  return [`${y}届`, `${y}届 校园招聘`, `${short}届校招`, `${y}届 秋招`];
}
