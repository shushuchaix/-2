// 「硬性要求」vs「优先条件」的判别测试
//
// 核心命题：**不能因为一句「优先」就降分或剔除岗位**（那是能投的），
// 同时**不能把硬性要求当软性放行**（那是投了也白投）。
import { isSoftRequirement, clauseAt, hasSoftMarker, hasHardMarker } from '../src/match/requirements.mjs';
import { classifyJob, filterByTargetYear } from '../src/match/campus.mjs';
import { majorFit, certificateFit, preScore } from '../src/match/score.mjs';
import { normalizeProfile } from '../src/resume/profile.mjs';

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`);
  }
};

console.log('\n[1] 分句提取');
ok('逗号切分', clauseAt('A，B，C', 2, 1) === 'B', clauseAt('A，B，C', 2, 1));
ok('换行切分', clauseAt('A\nB\nC', 2, 1) === 'B', clauseAt('A\nB\nC', 2, 1));
ok('句号切分', clauseAt('A。B。C', 2, 1) === 'B', clauseAt('A。B。C', 2, 1));

console.log('\n[2] 软性 / 硬性判别');
const SOFT = '持有注册消防工程师证书者优先';
const HARD = '必须持有注册消防工程师证书';
const HARD2 = '须具备安全员C证';
ok('「者优先」判为软性', isSoftRequirement(SOFT, '注册消防工程师'));
ok('「必须持有」判为硬性', !isSoftRequirement(HARD, '注册消防工程师'));
ok('「须具备」判为硬性', !isSoftRequirement(HARD2, '安全员'));
ok('没有关键词时返回 false', !isSoftRequirement('随便写点东西', '注册消防工程师'));

console.log('\n[3] 跨分句不能串味（关键回归）');
// 「优先」出现在另一个分句里，不能把前一句的硬性要求染成软性
{
  const text = '必须持有注册消防工程师证书，有大型项目经验者优先';
  ok('后句的「优先」不污染前句硬性要求', !isSoftRequirement(text, '注册消防工程师'), clauseAt(text, 0, 9));
}
{
  const text = '持有中级会计职称优先，但必须持有初级会计证书';
  ok('前句的「优先」不把后句硬性要求变成软性', !isSoftRequirement(text, '初级会计'));
  ok('前句自身仍判为软性', isSoftRequirement(text, '中级会计'));
}
{
  // 极端情况：同一分句里既有「优先」又有「必须」→ 按硬性处理（从严）
  const text = '必须持有证，能力强者优先';
  ok('同分句内「必须」压过「优先」', !isSoftRequirement(text, '必须持有证'));
}

console.log('\n[4] 届别分类：不能因「有工作经验者优先」被判成社招并剔除');
{
  const job = {
    title: '消防工程师',
    jobType: '校招',
    company: '某消防技术公司',
    description: '负责消防设施维保；有相关工作经验者优先。',
    isCampus: true,
    source: 'jiuyeqiao',
  };
  const c = classifyJob(job);
  console.log(`     分类=${c.category}  信号=[${(c.signals || []).join(',')}]`);
  ok('不再被判成社招', c.category !== 'social', c.category);
  ok('能通过 2027 届严格过滤（保留）', filterByTargetYear([job], '2027', { includeStrict: true, strict: true }).jobs.length === 1);
}
{
  // 反向：真正写着「社招」的必须仍然剔除
  const job = {
    title: '消防工程师（社招）',
    jobType: '社招',
    company: 'X',
    description: '急聘消防工程师，要求 3 年以上经验。',
    source: 'zhaopin',
  };
  const c = classifyJob(job);
  ok('明确写「社招」仍判为社招', c.category === 'social', c.category);
  ok('明确社招仍被剔除', filterByTargetYear([job], '2027', { strict: true }).jobs.length === 0);
}
{
  // 反向：「3 年经验」是硬要求 → 仍判社招
  const job = { title: '消防工程师', company: 'X', experience: '3-5年', description: '负责消防设计。', source: 'zhaopin' };
  ok('硬性 3 年经验仍判社招', classifyJob(job).category === 'social', classifyJob(job).category);
}

console.log('\n[5] 专业匹配：不能因「…专业优先」扣分');
const profile = normalizeProfile({
  major: '消防工程',
  degree: '本科', // 学历相关断言需要它；也用于 isFresher / 学历降权
  targetRoles: ['消防工程师'],
  keywords: ['消防工程'],
  preferredCities: [],
  graduationYear: '2027', // 应届生身份：经验要求的降权只对应届生生效
});
{
  const soft = { title: '安全管理岗', tags: [], description: '负责现场安全；计算机相关专业优先。' };
  const hard = { title: '安全管理岗', tags: [], description: '负责现场安全；仅限计算机相关专业。' };
  const s1 = majorFit(soft, profile);
  const s2 = majorFit(hard, profile);
  console.log(`     软性: score=${s1.score} note=${s1.note}`);
  console.log(`     硬性: score=${s2.score} note=${s2.note}`);
  ok('「专业优先」不扣分', s1.score === 0, String(s1.score));
  ok('硬性专业不符才扣分', s2.score === -3, String(s2.score));
}

console.log('\n[6] 证书：软性要求不写进 gaps，硬性要求才写');
const fire = normalizeProfile({
  major: '消防工程',
  targetRoles: ['消防工程师'],
  keywords: ['消防工程'],
  certificates: ['安全员C证'],
  preferredCities: [],
});
{
  const soft = { title: 'X', description: '持有注册消防工程师证书者优先。', tags: [] };
  const hard = { title: 'Y', description: '必须持有注册消防工程师证书。', tags: [] };
  ok('软性缺失 → 无提示', fire && certificateFit(soft, fire).note === '', certificateFit(soft, fire).note);
  ok('硬性缺失 → 有提示', /简历中未见/.test(certificateFit(hard, fire).note), certificateFit(hard, fire).note);
  // 已有的证书命中时不受影响
  const owned = { title: 'Z', description: '须持有安全员C证。', tags: [] };
  ok('已有证书命中 → +6', certificateFit(owned, fire).score === 6, String(certificateFit(owned, fire).score));
}

console.log('\n[7] 经验：软性「N 年经验优先」不扣分');
{
  const soft = { title: '消防工程师', experience: '3年以上经验者优先', description: '消防设计。', tags: [] };
  const hard = { title: '消防工程师', experience: '3年以上', description: '消防设计。', tags: [] };
  const s1 = preScore(soft, profile);
  const s2 = preScore(hard, profile);
  console.log(`     软性 meta=${s1.breakdown.meta} 总分=${s1.preScore}`);
  console.log(`     硬性 meta=${s2.breakdown.meta} 总分=${s2.preScore}`);
  ok('「经验优先」的 meta 分更高', s1.breakdown.meta > s2.breakdown.meta, `${s1.breakdown.meta} vs ${s2.breakdown.meta}`);
  ok('软性比硬性总分高', s1.preScore > s2.preScore, `${s1.preScore} vs ${s2.preScore}`);
}

console.log('\n[8] 辅助函数');
ok('hasSoftMarker 识别「加分」', hasSoftMarker('有证书者加分'));
ok('hasSoftMarker 对硬性文本返回 false', !hasSoftMarker('必须持有证书'));
ok('hasHardMarker 识别「仅限」', hasHardMarker('仅限消防工程专业'));

console.log('\n[9] 学历里的「优先」：硕士优先 ≠ 硕士及以上');
{
  const soft = { title: 'X', education: '硕士优先', tags: [], description: '消防工程相关。' };
  const hard = { title: 'X', education: '硕士及以上', tags: [], description: '消防工程相关。' };
  const s1 = preScore(soft, profile);
  const s2 = preScore(hard, profile);
  console.log(`     「硕士优先」meta=${s1.breakdown.meta}  「硕士及以上」meta=${s2.breakdown.meta}`);
  ok('「硕士优先」不按硬性扣分', s1.breakdown.meta > s2.breakdown.meta, `${s1.breakdown.meta} vs ${s2.breakdown.meta}`);
  ok('「硕士优先」不扣 8 分', s1.breakdown.meta >= 8, String(s1.breakdown.meta));
  ok('「硕士及以上」仍按硬性扣分', s2.breakdown.meta < 8, String(s2.breakdown.meta));
}

console.log('\n[10] 经验里的「优先」不能导致误判社招并剔除');
{
  // 这条路径会**直接剔除**岗位，误伤代价比降分大得多。
  // 用 jobType='实习' 隔离：jobType='全职' 的岗位会被「无校招信号的全职 → 社招」那条兜底收走，
  // 掩盖掉 looksExperienced 的影响。
  const soft = {
    title: '消防工程实习生',
    jobType: '实习',
    company: 'X',
    experience: '1年以上相关经验者优先',
    description: '协助消防设施维护。',
    source: 'shixiseng',
  };
  const hard = { ...soft, experience: '1年以上' };
  console.log(`     软性 → ${classifyJob(soft).category}   硬性 → ${classifyJob(hard).category}`);
  ok('「N 年经验优先」不触发社招判定', classifyJob(soft).category !== 'social', classifyJob(soft).category);
  ok('硬性「N 年经验」仍判社招（没修过头）', classifyJob(hard).category === 'social', classifyJob(hard).category);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
