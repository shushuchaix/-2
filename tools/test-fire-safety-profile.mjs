// 消防工程画像：验证词表、岗位族推导、选校、离线提取是否都对得上
// 用法：node tools/test-fire-safety-profile.mjs
import { extractTechTerms } from '../src/util/skills.mjs';
import {
  normalizeProfile,
  deriveRoleKeywords,
  buildTitleKeywords,
} from '../src/resume/profile.mjs';
import { analyzeResumeOffline } from '../src/resume/offline.mjs';
import { resolveHosts, preferredKinds } from '../src/sources/university.mjs';
import { preScore, isCrossDomainSecurity } from '../src/match/score.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

/* 一份典型的「中国民用航空飞行学院 · 消防工程」本科生简历 */
const RESUME = `
李航  男  |  138-0000-0000  |  lihang@example.com
中国民用航空飞行学院  消防工程  本科  2023.09-2027.06
主修课程：消防工程学、建筑防火设计、火灾自动报警系统、自动喷水灭火系统、
防排烟工程、安全系统工程、安全管理学、燃烧学、危险化学品安全技术
技能：AutoCAD、Revit、BIM、广联达、注册消防工程师（备考中）、安全评价、应急预案编制
证书：安全员C证、英语四级、计算机二级
实习：某机场消防护卫部 消防安全实习生 —— 参与消防设施巡检与隐患排查
项目：航站楼防排烟系统设计课程设计；校园消防安全隐患排查与整改方案
求职意向：消防工程师 / 安全工程师
`;

console.log('\n[1] 技能词表能否抽出消防类词');
const skills = extractTechTerms(RESUME);
ok('抽出「消防工程」', skills.includes('消防工程'), skills.join(','));
ok('抽出「建筑防火」', skills.includes('建筑防火'));
ok('抽出「火灾自动报警」', skills.includes('火灾自动报警'));
ok('抽出「自动喷水灭火」', skills.includes('自动喷水灭火'));
ok('抽出「防排烟」', skills.includes('防排烟'));
ok('抽出「安全评价」', skills.includes('安全评价'));
ok('抽出「应急预案」', skills.includes('应急预案'));
ok('抽出「危险化学品」', skills.includes('危险化学品'));
ok('抽出「BIM / Revit / 广联达」', ['BIM', 'Revit', '广联达'].every((s) => skills.includes(s)));
ok('抽出「民用航空」/「机场」', skills.includes('民用航空') && skills.includes('机场'));
ok('技能命中数 ≥ 12', skills.length >= 12, `命中 ${skills.length} 个：${skills.join(',')}`);

console.log('\n[2] 岗位族推导（消防工程不该被推成 Java/信息安全）');
const profile = normalizeProfile({
  name: '李航',
  school: '中国民用航空飞行学院',
  degree: '本科',
  major: '消防工程',
  graduationYear: '2027',
  targetRoles: ['消防工程师', '安全工程师'],
  skills: skills.map((name) => ({ name, level: '熟悉' })),
  preferredCities: [],
  keywords: skills,
});
const roles = deriveRoleKeywords(profile, { max: 40 });
ok('推导出「消防工程师」', roles.includes('消防工程师'), roles.slice(0, 12).join(','));
ok('推导出「安全工程师」', roles.includes('安全工程师'));
ok('推导出「EHS工程师」', roles.includes('EHS工程师'));
ok('没有推导出任何 Java/后端 岗', !roles.some((r) => /Java|后端|前端|算法|测试开发|运维/.test(r)), roles.join(','));
ok('没有把 IT 安全工程师当成主方向', roles[0] !== '信息安全工程师', `top1=${roles[0]}`);

console.log('\n[3] 检索词');
const titles = buildTitleKeywords(profile, { max: 8 });
ok('检索词含消防类词', titles.some((t) => /消防|安全/.test(t)), titles.join('、'));
ok('检索词不含 Java', !titles.some((t) => /Java|后端/.test(t)), titles.join('、'));
console.log(`     检索词：${titles.join('、')}`);

console.log('\n[4] 离线提取（不调 LLM 时的兜底）');
const offline = analyzeResumeOffline(RESUME);
ok('离线识别专业为消防工程', /消防/.test(offline.major || ''), `major=${offline.major}`);
ok('离线识别学校', /民用航空飞行学院/.test(offline.school || ''), `school=${offline.school}`);
ok('离线识别届别 2027', offline.graduationYear === '2027', `year=${offline.graduationYear}`);
const offlineRoles = (offline.targetRoles || []).join(',');
ok(
  '离线目标岗位是消防/安全方向，不是信息安全',
  /消防|安全/.test(offlineRoles) && !/信息安全|网络安全/.test(offlineRoles),
  `targetRoles=${offlineRoles}`,
);

