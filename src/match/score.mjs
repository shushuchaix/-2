// 岗位匹配打分：规则预筛（快、可解释） + DeepSeek 精排（准、有理由）
import { cityMatches, chunk, normKey, pool, truncate } from '../util/text.mjs';
import { deriveRoleKeywords } from '../resume/profile.mjs';
import { isSoftRequirement, hasSoftMarker } from './requirements.mjs';
import { findSkillEvidence, majorRoleFit } from '../domain/skills.mjs';

const DEGREE_RANK = { 学历不限: 0, 不限: 0, 高中: 1, 中专: 1, 中技: 1, 大专: 2, 专科: 2, 本科: 3, 学士: 3, 硕士: 4, 研究生: 4, MBA: 4, 博士: 5 };

function degreeRank(s = '') {
  const t = String(s).replace(/\s/g, '');
  if (!t) return null;
  for (const [k, v] of Object.entries(DEGREE_RANK)) if (t.includes(k)) return v;
  return null;
}

/** 判断求职者是否为「应届 / 在校找实习」身份 */
export function isFresher(profile = {}) {
  if (profile.graduationYear) return true;
  if (/校招|实习|应届/.test((profile.jobTypes || []).join(' '))) return true;
  if ((profile.targetRoles || []).some((r) => /实习|应届|培训生|管培/.test(r))) return true;
  return false;
}

/**
 * 学历下限过滤：排除**明确要求低于自己学历**的岗位。
 *
 * 本科求职者不需要看「大专及以上」的岗位 —— 不是不能投，而是那种岗位的
 * 薪资与成长空间通常和他的学历不匹配，列出来只是噪声。
 *
 * 三种情况必须保留（不能误杀）：
 *   · 学历不限 / 未标注 —— 对所有人开放，本科当然可以投
 *   · 要求高于自己学历（本科看到「硕士及以上」）—— 这是上限问题，
 *     由打分去降权提示，不该在这里直接删掉（有些岗位「硕士优先」实际也收本科）
 */
export function filterByDegree(jobs, profile, { minDegree = '' } = {}) {
  const floor = degreeRank(minDegree) ?? degreeRank(profile?.degree);
  // floor 为 null（画像没写学历）或 0（学历不限）时不做下限过滤
  if (floor === null || floor === 0) return { jobs, dropped: [], floor: null };
  const kept = [];
  const dropped = [];
  for (const j of jobs) {
    const jr = degreeRank(j.education);
    // 不剔除的三种情况：
    //   jr === null  → 未标注学历
    //   jr === 0     → 明确写着「学历不限 / 不限」，对所有人开放
    //   jr >= floor  → 达到或高于下限（高于下限是「上限问题」，交给打分提示，不在这里删）
    if (jr !== null && jr > 0 && jr < floor) {
      dropped.push({ job: j, reason: `学历要求 ${j.education}，低于你的学历` });
    } else {
      kept.push(j);
    }
  }
  return { jobs: kept, dropped, floor };
}

/** 岗位是否为面向应届/实习的岗位 */
function isCampusFriendly(job) {
  const text = `${job.jobType || ''} ${job.title || ''}`;
  return /实习|校招|应届|培训生|管培/.test(text);
}

/** 岗位可检索文本（用于关键词命中判定） */
export function jobText(job) {
  return [
    job.title,
    // 标题被字体混淆且未还原时，检索关键词是可靠的替代信号
    job.titleObfuscated && !job.titleRepaired ? job.queryKeyword : '',
    job.company,
    ...(job.skills || []),
    ...(job.tags || []),
    job.summary,
    job.description,
  ]
    .filter(Boolean)
    .join(' ');
}

/** 用于岗位方向匹配的标题来源 */
function roleTitleOf(job) {
  if (job.titleObfuscated && !job.titleRepaired) return `${job.title || ''} ${job.queryKeyword || ''}`.trim();
  return job.title || '';
}

/** 关键词命中（做大小写/全半角归一，兼容 "Spring Boot" vs "SpringBoot"） */
export function matchedKeywords(job, keywords = []) {
  const text = jobText(job);
  const normText = normKey(text);
  const hits = [];
  for (const kw of keywords) {
    const k = String(kw).trim();
    if (!k) continue;
    if (findSkillEvidence(text, [k]).some(e=>e.relation !== 'related')) hits.push(k);
  }
  return [...new Set(hits)];
}

