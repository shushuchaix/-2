// 毕业生去向种子数据测试
import { DESTINATIONS, destinationFor, destinationQueries, matchesDestination } from '../src/match/destinations.mjs';

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

const FIRE = { school: '中国民用航空飞行学院', major: '消防工程' };

console.log('\n[1] 数据完整性');
ok('至少有 1 条去向档案', DESTINATIONS.length >= 1);
ok('每条都标了出处', DESTINATIONS.every((d) => /^https?:\/\//.test(d.source)));
ok('每条都有单位和行业', DESTINATIONS.every((d) => d.employers.length && d.industries.length));
ok('每条都有补充检索词', DESTINATIONS.every((d) => d.extraQueries.length));

console.log('\n[2] 匹配');
ok('中飞院+消防工程 命中档案', destinationFor(FIRE) !== null);
ok('不存在的学校返回 null', destinationFor({ school: '某某大学', major: '消防工程' }) === null);
ok('同校但专业不符返回 null', destinationFor({ school: '中国民用航空飞行学院', major: '飞行技术' }) === null);
ok('无学校返回 null', destinationFor({ major: '消防工程' }) === null);

console.log('\n[3] 生成的检索词');
const q = destinationQueries(FIRE, { max: 10 });
console.log(`     ${q.queries.join('、')}`);
ok('检索词非空', q.queries.length > 0);
ok('含「危险品」（标题不带消防但对口的岗位）', q.queries.includes('危险品'));
ok('含「应急救援」', q.queries.includes('应急救援'));
ok('含机场类词', q.queries.some((x) => /机场/.test(x)));
ok('数量不超过 max', q.queries.length <= 10);
ok('无重复', new Set(q.queries).size === q.queries.length);
ok('带出处', /^https?:\/\//.test(q.source));

console.log('\n[4] 岗位命中判断（打分加权用）');
const cases = [
  [{ title: '危险品培训专员', company: '圆通航空集团有限公司' }, true, '行业=航空公司'],
  [{ title: '消防工程师', company: '中安保实业集团有限公司' }, true, '单位命中'],
  [{ title: '场道维护员', company: '宁波机场集团有限公司' }, true, '行业=机场'],
  [{ title: 'Java开发工程师', company: '某科技公司' }, false, '无关岗位'],
];
for (const [job, want, desc] of cases) {
  const r = matchesDestination(job, FIRE);
  ok(`${desc}：${job.title} → ${want ? '命中' : '不命中'}`, r.hit === want, JSON.stringify(r));
}

console.log('\n[5] 无档案时不误伤');
const none = matchesDestination({ title: '消防工程师', company: '中安保' }, { school: '某某大学', major: '消防工程' });
ok('没有去向档案时不命中', none.hit === false);
ok('没有去向档案时不产生检索词', destinationQueries({ school: '某某大学' }).queries.length === 0);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
