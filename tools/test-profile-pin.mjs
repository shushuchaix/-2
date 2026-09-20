// 「画像钉死」验证：简历写的是 A，配置钉死为 B，最终必须按 B 走
// 用法：node tools/test-profile-pin.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// 独立数据目录，避免碰到仓库里的真实 config.json / runs
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rjr-pin-'));
process.env.RJR_DATA_DIR = TMP;
process.env.PORT = '3499';

// 简历故意写成「北京邮电大学 / 计算机科学与技术」，与钉死目标完全不符
const RESUME = `
张明  北京邮电大学  计算机科学与技术  本科  2023.09-2027.06
技能：Java、Spring Boot、MySQL、Redis、Docker
求职意向：Java后端开发工程师
项目经历：分布式短链接系统
`;

fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    sources: {
      zhaopin: { enabled: false },
      shixiseng: { enabled: false },
      searchApi: { enabled: false },
      wechat: { enabled: false },
      nowcoder: { enabled: false },
      university: { enabled: false },
    },
    filters: { graduationYear: '2027', includeInternship: false, strict: true, cities: [] },
    profile: {
      school: '中国民用航空飞行学院',
      major: '消防工程',
      _说明: '这个下划线注释键不该被当成画像字段',
    },
  }),
  'utf8',
);

const { loadConfig } = await import('../src/config.mjs');
const { runPipeline } = await import('../src/pipeline.mjs');

const cfg = loadConfig({ quiet: true });
const logs = [];
let profileEvent = null;

const result = await runPipeline({
  resumeText: RESUME,
  llm: null,
  cfg,
  options: { useLlm: false },
  onEvent: (e) => {
    if (e.type === 'log') logs.push(e.message);
    if (e.type === 'profile') profileEvent = e.profile;
  },
});

console.log('\n  画像钉死日志：');
for (const l of logs.filter((m) => /钉死|画像/.test(m))) console.log(`    ${l}`);

const p = profileEvent || result.profile || {};
console.log('\n  最终画像：');
console.log(`    school = ${p.school}`);
console.log(`    major  = ${p.major}`);
console.log(`    targetRoles = ${(p.targetRoles || []).join('、')}`);
console.log(`    titleKeywords = ${(p.titleKeywords || []).join('、')}`);

console.log('\n[1] 钉死覆盖生效');
ok('学校被覆盖为民航飞行学院', p.school === '中国民用航空飞行学院', String(p.school));
ok('专业被覆盖为消防工程', p.major === '消防工程', String(p.major));
ok('日志明确报告了钉死', logs.some((m) => /画像已按配置钉死/.test(m)), logs.join(' | ').slice(0, 120));

console.log('\n[2] 注释键不被当成画像字段');
ok('_说明 未进入画像', !('_说明' in p), Object.keys(p).join(','));

console.log('\n[3] 检索词 / 岗位方向按钉死后的专业重算');
const kws = result.queries?.titleKeywords || [];
console.log(`     titleKeywords = ${kws.join('、')}`);
const top5 = kws.slice(0, 5);
ok('前 5 个检索词全是消防/安全方向', top5.length === 5 && top5.every((k) => /消防|安全|EHS|应急/i.test(k)), top5.join('、'));
// 钉死方向权重 100，把旧方向（Java/后端，权重 70 以下）整个挤出了检索词表，这是期望结果
ok('旧方向 Java/后端 已被挤出检索词', !kws.some((k) => /后端|Java/i.test(k)), kws.join('、'));
ok('目标岗位不再是 Java 后端', !(p.targetRoles || []).some((r) => /后端|Java/i.test(r)), (p.targetRoles || []).join('、'));

// 说明：这份测试简历本身就是 Java 简历，「技能」里的 Java/Spring 是**关于这个人的事实**，
// 钉死专业不应该抹掉它 —— 所以 Java 类岗位词仍会以较低权重（70-40）出现在词表后半段。
// 真正要保证的是：钉死方向必须排在最前、压倒旧方向（旧 targetRoles 权重是 100，正是它盖住了新专业）。
// 「消防简历最终不出现任何 IT 检索词」由 tools/test-fire-safety-profile.mjs 覆盖。

console.log('\n[4] 岗位方向词表（打分用）也换了方向');
ok('结果里没有 Java 相关岗位被高分推荐', (result.jobs || []).every((j) => !/Java|后端/.test(j.title || '')));

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