/**
 * 岗位族词表（按画像缓存，避免每个岗位重算一遍）
 * 由「专业 + 技能」推导，而不是只用简历里写的那几个岗位名。
 */
function roleVocabulary(profile) {
  if (!profile.__roleVocab) {
    profile.__roleVocab = deriveRoleKeywords(profile, { max: 40 })
      .map((r) => ({ raw: r, norm: normKey(r) }))
      .filter((v) => v.norm.length >= 2);
  }
  return profile.__roleVocab;
}

/**
 * 专业匹配度。
 * 岗位若写明「需求专业」或列出专业要求，就拿来和求职者专业比对。
 * 这是「专业与岗位是否相符」的直接依据，与技能命中互补。
 */
const CS_FAMILY = /计算机|软件|信息|电子|通信|自动化|人工智能|数据|网络|智能/;
export function majorFit(job, profile) {
  const major = String(profile.major || '').replace(/专业$/, '');
  if (!major) return { score: 0, note: '' };
  const need = [
    job.extra?.major || '',
    ...(job.tags || []),
    String(job.description || '').slice(0, 600),
  ].join(' ');
  if (!need.trim()) return { score: 0, note: '' };
  if (/不限专业|专业不限/.test(need)) return { score: 0, note: '专业不限' };
  if (need.includes(major)) return { score: 3, note: `要求 ${major}，与你的专业一致` };
  // 同族专业也算相符（计算机类岗位往往列一串相近专业）
  const core = major.slice(-3);
  if (core.length >= 2 && need.includes(core)) return { score: 2, note: `要求含 ${core} 相关专业` };
  if (majorRoleFit(profile,{...job,description:need}).status === 'matched') return { score: 1, note: '岗位与专业方向相符' };
  // 明确列了专业要求但都不沾边 → 扣分。
  // 但**只提到「优先」时不能扣**：「计算机相关专业优先」对消防工程学生不是门槛，
  // 只是少个加分；按硬性要求扣 3 分会把本来能投的岗位压下去。
  if (/专业/.test(need) && need.length < 200) {
    const soft = [...need.matchAll(/[\u4e00-\u9fa5]{2,10}专业/g)].some((m) =>
      isSoftRequirement(need, m[0]),
    );
    if (soft) return { score: 0, note: '岗位提到相关专业优先（非硬性要求）' };
    return { score: -3, note: '岗位专业要求与你的专业不符' };
  }
  return { score: 0, note: '' };
}

/**
 * 规则预筛评分（0-100）
 *
 * 权重经过一次重要调整：原先「岗位方向」占 35 分且要求标题逐字命中目标岗位，
 * 结果标题写作「服务端研发」「平台开发」但要求高度吻合的岗位全被挡在短名单外。
 * 现在方向降到 22 分并改为匹配整个岗位族词表，技能/岗位要求提到 45 分 ——
 * 因为用户要的是「简历能胜任」，而不是「标题叫得一样」。
 *
 * 维度：岗位方向 22 + 技能要求 45 + 城市 15 + 学历/专业适配 18
 */
/**
 * 「安全工程师」是消防/安全工程 与 IT 安全 **同名不同行**的典型陷阱。
 *
 * 消防工程的学生搜「安全工程师」，在理工类院校就业网上捞回来的几乎全是
 * 「网络安全工程师」；而归一化后的子串匹配会让「网络安全工程师」命中
 * 岗位族里的「安全工程师」，白拿 22 分方向分。实测西电一所就返回 10 条这类岗位。
 *
 * 所以：画像方向是消防/安全工程时，标题里带 IT 安全特征词且不带消防特征的，判为跨方向。
 */
const FIRE_SAFETY_MAJOR = /消防|安全工程|安全科学|应急技术|职业健康|EHS|HSE/i;
const IT_SECURITY_TITLE = /网络安全|信息安全|渗透|等保|安全攻防|Web安全|漏洞挖掘|安全运营中心|SOC/i;
const FIRE_SAFETY_TITLE = /消防|防火|防排烟|灭火|应急|安全工程|EHS|HSE|安全生产|职业健康/i;

