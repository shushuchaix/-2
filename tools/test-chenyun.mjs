// 晨云就业系统适配器测试 + 实采
import { probeHost, parseListFragment, parseDetail, collect, CHENYUN_HOSTS } from '../src/sources/chenyun.mjs';

const HOST = 'https://jy.cafuc.edu.cn';
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

console.log('\n[1] 站点探测');
// 先做一次连通性判断：网络层被拒（ECONNRESET / TLS 中断）时**跳过**而不是判失败。
// 理由：站点不可达是环境问题（实测短时间密集探测会触发该校 IP 频控），
// 把它报成「适配器坏了」会误导排查方向。真正该失败的是「连得上但解析不出来」。
let siteReachable = true;
try {
  const r = await fetch('https://jy.cafuc.edu.cn/', { signal: AbortSignal.timeout(12000) });
  siteReachable = r.status < 500;
} catch {
  siteReachable = false;
}
if (!siteReachable) {
  console.log('  ◐ 站点网络层不可达（多为 IP 频控），跳过抓取断言');
  console.log('     代码逻辑未变，等站点恢复后重跑即可：node tools/test-chenyun.mjs');
  console.log('\n⚠️  跳过：站点不可达（非代码问题）\n');
  process.exit(0);
}
ok('probeHost 判定中飞院可用', (await probeHost(HOST)) === true);
ok('probeHost 拒绝非晨云站点', (await probeHost('https://job.xidian.edu.cn')) === false);
ok(
  'probeHost 拒绝不存在站点',
  (await probeHost('https://jy.this-does-not-exist-xyz.edu.cn')) === false,
);

console.log('\n[2] 真实采集');
const t0 = Date.now();
const r = await collect({
  keywords: ['消防工程师', '消防安全', '安全工程', 'EHS', '2027届'],
  hosts: [{ name: '中国民用航空飞行学院', host: HOST, kind: 'aviation' }],
  maxHosts: 1,
  maxPages: 6,
  maxDetail: 10,
  delayMs: 700,
  log: (m) => console.log(`   ${m}`),
});
console.log(`   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

ok('采到岗位', r.jobs.length > 0, `得到 ${r.jobs.length} 条`);
ok('无错误', r.errors.length === 0, r.errors.slice(0, 3).join(' | '));
// 岗位总数随站点变化，断言「翻页正常终止」而不是具体条数：
// 空页应当让循环提前 break，所以实际翻页数要小于 maxPages
ok('翻页在空页处终止', r.stats.pages < 6, `翻了 ${r.stats.pages} 页（maxPages=6）`);
ok('列表拿到足量岗位', r.stats.listed >= 15, `列表 ${r.stats.listed} 条`);
ok('每条都有标题', r.jobs.every((j) => j.title && j.title.length >= 2));
ok('每条都有公司', r.jobs.every((j) => j.company), r.jobs.filter((j) => !j.company).map((j) => j.title).join(','));
ok('公司名不含「职位要求」这类小标题', r.jobs.every((j) => !/职位要求|职位简介|单位介绍|联系方式/.test(j.company)));
ok('标题不含「发布于」残留', r.jobs.every((j) => !/发布于/.test(j.title)));
ok('每条都有可点链接', r.jobs.every((j) => /^https?:\/\//.test(j.url)));
ok('标记为校招', r.jobs.every((j) => j.isCampus === true));
ok('来源名带学校', r.jobs.every((j) => j.sourceName.includes('中国民用航空飞行学院')));
ok('id 唯一', new Set(r.jobs.map((j) => j.id)).size === r.jobs.length);
ok('解析出截止日期', r.jobs.filter((j) => j.extra.expire).length >= r.jobs.length * 0.8, `${r.jobs.filter((j) => j.extra.expire).length}/${r.jobs.length}`);
ok('解析出学历', r.jobs.filter((j) => j.education).length >= r.jobs.length * 0.8, `${r.jobs.filter((j) => j.education).length}/${r.jobs.length}`);

console.log('\n[3] 字段解析实况（前 10 条）');
for (const j of r.jobs.slice(0, 10)) {
  console.log(`  · ${j.title}`);
  console.log(`      公司=${j.company}  城市=${j.city || '-'}  学历=${j.education || '-'}  类型=${j.jobType || '-'}`);
  console.log(`      专业=${j.extra.major || '-'}  截止=${j.extra.expire || '-'}  ${j.url.slice(0, 78)}`);
}

const withMajor = r.jobs.filter((j) => j.extra.major && j.extra.major !== '专业不限').length;
const withExpire = r.jobs.filter((j) => j.extra.expire).length;
console.log(`\n  字段填充率：专业 ${withMajor}/${r.jobs.length}，截止日期 ${withExpire}/${r.jobs.length}`);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
