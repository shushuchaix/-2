// 三项过滤/加权需求：
//   ① 证书分档（英语四级 ≠ 注册消防工程师）
//   ② 只实习不转正 → 排除；可转正实习 → 保留
//   ③ 学历下限 → 本科求职者不看专科岗
import { classifyJob, matchTargetYear, filterByTargetYear } from '../src/match/campus.mjs';
import { filterByDegree, certificateFit, isFresher } from '../src/match/score.mjs';
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

/* ============================================================
   ① 证书分档
   ============================================================ */
console.log('\n[1] 证书分档：英语四级不应等同注册消防工程师');
const p4 = normalizeProfile({
  major: '消防工程',
  targetRoles: ['消防工程师'],
  keywords: ['消防工程'],
  certificates: ['英语四级', '计算机二级'],
  preferredCities: [],
});
const pGate = normalizeProfile({ ...p4, certificates: ['注册消防工程师', '英语四级'] });

ok('有英语四级 → 仅 +2（基础加分项）', certificateFit({ title: 'X', description: '要求英语四级。', tags: [] }, p4).score === 2,
  String(certificateFit({ title: 'X', description: '要求英语四级。', tags: [] }, p4).score));
ok('有注册消防工程师 → +6（准入类）', certificateFit({ title: 'Y', description: '要求注册消防工程师。', tags: [] }, pGate).score === 6,
  String(certificateFit({ title: 'Y', description: '要求注册消防工程师。', tags: [] }, pGate).score));
{
  // 同一岗位同时提到两类证书时，按准入类算，不被基础项抢走
  const both = { title: 'Z', description: '要求注册消防工程师，英语四级。', tags: [] };
  ok('同时提到两类时按准入类计分', certificateFit(both, pGate).score === 6, String(certificateFit(both, pGate).score));
}
{
  // 没有的证书：英语四级缺失也不该被写成硬性差距（除非 JD 明写"必须"）
  const soft = { title: 'A', description: '有英语四级者优先。', tags: [] };
  const hard = { title: 'B', description: '必须通过英语四级。', tags: [] };
  ok('「四级优先」不提示差距', certificateFit(soft, normalizeProfile({ ...p4, certificates: [] })).note === '');
  ok('「必须四级」才提示差距', /简历中未见/.test(certificateFit(hard, normalizeProfile({ ...p4, certificates: [] })).note));
}

/* ============================================================
   ② 只实习不转正 vs 可转正实习
   ============================================================ */
console.log('\n[2] 实习：只实习不转正 → 排除；可转正 → 保留');
const internOnly = {
  title: '消防工程实习生',
  jobType: '实习',
  company: 'X',
  description: '协助完成消防设施巡检，实习期 3 个月。',
  source: 'shixiseng',
};
const internConvertible = {
  title: '消防工程实习生（可转正）',
  jobType: '实习',
  company: 'Y',
  description: '协助消防设计；表现优秀可转正，转正后享受正式员工待遇。',
  source: 'shixiseng',
};
ok('纯实习被识别为实习岗', classifyJob(internOnly).isIntern === true);
ok('纯实习无转正标记', classifyJob(internOnly).convertible === false);
ok('可转正实习带转正标记', classifyJob(internConvertible).convertible === true);
ok('可转正实习信号里有「可转正」', (classifyJob(internConvertible).signals || []).includes('可转正'));

console.log('\n[2b] 转正判定的否定形式（关键回归）');
// `/转正/` 会命中「不转正」「无转正机会」，而那恰恰是要排除的那类 —— 必须识别否定
for (const [text, want, note] of [
  ['实习生（表现优秀可转正）', true, '肯定'],
  ['实习期满无转正机会', false, '无转正'],
  ['本岗位不转正', false, '不转正'],
  ['仅实习，不提供转正', false, '不提供转正'],
  ['实习表现优异者可留用', true, '留用'],
  ['转正后月薪 8K', true, '转正后（隐含可转正）'],
]) {
  const info = classifyJob({ title: text, jobType: '实习', description: text, source: 'shixiseng' });
  ok(`${note}：「${text.slice(0, 16)}」→ ${want ? '可转正' : '不可转正'}`, info.convertible === want, String(info.convertible));
}