export function isCrossDomainSecurity(job, profile) {
  if (!FIRE_SAFETY_MAJOR.test(String(profile.major || ''))) return false;
  const title = String(job.title || '');
  if (!IT_SECURITY_TITLE.test(title)) return false;
  // 关键：不能直接拿 FIRE_SAFETY_TITLE 去测整条标题 ——
  // '网络安全工程师'.includes('安全工程') 为真，会被当成「消防特征」而放过。
  // 所以先把 IT 安全词剥掉，再看剩下的部分有没有真正的消防特征。
  const stripped = title.replace(/网络安全|信息安全|渗透测试|渗透|等保|安全攻防|Web安全|漏洞挖掘|安全运营中心|SOC/gi, '');
  return !FIRE_SAFETY_TITLE.test(stripped);
}

/**
 * 证书匹配（0–6 分）。
 *
 * 为什么单独做一维：证书是招聘里少见的**硬性、可验证**门槛。
 * 「注册消防工程师」「安全员C证」「初级会计」「CPA」「软考」这类词，
 * 岗位写了就是要求，简历有就是优势，比拿它当普通关键词准得多。
 * 同时识别「岗位要求而简历没有」的证书，写进提示（不扣分）。
 */
/**
 * 证书分两档 —— 因为「有加分的证书」和「有门槛的证书」价值差很多：
 *   gate（准入类，值 6 分）：注册消防工程师、注册安全工程师、法律职业资格、CPA 等，
 *                            岗位写了通常就是硬门槛，有就是显著优势
 *   plus（通用加分项，值 2 分）：英语四级、计算机二级、驾照 —— 这类几乎是「人人都有」的
 *                            基础项，岗位提到往往是「优先」，有它不是差异化优势。
 *                            给 6 分会让所有岗位都被拉高，反而稀释了真正有价值的证书信号。
 */
const CERT_GATE = [
  ['注册消防工程师', /一级注册消防工程师|二级注册消防工程师|注册消防工程师/],
  ['消防设施操作员', /消防设施操作员|建（构）筑物消防员/],
  ['注册安全工程师', /注册安全工程师|注安/],
  ['安全员证', /安全员\s*[ABC]?\s*证|安全生产考核合格证|三类人员/],
  ['初级会计', /初级会计(?:职称)?|助理会计师/],
  ['中级会计', /中级会计(?:职称)?|会计师职称/],
  ['CPA', /CPA|注册会计师/],
  ['ACCA', /ACCA|特许公认会计师/],
  ['法律职业资格', /法律职业资格|司法考试|法考/],
  ['教师资格证', /教师资格证|教师资格/],
  ['软考', /软考|软件水平考试|系统集成项目管理工程师/],
  ['BIM 证书', /BIM\s*(?:工程师|技能)?\s*(?:证书|等级)|图学会\s*BIM/],
];

const CERT_PLUS = [
  ['英语四级', /英语四级|CET-?4|四级(?:证书|成绩)/],
  ['英语六级', /英语六级|CET-?6|六级(?:证书|成绩)/],
  ['计算机二级', /计算机二级|NCRE\s*二级/],
  ['驾照', /驾驶证|驾照/],
  ['普通话等级', /普通话(?:二级|一级|等级)/],
];

/** 兼容旧名：所有已知证书（含两档） */
const CERT_ALIAS = [...CERT_GATE, ...CERT_PLUS];

const CERT_SCORE = { gate: 6, plus: 2 };

function ownedCertificates(profile) {
  const raw = [...(profile.certificates || []), ...(profile.keywords || []), ...(profile.skills || []).map((s) => s?.name)].join(' ');
  const owned = [];
  for (const [tier, list] of [['gate', CERT_GATE], ['plus', CERT_PLUS]]) {
    for (const [name, re] of list) if (re.test(raw)) owned.push({ name, re, tier });
  }
  return owned;
}

