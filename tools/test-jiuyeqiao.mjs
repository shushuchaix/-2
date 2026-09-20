// 就业桥适配器测试 + 实采
import { probeHost, parseListFragment, parseDetail, collect } from '../src/sources/jiuyeqiao.mjs';

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

console.log('\n[1] 探测');
ok('probeHost 判定就业桥可用', (await probeHost()) === true);

console.log('\n[2] 真实采集（消防工程方向）');
const t0 = Date.now();
const r = await collect({
  keywords: ['消防', '安全工程师', '应急救援'],
  maxPerKeyword: 10,
  maxPages: 1,
  maxDetail: 8,
  delayMs: 600,
  log: (m) => console.log(`   ${m}`),
});
console.log(`   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

ok('采到岗位', r.jobs.length > 0, `得到 ${r.jobs.length} 条`);
ok('列表数 >= 20', r.stats.listed >= 20, `列表 ${r.stats.listed} 条`);
ok('每条都有标题', r.jobs.every((j) => j.title && j.title.length >= 2));
ok('每条都有公司', r.jobs.every((j) => j.company), r.jobs.filter((j) => !j.company).map((j) => j.title).join(','));
ok('标题不残留「招聘信息」字样', r.jobs.every((j) => !/招聘信息_|_就业桥/.test(j.title)));
ok('链接可点', r.jobs.every((j) => /^https?:\/\/job\.jiuyeqiao\.cn\/zhiwei\/\d+\.html$/.test(j.url)));
ok('id 唯一', new Set(r.jobs.map((j) => j.id)).size === r.jobs.length);
ok('标记为校招', r.jobs.every((j) => j.isCampus === true));
ok('来源名正确', r.jobs.every((j) => j.sourceName === '就业桥'));
ok('解析出职位描述', r.jobs.filter((j) => (j.description || '').length > 60).length >= r.jobs.length * 0.6,
  `${r.jobs.filter((j) => (j.description || '').length > 60).length}/${r.jobs.length}`);

console.log('\n[3] 实采结果');
for (const j of r.jobs.slice(0, 8)) {
  console.log(`  · ${j.title}`);
  console.log(`      ${j.company}  城市=${j.city || '-'}  薪资=${j.salary || '-'}  学历=${j.education || '-'}`);
  console.log(`      描述 ${(j.description || '').length} 字: ${(j.description || '').slice(0, 60).replace(/\n/g, ' ')}`);
}

console.log('\n[4] 解析器单元测试（构造样本，不联网）');
const sampleList = `<ul class="ul-main-list"><li>
  <a href="https://job.jiuyeqiao.cn/zhiwei/999.html">
    <div class="list-company fr">某某消防维保技术有限公司</div>
    <div class="list-job">消防设施操作员</div>
    <div class="job-info"><div class="left-content">
      <div class="salary"><p>6K-9K/月</p></div>
      <div class="list-condition">成都市 | 全职 | 不限 | 大专 | 招2人</div>
      <div class="list-com-type">民营企业</div>
      <div class="source">就业桥</div>
    </div>
  </a></li></ul>`;
const parsed = parseListFragment(sampleList);
ok('样本列表解析出 1 条', parsed.length === 1, String(parsed.length));
ok('岗位名正确', parsed[0]?.title === '消防设施操作员', parsed[0]?.title);
ok('公司名正确（class 带额外类名也能取到）', parsed[0]?.company === '某某消防维保技术有限公司', parsed[0]?.company);
ok('薪资正确', parsed[0]?.salary === '6K-9K/月', parsed[0]?.salary);
ok('城市从 list-condition 取到并规范化', parsed[0]?.city === '成都', parsed[0]?.city);
ok('学历从 list-condition 取到', parsed[0]?.education === '大专', parsed[0]?.education);
ok('招聘人数从 list-condition 取到', parsed[0]?.headcount === '2', parsed[0]?.headcount);
// 回归：页面侧栏也有 .list-addr，但岗位城市不该从它取（否则会抓到「人事部门」这类噪声）
const noisy = `<ul class="ul-main-list"><li>
  <a href="https://job.jiuyeqiao.cn/zhiwei/1000.html">
    <div class="list-company">某公司</div><div class="list-job">消防维保</div>
    <div class="list-addr">人事部门</div>
    <div class="list-condition">沈阳市 | 全职 | 不限 | 大专 | 招20人</div>
  </a></li></ul>`;
const p2 = parseListFragment(noisy);
ok('城市不被 .list-addr 的噪声污染', p2[0]?.city === '沈阳', p2[0]?.city);
ok('薪资为空时不硬塞数字', p2[0]?.salary === '', JSON.stringify(p2[0]?.salary));

const sampleDetail = `<html><head><title>消防设施操作员招聘信息_某某消防维保技术有限公司_就业桥</title>
<meta name="description" content="【消防设施操作员招聘】就业桥提供某某公司招聘消防设施操作员。（测试）"></head>
<body><div class="detail ">岗位职责：负责消防设施日常巡检与维护保养，参与消防演练。
任职要求：消防工程、安全工程相关专业，持有消防设施操作员证优先。
工作地点：四川省成都市武侯区
本科及以上</div></body></html>`;
const d2 = parseDetail(sampleDetail);
ok('详情标题剥离「招聘信息」', d2.title === '消防设施操作员', d2.title);
ok('详情公司从标题后缀取到', d2.company === '某某消防维保技术有限公司', d2.company);
ok('详情正文含岗位职责', /岗位职责/.test(d2.description));
ok('详情解析出城市', /成都/.test(d2.city), d2.city);
ok('详情解析出学历', d2.education === '本科', d2.education);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