{
  const r1 = matchTargetYear(internOnly, '2027', { includeInternship: false, keepConvertibleInternship: true });
  const r2 = matchTargetYear(internConvertible, '2027', { includeInternship: false, keepConvertibleInternship: true });
  console.log(`     纯实习    → keep=${r1.keep}  ${r1.reason}`);
  console.log(`     可转正实习 → keep=${r2.keep}  ${r2.reason}`);
  ok('纯实习被排除', r1.keep === false);
  ok('排除理由说明是「只实习不转正」', /只实习、不转正/.test(r1.reason), r1.reason);
  ok('可转正实习被保留', r2.keep === true, r2.reason);
}
{
  // 关掉这个开关 → 回到「实习一律排除」
  const r = matchTargetYear(internConvertible, '2027', { includeInternship: false, keepConvertibleInternship: false });
  ok('开关关闭时实习一律排除', r.keep === false, r.reason);
}
{
  // 打开「含实习」→ 两种都保留（开关语义不变）
  const f = filterByTargetYear([internOnly, internConvertible], '2027', { includeInternship: true });
  ok('含实习时两种都保留', f.jobs.length === 2, String(f.jobs.length));
}
{
  const f = filterByTargetYear([internOnly, internConvertible], '2027', {
    includeInternship: false,
    keepConvertibleInternship: true,
  });
  ok('排除设置下只留下可转正那条', f.jobs.length === 1 && /可转正/.test(f.jobs[0].title), f.jobs.map((j) => j.title).join(','));
}

/* ============================================================
   ③ 学历下限
   ============================================================ */
console.log('\n[3] 学历下限：本科不看专科岗');
const bachelor = normalizeProfile({ degree: '本科', major: '消防工程', targetRoles: ['消防工程师'], keywords: ['消防工程'], graduationYear: '2027', preferredCities: [] });
const jobs = [
  { title: 'A-专科岗', education: '大专及以上', company: 'x' },
  { title: 'B-专科岗', education: '专科', company: 'x' },
  { title: 'C-中专岗', education: '中专及以上', company: 'x' },
  { title: 'D-本科岗', education: '本科及以上', company: 'x' },
  { title: 'E-硕士岗', education: '硕士及以上', company: 'x' },
  { title: 'F-不限', education: '学历不限', company: 'x' },
  { title: 'G-未标注', education: '', company: 'x' },
];
const d = filterByDegree(jobs, bachelor);
const kept = d.jobs.map((j) => j.title);
const dropped = d.dropped.map((x) => x.job.title);
console.log(`     保留：${kept.join('、')}`);
console.log(`     剔除：${dropped.join('、')}`);

ok('大专及以上 → 剔除', dropped.includes('A-专科岗'));
ok('专科 → 剔除', dropped.includes('B-专科岗'));
ok('中专及以上 → 剔除', dropped.includes('C-中专岗'));
ok('本科及以上 → 保留', kept.includes('D-本科岗'));
ok('硕士及以上 → 保留（上限问题交给打分提示）', kept.includes('E-硕士岗'));
ok('学历不限 → 保留', kept.includes('F-不限'));
ok('未标注 → 保留', kept.includes('G-未标注'));
ok('floor 为本科', d.floor === 3, String(d.floor));

console.log('\n[4] 学历下限：边界与配置');
{
  const master = normalizeProfile({ ...bachelor, degree: '硕士' });
  const d2 = filterByDegree(jobs, master);
  ok('硕士求职者会剔除本科岗', d2.dropped.some((x) => x.job.title === 'D-本科岗'));
  ok('硕士求职者保留硕士岗', d2.jobs.some((j) => j.title === 'E-硕士岗'));
}
{
  const d3 = filterByDegree(jobs, bachelor, { minDegree: '大专' });
  ok('手动指定 minDegree=大专 → 不剔除专科岗', !d3.dropped.some((x) => x.job.title === 'A-专科岗'));
}
{
  const noDegree = normalizeProfile({ major: '消防工程', targetRoles: ['消防工程师'], keywords: ['消防工程'], preferredCities: [] });
  const d4 = filterByDegree(jobs, noDegree);
  ok('画像没有学历时不做过滤', d4.jobs.length === jobs.length && d4.floor === null, `floor=${d4.floor}`);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