export function certificateFit(job, profile) {
  const owned = ownedCertificates(profile);
  const hay = `${job.title || ''} ${job.description || ''} ${(job.tags || []).join(' ')}`;
  // 准入类证书优先匹配：同一岗位若既提到注册消防工程师又提到英语四级，
  // 应该按前者算（那才是真正的门槛），不能被通用加分项抢了。
  for (const tier of ['gate', 'plus']) {
    for (const c of owned.filter((x) => x.tier === tier)) {
      if (!c.re.test(hay)) continue;
      const score = CERT_SCORE[tier];
      return {
        score,
        note: tier === 'gate' ? `岗位提到「${c.name}」，你已有` : `岗位提到「${c.name}」（基础加分项）`,
      };
    }
  }
  // 岗位要求了某类证书、而简历里没有 → 提示差距（不扣分）。
  // 注意这里**不**因为「简历没写证书」就整体跳过：岗位硬性要求某个证而你没有，
  // 是最该提醒的情况（投了也白投），跟简历里有没有别的证书无关。
  // 「持有 X 证书者优先」不是硬性要求，不该提示成差距 —— 用分句级判别，
  // 否则「有注册消防工程师资格者优先录用」这种稍长的措辞会漏判。
  for (const list of [CERT_GATE, CERT_PLUS]) {
    for (const [name, re] of list) {
      if (!re.test(hay)) continue;
      if (isSoftRequirement(hay, re)) continue;
      return { score: 0, note: `岗位要求「${name}」，简历中未见` };
    }
  }
  return { score: 0, note: '' };
}

/**
 * 技能熟练度加分（0–4 分）。
 * 简历写「Java（熟练）/ Python（了解）」，命中同一个岗位不该同分。
 */
const LEVEL_WEIGHT = [
  [/精通|专家|熟练|深入/, 1.0],
  [/掌握|熟悉|较熟/, 0.8],
  [/了解|入门|初步|基本/, 0.4],
];

export function proficiencyBonus(job, profile, hits = []) {
  const skills = (profile.skills || []).filter((s) => s && s.name);
  if (!skills.length || !hits.length) return 0;
  const weightOf = (s) => {
    const lv = String(s.level || '');
    for (const [re, w] of LEVEL_WEIGHT) if (re.test(lv)) return w;
    return 0.6; // 简历没写等级 → 中性
  };
  const hitSet = new Set(hits);
  const matched = skills.filter((s) => hitSet.has(s.name));
  if (!matched.length) return 0;
  const avg = matched.reduce((a, s) => a + weightOf(s), 0) / matched.length;
  // 全「熟练」→ 4 分；全「了解」→ 约 1.6 分
  return Math.max(0, Math.min(4, Math.round(avg * 4)));
}

