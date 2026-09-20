// 排查「优先被当成硬性」这一类问题还残留在哪些地方
import { classifyJob, matchTargetYear } from '../src/match/campus.mjs';
import { preScore, majorFit, filterByDegree } from '../src/match/score.mjs';
import { normalizeProfile } from '../src/resume/profile.mjs';
import { isSoftRequirement } from '../src/match/requirements.mjs';

const profile = normalizeProfile({
  major: '消防工程',
  degree: '本科',
  graduationYear: '2027',
  targetRoles: ['消防工程师'],
  keywords: ['消防工程'],
  preferredCities: [],
});

const row = (label, got, want, note = '') => {
  const ok = got === want;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(40)} got=${String(got).padEnd(22)} ${note}`);
  return ok;
};

let bad = 0;
const check = (...a) => {
  if (!row(...a)) bad++;
};

console.log('='.repeat(96));
console.log('  A. 学历里的「优先」');
console.log('='.repeat(96));
{
  const soft = { title: 'X', education: '硕士优先', company: 'x', tags: [], description: '消防工程相关。' };
  const hard = { title: 'X', education: '硕士及以上', company: 'x', tags: [], description: '消防工程相关。' };
  const s1 = preScore(soft, profile);
  const s2 = preScore(hard, profile);
  console.log(`     「硕士优先」   meta=${s1.breakdown.meta}`);
  console.log(`     「硕士及以上」 meta=${s2.breakdown.meta}`);
  check('「硕士优先」不应与硬性同分（应更高）', s1.breakdown.meta > s2.breakdown.meta, true, `${s1.breakdown.meta} vs ${s2.breakdown.meta}`);
}

console.log('\n' + '='.repeat(96));
console.log('  B. 经验里的「优先」在届别判定中会不会导致误删');
console.log('='.repeat(96));
{
  // 要验的是 looksExperienced 这条路径：它会把岗位判成社招**并直接剔除**。
  // 注意 jobType='全职' 的岗位即使修好也会被「无校招信号的全职 → 社招」那条兜底规则收走，
  // 所以这里用 jobType='实习' 来隔离出 looksExperienced 的影响。
  const soft = {
    title: '消防工程实习生',
    jobType: '实习',
    company: '某消防公司',
    experience: '1年以上相关经验者优先',
    description: '协助消防设施维护。',
    source: 'shixiseng',
  };
  const hard = { ...soft, experience: '1年以上', description: '协助消防设施维护。' };
  const c1 = classifyJob(soft);
  const c2 = classifyJob(hard);
  console.log(`     「1年以上经验者优先」 → category=${c1.category}  expYears=${c1.expYears}`);
  console.log(`     「1年以上」          → category=${c2.category}  expYears=${c2.expYears}`);
  check('软性经验不触发「要求N年经验→社招」', c1.category !== 'social', true, c1.category);
  check('硬性 N 年经验仍判社招（不能修过头）', c2.category === 'social', true, c2.category);

  // 全职岗位：修好后仍由「无校招信号的全职 → 社招」兜底，这是设计如此。
  // 注意 source 要换成 zhaopin —— isShixiseng 会被判成实习，先于全职规则生效。
  const fullTime = { ...soft, title: '消防工程师', jobType: '全职', source: 'zhaopin' };
  check('全职无校招信号仍按社招处理（既有设计不变）', classifyJob(fullTime).category === 'social', true, classifyJob(fullTime).category);
}

console.log('\n' + '='.repeat(96));
console.log('  C. SOFT/HARD 词典覆盖度');
console.log('='.repeat(96));
{
  const cases = [
    ['条件优秀者可放宽学历要求', '学历要求', true, '可放宽 → 软性'],
    ['有相关经验者优先考虑', '经验', true, '优先考虑'],
    ['持有证书者从优', '证书', true, '从优'],
    ['不符条件者勿投', '专业', false, '勿投 → 硬性'],
    ['务必持有安全员证', '安全员', false, '务必 → 硬性'],
    ['只招收消防工程专业', '消防工程', false, '只招收 → 硬性'],
    ['专业对口即可，经验不限', '专业', false, '无软硬标记 → 默认硬性'],
    ['持有中级会计职称优先', '中级会计', true, '优先'],
    ['谢绝应届生投递', '应届生', false, '谢绝 → 硬性'],
  ];
  for (const [text, kw, want, note] of cases) {
    const got = isSoftRequirement(text, kw);
    check(`${note}：「${text.slice(0, 14)}」`, got, want, `isSoft=${got}`);
  }
}

console.log('\n' + '='.repeat(96));
console.log('  D. 其他可能的「硬性/软性」混淆点');
console.log('='.repeat(96));
{
  // 学历下限过滤里，'硕士优先' 不应被当成「高于下限」而放行？其实放行是对的。
  // 但要看：'本科优先' 对本科生意味着什么
  const d = filterByDegree([{ title: 'A', education: '本科优先' }], profile);
  check('「本科优先」不被学历下限误删', d.jobs.length === 1, true, `dropped=${d.dropped.length}`);

  // 城市：多城市岗位
  // 专业匹配上「消防工程专业优先」时，专业**是对口的**，拿 +3 分是对的；
  // 这里要验的是「不对口的专业写成优先」不该扣分（见 test-requirement-severity）
  const mf = majorFit({ title: 'X', tags: [], description: '消防工程专业优先' }, profile);
  check('对口专业写成优先 → 给 +3 而非扣分', mf.score === 3, true, `score=${mf.score}`);
  const mf2 = majorFit({ title: 'X', tags: [], description: '计算机相关专业优先' }, profile);
  check('不对口专业写成优先 → 不扣分', mf2.score === 0, true, `score=${mf2.score}`);

  // 「经验不限」应加 4 分
  const s = preScore({ title: 'X', experience: '经验不限', tags: [], description: '消防工程。' }, profile);
  check('「经验不限」加分', s.breakdown.meta >= 12, true, `meta=${s.breakdown.meta}`);
}

console.log(`\n${bad === 0 ? '✅ 未发现残留问题' : `❌ 发现 ${bad} 处问题`}\n`);
process.exit(bad === 0 ? 0 : 1);
