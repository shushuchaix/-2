// 就业网采集端到端：按简历画像自动选校 → 真实抓取
// 用法：node tools/collect-university.mjs [学校] [专业]
import { collect, resolveHosts } from '../src/sources/university.mjs';

const school = process.argv[2] || '北京邮电大学';
const major = process.argv[3] || '计算机科学与技术';
const profile = { school, major };

/** 按专业选检索词，模拟真实流水线里 buildTitleKeywords 的产出 */
function keywordsFor(m) {
  if (/消防|安全工程|安全管理|应急|EHS/i.test(m)) return ['消防工程师', '消防安全', '消防设计'];
  if (/会计|财务|审计/.test(m)) return ['会计', '财务', '审计'];
  if (/金融|经济|投资|证券/.test(m)) return ['金融', '投资', '证券'];
  if (/计算机|软件|信息|电子/.test(m)) return ['Java', '后端开发', '软件开发'];
  return ['管理培训生', '市场营销', '人力资源'];
}

const keywords = keywordsFor(major);
console.log(`简历画像：学校=${school} 专业=${major}`);
console.log(`检索词：${keywords.join(' / ')}\n`);

const hosts = await resolveHosts(profile, { maxHosts: 4, log: (m) => console.log(m) });
console.log(`\n选定就业网（${hosts.length}）：`);
for (const h of hosts) console.log(`  - ${h.name}  ${h.host}  [${h.kind}]`);

const t0 = Date.now();
const r = await collect({
  keywords,
  profile,
  maxHosts: 4,
  maxPerKeyword: 10,
  maxDetail: 10,
  delayMs: 500,
  log: (m) => console.log(`  ${m}`),
});

console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`岗位 ${r.jobs.length} 条，错误 ${r.errors.length} 条`);
const byUni = {};
for (const j of r.jobs) byUni[j.extra.university] = (byUni[j.extra.university] || 0) + 1;
console.log(`来源分布：${Object.entries(byUni).map(([k, v]) => `${k}×${v}`).join('，') || '（无）'}`);
for (const j of r.jobs.slice(0, 14)) {
  console.log(`  · [${j.extra.university}] ${String(j.title).slice(0, 40)}  ${j.city || ''}  ${j.salary || ''}`);
}
for (const e of r.errors.slice(0, 5)) console.log(`  ! ${e}`);