export function preScore(job, profile) {
  const keywords = profile.keywords || [];
  const hits = matchedKeywords(job, keywords);
  const titleNorm = normKey(roleTitleOf(job));
  const crossDomain = isCrossDomainSecurity(job, profile);

  // --- 岗位方向（22 分）：匹配整个岗位族，而非逐个标题字面比对 ---
  const vocab = roleVocabulary(profile);
  const bodyNorm = normKey(
    [job.summary, ...(job.skills || []), ...(job.tags || []), String(job.description || '').slice(0, 800)]
      .filter(Boolean)
      .join(' '),
  );
  let roleScore = 0;
  let roleHit = '';
  for (const v of vocab) {
    if (titleNorm.includes(v.norm)) {
      roleScore = 22;
      roleHit = v.raw;
      break;
    }
  }
  if (crossDomain && roleScore) {
    // 「网络安全工程师」不是消防/安全工程的对口岗位，方向分与命中词都要撤掉
    roleScore = 0;
    roleHit = '';
  }
  if (!roleScore && !crossDomain) {
    // 标题没命中时，退回岗位描述里找方向线索（很多岗位标题很泛，如「开发工程师」）
    for (const v of vocab) {
      if (bodyNorm.includes(v.norm)) {
        roleScore = 14;
        roleHit = v.raw;
        break;
      }
    }
  }
  if (!roleScore && !crossDomain) {
    // 标题里含有关键词也算方向沾边
    const titleHits = matchedKeywords(job, keywords.slice(0, 12));
    if (titleHits.length) {
      roleScore = Math.min(10, 4 + titleHits.length * 2);
      roleHit = titleHits[0];
    }
  }

  // --- 技能 / 岗位要求匹配（45 分）---
  // 跨方向（消防学生 vs 网安岗位）时，「安全工程」「安全管理」这类词在两边都出现但含义不同，
  // 不能算作技能命中，否则一条「网络安全工程师」照样能靠它们拿到技能分。
  const AMBIGUOUS_SAFETY = /^(安全工程|安全管理|安全生产|安全技术|安全评价|安全员|安全防护|安全规程|安全标准化|安全咨询|安全环保)$/;
  const effectiveHits = crossDomain ? hits.filter((h) => !AMBIGUOUS_SAFETY.test(h)) : hits;
  const base = keywords.length || 1;
  const skillScore = Math.min(45, Math.round((effectiveHits.length / Math.min(base, 12)) * 45));

  // --- 城市 ---
  let cityScore = 8;
  if (!profile.preferredCities?.length) cityScore = 15; // 不限城市 → 不因城市丢分
  else if (!job.city) cityScore = 12;
  else if (cityMatches(job.city, profile.preferredCities)) cityScore = 15;
  else cityScore = 3;

  // --- 学历 / 经验 / 专业适配（18 分）---
  const mf = majorFit(job, profile);
  let metaScore = 8 + mf.score;
  const jr = degreeRank(job.education);
  const pr = degreeRank(profile.degree);
  if (jr !== null && pr !== null) {
    if (jr <= pr) {
      metaScore += 4;
    } else if (hasSoftMarker(job.education)) {
      // 「硕士优先」不是门槛 —— 本科照样能投，只是不占优势。
      // 按硬性要求扣 8 分会把这类岗位直接压死（很多岗位写「硕士优先」实际也收优秀本科）。
      metaScore += 0;
    } else {
      metaScore -= 8;
    }
  } else {
    metaScore += 2;
  }

  const fresher = isFresher(profile);
  const expText = String(job.experience || '');
  const campusFriendly = isCampusFriendly(job);

  if (/不限|应届|无经验|在校/.test(expText)) {
    metaScore += 4;
  } else {
    // 明确要求 N 年经验，而求职者是应届生 → 显著降权。
    // 但「N 年经验优先」不是门槛：应届生照样能投，不该按硬性要求扣分。
    const m = expText.match(/(\d+)\s*[-–~至]?\s*(\d+)?\s*年/);
    const expSoft = m ? isSoftRequirement(expText, m[0]) : false;
    if (m && fresher && !expSoft) metaScore -= Math.min(8, 2 + Number(m[1]) * 2);
  }
  if (fresher && campusFriendly) metaScore += 4;

  metaScore = Math.max(0, Math.min(18, metaScore));

  // --- 证书匹配（0–6 分，加分项）---
  // 证书是强信号，之前完全没用上：消防工程方向的「注册消防工程师」「安全员C证」，
  // 财务方向的「初级会计」「CPA」，IT 方向的「软考」等，很多岗位是硬性要求。
  const cert = certificateFit(job, profile);
  const certScore = cert.score;

  // --- 技能熟练度（0–4 分，加分项）---
  // 简历写「Java（熟练）/ Python（了解）」，命中同一个岗位不该同分。
  const profScore = proficiencyBonus(job, profile, hits);

  const total = Math.max(
    0,
    Math.min(
      100,
      Math.round(roleScore + skillScore + cityScore + metaScore + certScore + profScore),
    ),
  );
  return {
    preScore: total,
    matched: hits,
    roleHit,
    majorNote: mf.note,
    certNote: cert.note,
    breakdown: {
      role: roleScore,
      skill: skillScore,
      city: cityScore,
      meta: metaScore,
      cert: certScore,
      prof: profScore,
    },
  };
}

/** 对全部岗位做规则预筛并排序 */
export function preScoreAll(jobs, profile) {
  return jobs
    .map((job) => {
      const s = preScore(job, profile);
      return {
        ...job,
        preScore: s.preScore,
        matchedKeywords: s.matched,
        roleHit: s.roleHit,
        majorNote: s.majorNote,
        certNote: s.certNote,
        scoreBreakdown: s.breakdown,
        score: s.preScore,
        scoreSource: 'rule',
        reasons: buildRuleReasons(job, profile, s),
        gaps: buildRuleGaps(job, profile, s),
      };
    })
    .sort((a, b) => b.preScore - a.preScore);
}

