// 牛客校招源验证 + 届别分类器验证
import * as nowcoder from '../src/sources/nowcoder.mjs';
import * as zhaopin from '../src/sources/zhaopin.mjs';
import * as shixiseng from '../src/sources/shixiseng.mjs';
import { classifyJob, matchTargetYear, filterByTargetYear, extractGraduationYears } from '../src/match/campus.mjs';

console.log('='.repeat(72));
console.log('  一、届别识别单元校验');
console.log('='.repeat(72));
const cases = [
  ['2027届校园招聘', [2027]],
  ['【华为云27年秋招】软件开发工程师', []],
  ['27届校招-解决方案', [2027]],
  ['面向2026届及2027届毕业生', [2026, 2027]],
  ['2027年毕业的应届生', [2027]],
  ['2025届毕业生春季校园招聘', [2025]],
  ['参与2024年北京冬奥会项目开发', []],
  ['要求3年以上Java开发经验', []],
  ['2027暑期实习', [2027]],
  ['毕业不限', []],
];
let pass = 0;
for (const [text, want] of cases) {
  const got = extractGraduationYears(text);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  console.log(`  ${ok ? '✅' : '❌'} "${text}" → [${got.join(',')}]${ok ? '' : `  期望 [${want.join(',')}]`}`);
}
console.log(`  小计：${pass}/${cases.length}`);

console.log('\n' + '='.repeat(72));
console.log('  二、牛客校招源：真实数据与推断字段的核对');
console.log('='.repeat(72));
const r = await nowcoder.fetchCampusJobs();
console.log(`  抓到 ${r.jobs.length} 个岗位（原始 ${r.raw}）`);

const byYear = {};
r.jobs.forEach((j) => {
  const y = j.extra.graduationYear || '(空)';
  byYear[y] = (byYear[y] || 0) + 1;
});
console.log('  graduationYear 分布:', JSON.stringify(byYear));

console.log('\n  --- 学历编码核对（eduLevel vs JD 原文）---');
for (const j of r.jobs.slice(0, 6)) {
  const reqText = (j.description.match(/学历[^。\n]{0,40}|本科|硕士|博士|大专/g) || []).slice(0, 3).join(' ');
  console.log(`    eduLevel=${String(j.extra.eduLevelCode).padStart(5)} → 映射为「${j.education || '(空)'}」 | JD 提到: ${reqText || '(未提及)'}`);
}

console.log('\n  --- 薪资/公司/城市/投递窗口核对 ---');
r.jobs.slice(0, 5).forEach((j) => {
  console.log(`    ${String(j.title).slice(0, 24)}`);
  console.log(`      公司=${j.company || '(未取到)'} | 城市=${j.city || '-'} | 薪资=${j.salary || '(空)'}`);
  console.log(`      届别=${j.extra.graduationYear} | 投递=${j.extra.deliverBegin}~${j.extra.deliverEnd} | 技能=${j.skills.slice(0, 5).join('/') || '(空)'}`);
  console.log(`      链接=${j.url}`);
});

