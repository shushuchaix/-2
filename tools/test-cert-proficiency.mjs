// 证书 + 技能熟练度进打分的测试
import { preScore, preScoreAll, certificateFit, proficiencyBonus } from '../src/match/score.mjs';
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

/* ---------- 画像 A：消防工程，证书齐全，技能分等级 ---------- */
const fire = normalizeProfile({
  major: '消防工程',
  school: '中国民用航空飞行学院',
  degree: '本科',
  targetRoles: ['消防工程师', '安全工程师'],
  certificates: ['注册消防工程师（备考中）', '安全员C证', '英语四级', '计算机二级'],
  skills: [
    { name: '消防工程', level: '熟练' },
    { name: '建筑防火', level: '熟练' },
    { name: '防排烟', level: '熟悉' },
    { name: '安全评价', level: '熟悉' },
    { name: 'AutoCAD', level: '了解' },
  ],
  keywords: ['消防工程', '建筑防火', '防排烟', '安全评价', 'AutoCAD', '应急预案', '火灾自动报警'],
  preferredCities: [],
});

/* ---------- 画像 B：同专业，但没证书 ---------- */
const fireNoCert = normalizeProfile({ ...fire, certificates: [] });

console.log('\n[1] certificateFit 单元');
const jobWithCert = { title: '消防工程师（2027届）', description: '要求持有注册消防工程师证书，负责建筑防火设计。', tags: [] };
const jobNoCert = { title: '安全管理岗', description: '负责现场安全隐患排查。', tags: [] };
const jobWantsMissing = { title: '安全工程师', description: '必须持有中级会计职称。', tags: [] };
ok('岗位提到已有证书 → 6 分', certificateFit(jobWithCert, fire).score === 6, String(certificateFit(jobWithCert, fire).score));
ok('提示语说明「你已有」', /你已有/.test(certificateFit(jobWithCert, fire).note));
ok('岗位没提证书 → 0 分', certificateFit(jobNoCert, fire).score === 0);
ok('岗位要求没有的证书 → 0 分但有提示', certificateFit(jobWantsMissing, fire).score === 0 && /简历中未见/.test(certificateFit(jobWantsMissing, fire).note));
// 行为变更说明：原来「简历没写证书」就整体跳过提示，现在改成照样提示硬性缺口 ——
// 岗位硬性要求某个证而你没有，是最该提醒的情况（投了也白投），与简历里有没有别的证书无关。
ok('简历没有证书时仍提示硬性缺口', /简历中未见/.test(certificateFit(jobWantsMissing, fireNoCert).note), certificateFit(jobWantsMissing, fireNoCert).note);
ok('简历没有证书时不加分', certificateFit(jobWantsMissing, fireNoCert).score === 0);
ok('「优先」不算硬要求', certificateFit({ title: 'X', description: '持有中级会计职称优先', tags: [] }, fire).note === '');

console.log('\n[2] proficiencyBonus 单元');
ok('全熟练 → 4 分', proficiencyBonus({}, { skills: [{ name: 'A', level: '熟练' }, { name: 'B', level: '精通' }] }, ['A', 'B']) === 4);
ok('全了解 → 约 2 分', proficiencyBonus({}, { skills: [{ name: 'A', level: '了解' }, { name: 'B', level: '了解' }] }, ['A', 'B']) === 2,
  String(proficiencyBonus({}, { skills: [{ name: 'A', level: '了解' }, { name: 'B', level: '了解' }] }, ['A', 'B'])));
ok('没有命中技能 → 0 分', proficiencyBonus({}, { skills: [{ name: 'A', level: '熟练' }] }, ['Z']) === 0);
ok('简历没写等级 → 中性', proficiencyBonus({}, { skills: [{ name: 'A' }] }, ['A']) === 2);
{
  const hi = proficiencyBonus({}, { skills: [{ name: 'A', level: '熟练' }] }, ['A']);
  const lo = proficiencyBonus({}, { skills: [{ name: 'A', level: '了解' }] }, ['A']);
  ok('熟练 > 了解', hi > lo, `${hi} vs ${lo}`);
}

console.log('\n[3] preScore 整合（证书与熟练度真的进了总分）');
const j1 = { title: '消防工程师（2027届校园招聘）', company: '某机场集团', city: '成都', skills: [], tags: ['2027届'], description: '负责建筑防火设计与防排烟系统；要求持有注册消防工程师证书，消防工程相关专业本科及以上。' };
const s1 = preScore(j1, fire);
const s1nc = preScore(j1, fireNoCert);
console.log(`     有证书 ${s1.preScore} 分 ${JSON.stringify(s1.breakdown)}`);
console.log(`     无证书 ${s1nc.preScore} 分 ${JSON.stringify(s1nc.breakdown)}`);
ok('分项里出现 cert 与 prof', 'cert' in s1.breakdown && 'prof' in s1.breakdown);
ok('有证书时 cert 分为 6', s1.breakdown.cert === 6, String(s1.breakdown.cert));
ok('有证书比没证书得分高', s1.preScore > s1nc.preScore, `${s1.preScore} vs ${s1nc.preScore}`);
ok('熟练技能带来 prof 加分', s1.breakdown.prof > 0, String(s1.breakdown.prof));
ok('总分不超过 100', s1.preScore <= 100, String(s1.preScore));

console.log('\n[4] gaps 里会提示缺失的证书');
const all = preScoreAll([j1, jobWantsMissing], fire);
const missingCertJob = all.find((j) => j.title === '安全工程师');
ok('缺失证书写进 gaps', (missingCertJob?.gaps || []).some((g) => /中级会计/.test(g)), JSON.stringify(missingCertJob?.gaps));
const certJob = all.find((j) => j.title.includes('消防工程师'));
ok('已有证书写进 reasons', (certJob?.reasons || []).some((r) => /你已有/.test(r)), JSON.stringify(certJob?.reasons));

console.log('\n[5] 回归：没有证书/技能等级字段时不报错、不加分');
{
  const bare = normalizeProfile({ major: '消防工程', targetRoles: ['消防工程师'], keywords: ['消防工程'], preferredCities: [] });
  const s = preScore(j1, bare);
  ok('无 certificates 不崩', typeof s.preScore === 'number');
  ok('无证书时 cert 分为 0', s.breakdown.cert === 0);
  ok('无 skills 时 prof 分为 0', s.breakdown.prof === 0);
}

console.log('\n[6] 回归：其他维度权重没被破坏');
{
  // 只有角色/技能命中的普通岗位，总分应当在合理区间（不应因新增维度而普遍虚高）
  const plain = { title: '消防工程师', company: 'X', city: '成都', skills: [], tags: [], description: '消防工程相关专业。' };
  const s = preScore(plain, fireNoCert);
  console.log(`     普通消防岗（无证书项）${s.preScore} 分 ${JSON.stringify(s.breakdown)}`);
  ok('角色维度仍是 22 分满', s.breakdown.role <= 22);
  ok('技能维度仍是 45 分满', s.breakdown.skill <= 45);
  ok('城市维度仍是 15 分满', s.breakdown.city <= 15);
  ok('元信息维度仍是 18 分满', s.breakdown.meta <= 18);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