function buildRuleReasons(job, profile, s) {
  const out = [];
  if (s.roleHit) out.push(`岗位方向匹配你的「${s.roleHit}」方向`);
  if (s.matched.length) out.push(`命中技能关键词：${s.matched.slice(0, 8).join('、')}`);
  if (s.majorNote) out.push(s.majorNote);
  if (s.certNote && s.breakdown?.cert > 0) out.push(s.certNote);
  if (s.breakdown?.prof >= 3) out.push('命中项里有你标注为「熟练 / 精通」的技能');
  if (job.city && profile.preferredCities?.length && cityMatches(job.city, profile.preferredCities)) {
    out.push(`工作城市 ${job.city} 在你的期望范围内`);
  }
  if (job.education && profile.degree && degreeRank(job.education) !== null && degreeRank(profile.degree) !== null && degreeRank(job.education) <= degreeRank(profile.degree)) {
    out.push(`学历要求 ${job.education}，你符合`);
  }
  if (isFresher(profile) && isCampusFriendly(job)) out.push('面向应届生 / 实习的岗位，投递门槛友好');
  if (/不限/.test(String(job.experience || ''))) out.push('经验不限，适合应届投递');
  return out;
}

function buildRuleGaps(job, profile, s = {}) {
  const out = [];
  if (s.certNote && /简历中未见/.test(s.certNote)) out.push(s.certNote);
  if (isFresher(profile)) {
    const m = String(job.experience || '').match(/\d+\s*[-–~至]?\s*\d*\s*年/);
    if (m) out.push(`岗位要求 ${m[0]}经验，你目前是应届 / 在校身份`);
  }
  const jr = degreeRank(job.education);
  const pr = degreeRank(profile.degree);
  if (jr !== null && pr !== null && jr > pr) out.push(`岗位要求 ${job.education}，高于你的 ${profile.degree}`);
  return out;
}

/* ------------------------- LLM 精排 ------------------------- */

const SCORE_SYSTEM = `你是中国校园招聘的岗位匹配评估专家。你要判断每个岗位与该求职者简历的匹配程度。

评分标准（0-100）：
- 90-100 高度匹配：岗位方向、技能栈、学历、城市几乎完全对口，可直接投递
- 75-89  比较匹配：方向一致，核心技能大部分命中，有少量差距
- 60-74  一般匹配：方向沾边或技能部分重叠，需要补短板
- 40-59  弱匹配：岗位方向偏离，仅个别技能相关
- 0-39   不匹配：方向完全不同，或明确要求远超求职者资历

要求：
1. 必须严格依据给出的岗位信息与简历画像判断，不得臆测。
2. 薪资、公司规模不作为主要依据，岗位职责与技能要求才是关键。
3. **务必区分「硬性要求」与「优先条件」**：
   - 硬性要求（须持有 / 必须 / 仅限 / 要求 X 年以上）不满足时，分数要显著降低，并在 gaps 中说明；
   - 优先条件（「…者优先」「…加分」「有则更好」）不满足时**不要降低分数**，也不要写进 gaps，
     最多在 reasons 里说明「这是加分项而非门槛」。求职者投递这类岗位是完全可行的。
4. 若岗位明确要求多年工作经验（非「优先」）而求职者是应届生，分数必须显著降低并在 gaps 中说明。
5. reasons 用中文短句，指向具体命中点；gaps 指向具体差距；没有差距就留空数组。
6. 严格输出 JSON，不要任何解释或 Markdown 围栏。`;

function jobCard(job, index) {
  const titleShown = job.titleObfuscated && !job.titleRepaired && job.queryKeyword ? `${job.title}（来源于检索词「${job.queryKeyword}」，标题被原站字体混淆）` : job.title;
  const lines = [
    `【岗位 ${index}】`,
    `标题：${titleShown}`,
    `公司：${job.company || '未知'}`,
    `城市：${job.city || '未知'}${job.district ? ' ' + job.district : ''}`,
    `薪资：${job.salary || '未标注'} | 学历：${job.education || '未标注'} | 经验：${job.experience || '未标注'} | 类型：${job.jobType || '未标注'}`,
    `技能标签：${(job.skills || []).slice(0, 12).join('、') || '无'}`,
    `其他标签：${(job.tags || []).slice(0, 10).join('、') || '无'}`,
  ];
  const desc = job.description || job.summary || '';
  if (desc) lines.push(`岗位描述：${truncate(desc.replace(/\s+/g, ' '), 900)}`);
  return lines.join('\n');
}