console.log('\n  --- 详情页 URL 是否有效 ---');
if (r.jobs[0]) {
  try {
    const res = await fetch(r.jobs[0].url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const t = await res.text();
    const title = (t.match(/<title>([^<]*)<\/title>/) || [, ''])[1];
    console.log(`    HTTP ${res.status} len=${t.length} title=${title.slice(0, 50)}`);
    console.log(`    ${res.status === 200 && t.length > 20000 ? '✅ 详情页可达' : '⚠️ 详情页可能无效，需换 URL 格式'}`);
  } catch (e) {
    console.log(`    ❌ ${e.message}`);
  }
}

console.log('\n' + '='.repeat(72));
console.log('  三、校招日程');
console.log('='.repeat(72));
const s = await nowcoder.fetchSchedule();
console.log(`  抓到 ${s.items.length} 家公司`);
s.items.slice(0, 6).forEach((it) => {
  console.log(`    [${it.extra.batch}] ${it.company} | 网申 ${it.extra.wangshenBegin} ~ ${it.extra.wangshenEnd} | 城市 ${it.city}`);
});
const batchSet = [...new Set(s.items.map((i) => i.extra.batch))];
console.log('  批次取值:', JSON.stringify(batchSet));

console.log('\n' + '='.repeat(72));
console.log('  四、分类器在真实岗位上的表现');
console.log('='.repeat(72));

const samples = [...r.jobs];
try {
  const z = await zhaopin.fetchListPage('Java开发', 1, { city: '北京' });
  samples.push(...z.jobs.slice(0, 20));
} catch (e) { console.log('  智联取样失败:', e.message); }
try {
  const sx = await shixiseng.fetchListPage('Java开发', 1, { city: '北京' });
  samples.push(...sx.jobs.slice(0, 15));
} catch (e) { console.log('  实习僧取样失败:', e.message); }

const byCat = {};
const bySource = {};
for (const j of samples) {
  const c = classifyJob(j);
  byCat[c.category] = (byCat[c.category] || 0) + 1;
  const key = `${j.source}/${c.category}`;
  bySource[key] = (bySource[key] || 0) + 1;
}
console.log(`  样本 ${samples.length} 条`);
console.log('  分类分布:', JSON.stringify(byCat));
console.log('  按来源:', JSON.stringify(bySource));

console.log('\n  --- 目标 2027 届过滤结果 ---');
const f = filterByTargetYear(samples, 2027, { includeInternship: true, strict: true });
console.log(`  保留 ${f.stats.kept} / ${samples.length}，剔除 ${f.stats.dropped}`);
console.log('  剔除原因:', JSON.stringify(f.stats.reasons));
console.log('\n  保留样例:');
f.jobs.slice(0, 10).forEach((j) => {
  console.log(`    [${j.yearMatch.category}] ${String(j.title).slice(0, 30)} | ${j.yearMatch.reason}`);
});
console.log('\n  剔除样例:');
f.dropped.slice(0, 8).forEach((d) => {
  console.log(`    ${String(d.job.title).slice(0, 30)} | ${d.reason}`);
});

console.log('\n' + '='.repeat(72));
console.log('  五、回归：假阳性场景');
console.log('='.repeat(72));
{
  // 公众号文章的推广页脚常提到各种届别，不能当成岗位的届别依据
  const fake = {
    id: 'x',
    source: 'wechat',
    title: 'Java后端开发工程师',
    company: '北京通成网联科技有限公司',
    jobType: '社招',
    experience: '2年及以上',
    skills: ['Java'],
    tags: [],
    summary: '2年以上Java经验，熟悉Spring Boot、MyBatis-Plus、MySQL、Redis',
    description: '【公告原文摘录】诚招Java后端开发工程师1人，有相关工作经验者优先…页脚：加入2027届央国企求职信息群，2028届实习信息群',
    extra: { account: '人才树', fromArticle: true },
  };
  const c = classifyJob(fake);
  const m = matchTargetYear(fake, 2027, { includeInternship: false, strict: true });
  const ok = c.category === 'social' && !m.keep;
  console.log(`  ${ok ? '✅' : '❌'} 社招岗位因页脚提到「2027届」而误判为校招 → 实际判定为 ${c.category}，${m.keep ? '被保留（错误）' : '已剔除：' + m.reason}`);

  // 真正的校招岗不应被误伤
  const good = {
    id: 'y',
    source: 'zhaopin',
    title: '软件开发工程师（面向2027届毕业生）',
    jobType: '校园',
    experience: '经验不限',
    skills: ['Java'],
    tags: [],
    summary: '面向2027届毕业生',
    description: '校园招聘，2027届毕业生优先',
    extra: { workType: '校园' },
  };
  const c2 = classifyJob(good);
  const m2 = matchTargetYear(good, 2027, { includeInternship: false, strict: true });
  const ok2 = c2.category === 'campus' && m2.keep;
  console.log(`  ${ok2 ? '✅' : '❌'} 真实校招岗正常保留 → ${c2.category}，${m2.reason}`);
}

process.exit(0);