console.log('\n[5] 高校选校');
ok('专业类型偏好含 it(理工)', preferredKinds({ major: '消防工程' }).includes('it'), JSON.stringify(preferredKinds({ major: '消防工程' })));
{
  const hosts = await resolveHosts({ school: '中国民用航空飞行学院', major: '消防工程' }, { maxHosts: 4, log: () => {} });
  ok('选出 4 所就业网', hosts.length === 4, hosts.map((h) => h.name).join('、'));
  ok('不崩且都是已收录院校', hosts.every((h) => h.name));
  console.log(`     选中：${hosts.map((h) => `${h.name}[${h.kind}]`).join('、')}`);
}

console.log('\n[6] 打分：消防岗应得高分，Java 岗应得低分');
const fireJob = {
  title: '消防安全工程师（2027届校园招聘）',
  company: '某机场集团',
  city: '成都',
  description: '负责机场消防设施巡查、建筑防火设计审核、应急预案编制；要求消防工程、安全工程相关专业本科及以上；熟悉火灾自动报警系统、防排烟系统。',
  skills: ['消防工程', '安全评价', '应急预案'],
  tags: ['2027届'],
  source: 'test',
};
const javaJob = {
  title: 'Java后端开发工程师（2027届）',
  company: '某科技公司',
  city: '成都',
  description: '负责微服务后端开发，要求熟悉 Spring Boot、MySQL、Redis。',
  skills: ['Java', 'Spring Boot', 'MySQL'],
  tags: ['2027届'],
  source: 'test',
};
const fs1 = preScore(fireJob, profile);
const js1 = preScore(javaJob, profile);
console.log(`     消防岗 ${fs1.preScore} 分（方向命中：${fs1.roleHit || '无'}） ｜ Java岗 ${js1.preScore} 分（方向命中：${js1.roleHit || '无'}）`);
console.log(`     消防岗命中关键词：${(fs1.matched || []).join('、') || '无'}`);
console.log(`     消防岗分项：${JSON.stringify(fs1.breakdown)}`);
ok('消防岗得分高于 Java 岗', fs1.preScore > js1.preScore, `${fs1.preScore} vs ${js1.preScore}`);
ok('消防岗得分 ≥ 50', fs1.preScore >= 50, String(fs1.preScore));
ok('消防岗方向命中消防/安全方向', /消防|安全|EHS/i.test(fs1.roleHit || ''), fs1.roleHit || '(无)');
ok('消防岗命中多个消防类关键词', (fs1.matched || []).length >= 2, (fs1.matched || []).join('、'));

console.log('\n[7] 「安全工程师」同名陷阱：消防 vs 网络安全');
{
  const p2 = { major: '消防工程', keywords: ['消防工程', '安全工程'] };
  const cross = (t) => isCrossDomainSecurity({ title: t }, p2);
  ok('网络安全工程师 判为跨方向', cross('网络安全工程师（27届校招）'), 'false');
  ok('【前缀】网络安全工程师 判为跨方向', cross('【华橙网络】2027届网络安全工程师'));
  ok('安全工程师（安全检测）不是跨方向', !cross('安全工程师（安全检测）-27届校招'));
  ok('消防工程师 不是跨方向', !cross('消防工程师（2027届校招）'));
  ok('信息安全工程师（消防方向）不算跨方向', !cross('信息安全工程师（消防方向）'));
  // 关键回归：'网络安全工程师'.includes('安全工程') 为真，早期版本因此把它当成了消防岗
  ok(
    '回归：网络安全工程师 不被当成含「安全工程」特征',
    cross('网络安全工程师'),
  );
}
{
  // 反方向：IT 安全简历不该被推成消防岗
  const itProfile = normalizeProfile({
    major: '信息安全',
    targetRoles: ['信息安全工程师'],
    skills: [{ name: '网络安全' }, { name: '渗透测试' }],
    keywords: ['网络安全', '渗透测试', '信息安全'],
    preferredCities: [],
  });
  const itRoles = deriveRoleKeywords(itProfile, { max: 20 });
  ok('IT 安全简历不推导出消防岗', !itRoles.some((r) => /消防|防排烟|灭火/.test(r)), itRoles.join('、'));
}
{
  // 跨方向岗位：方向分被撤掉、歧义技能词不计分
  const crossJob = {
    title: '网络安全工程师（27届校招）',
    company: 'X',
    city: '北京',
    description: '负责渗透测试与等保合规，要求信息安全、计算机相关专业。',
    skills: [],
    tags: ['2027届'],
    source: 'test',
  };
  const r = preScore(crossJob, profile);
  console.log(`     网安岗 ${r.preScore} 分，方向命中：${r.roleHit || '(无)'}`);
  ok('网安岗方向分被撤掉', r.breakdown.role === 0 && !r.roleHit, JSON.stringify(r.breakdown));
  ok('网安岗总分低于消防岗', r.preScore < fs1.preScore, `${r.preScore} vs ${fs1.preScore}`);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