function profileCard(profile) {
  const lines = [
    `学历：${profile.degree || '未知'} | 专业：${profile.major || '未知'} | 学校：${profile.school || '未知'} | 毕业年份：${profile.graduationYear || '未知'}`,
    `求职类型：${(profile.jobTypes || []).join('、') || '未说明'}`,
    `目标岗位：${(profile.targetRoles || []).join('、') || '未说明'}`,
    `期望城市：${(profile.preferredCities || []).join('、') || '不限'}`,
    `技能关键词：${(profile.keywords || []).slice(0, 30).join('、')}`,
    profile.internships?.length ? `实习经历：${profile.internships.map((i) => `${i.company}${i.role ? '(' + i.role + ')' : ''}`).join('；')}` : '',
    profile.projects?.length ? `项目经历：${profile.projects.map((p) => `${p.name}${p.tech?.length ? '[' + p.tech.join('/') + ']' : ''}`).join('；')}` : '',
    profile.summary ? `画像概述：${profile.summary}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 用 LLM 批量精排岗位
 * @returns 带 llmScore / reasons / gaps 的岗位数组（失败时保留规则分）
 */
export async function scoreWithLlm(llm, profile, jobs, { batchSize = 8, log = () => {}, concurrency } = {}) {
  if (!jobs.length) return jobs;
  const batches = chunk(jobs.map((j, i) => ({ job: j, i })), batchSize);
  const limit = concurrency || llm.concurrency;
  let done = 0;

  await pool(batches, limit, async (batch) => {
    const listText = batch.map(({ job, i }) => jobCard(job, i)).join('\n\n');
    const user = `## 求职者画像\n${profileCard(profile)}\n\n## 待评估岗位（共 ${batch.length} 个）\n${listText}\n\n请对上面每个岗位给出评分。输出 JSON：\n{"results":[{"index":<岗位编号>,"score":<0-100整数>,"verdict":"高度匹配|比较匹配|一般匹配|弱匹配|不匹配","reasons":["中文短句"],"gaps":["中文短句"],"matchedKeywords":["命中的技能词"]}]}\n必须为每个岗位编号都输出一条结果。`;

    try {
      const res = await llm.chatJson(SCORE_SYSTEM, user, { temperature: 0.1, maxTokens: 2600 });
      const results = Array.isArray(res) ? res : res?.results || res?.data || [];
      const byIndex = new Map();
      for (const r of results) {
        const idx = Number(r?.index);
        if (Number.isFinite(idx)) byIndex.set(idx, r);
      }
      for (const { job, i } of batch) {
        const r = byIndex.get(i);
        if (!r) continue;
        const s = Number(r.score);
        if (Number.isFinite(s)) {
          job.llmScore = Math.max(0, Math.min(100, Math.round(s)));
          job.score = job.llmScore;
          job.scoreSource = 'llm';
        }
        if (typeof r.verdict === 'string' && r.verdict.trim()) job.verdict = r.verdict.trim();
        if (Array.isArray(r.reasons) && r.reasons.length) job.reasons = r.reasons.map(String).filter(Boolean);
        if (Array.isArray(r.gaps)) job.gaps = r.gaps.map(String).filter(Boolean);
        if (Array.isArray(r.matchedKeywords) && r.matchedKeywords.length) {
          job.matchedKeywords = [...new Set([...(job.matchedKeywords || []), ...r.matchedKeywords.map(String)])];
        }
      }
    } catch (e) {
      log(`LLM 精排批 ${Math.floor(batch[0].i / batchSize) + 1} 失败：${e.message}（该批保留规则分）`);
    }
    done += batch.length;
    log(`LLM 精排进度 ${done}/${jobs.length}`);
  });

  return jobs;
}

/** 综合判定等级（LLM 未给 verdict 时按分数推导） */
export function verdictOf(job) {
  if (job.verdict) return job.verdict;
  const s = job.score ?? 0;
  if (s >= 90) return '高度匹配';
  if (s >= 75) return '比较匹配';
  if (s >= 60) return '一般匹配';
  if (s >= 40) return '弱匹配';
  return '不匹配';
}
