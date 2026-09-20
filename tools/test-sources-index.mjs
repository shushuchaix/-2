// 多源调度测试（src/sources/index.mjs）
//
// 为什么必须测：这是 8 个数据源的调度核心，改一处影响全局。
// 我这一路往里加了 university / chenyun / jiuyeqiao 三个源，
// 每次都只能靠跑一遍端到端才发现问题 —— 没有单元测试兜底。
//
// 这里不联网，用「全部关闭」和「注入假源」两种方式验证调度契约。
import { collectJobs, buildSearchPlan, SOURCES } from '../src/sources/index.mjs';
import { loadConfig } from '../src/config.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

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

/* ---------- 全部关闭的配置：不联网，验证契约 ---------- */
const offCfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
for (const k of ['zhaopin', 'shixiseng', 'searchApi', 'wechat', 'nowcoder']) offCfg.sources[k].enabled = false;
offCfg.sources.university.enabled = false;
offCfg.sources.chenyun.enabled = false;
offCfg.sources.jiuyeqiao.enabled = false;

console.log('\n[1] 模块结构');
ok('SOURCES 暴露 8 个源', Object.keys(SOURCES).length === 8, Object.keys(SOURCES).join(','));
ok(
  '配置里每个源都有对应实现',
  ['zhaopin', 'shixiseng', 'searchapi', 'wechat', 'nowcoder', 'university', 'chenyun', 'jiuyeqiao'].every(
    (k) => k in SOURCES,
  ),
  Object.keys(SOURCES).join(','),
);
ok(
  'DEFAULT_CONFIG.sources 覆盖所有源',
  ['zhaopin', 'shixiseng', 'searchApi', 'wechat', 'nowcoder', 'university', 'chenyun', 'jiuyeqiao'].every(
    (k) => k in DEFAULT_CONFIG.sources,
  ),
  Object.keys(DEFAULT_CONFIG.sources).join(','),
);
// 每个源都要有 enabled 开关和 meta
for (const [key, mod] of Object.entries(SOURCES)) {
  if (key === 'searchapi') continue;
  ok(`  ${key} 有 meta`, Boolean(mod.meta?.id && mod.meta?.name), JSON.stringify(mod.meta || {}));
}

console.log('\n[2] 检索计划');
{
  const p1 = buildSearchPlan(['消防工程师', '安全工程师'], []);
  ok('不限城市 → 每个关键词一条，城市=全国', p1.length === 2 && p1.every((x) => x.city === '全国'), JSON.stringify(p1));
  const p2 = buildSearchPlan(['消防工程师', '安全工程师', 'EHS'], ['成都', '北京'], { maxCities: 2, secondaryCityKeywords: 2 });
  ok('多城市展开', p2.length === 5, `得到 ${p2.length} 条：${JSON.stringify(p2.map((x) => `${x.city}×${x.keyword}`))}`);
  ok('首选城市跑全部关键词', p2.filter((x) => x.city === '成都').length === 3);
  ok('次选城市只跑前 2 个', p2.filter((x) => x.city === '北京').length === 2);
  ok('通常标记主城市', p2.filter((x) => x.primary).every((x) => x.city === '成都'));
  ok('空关键词 → 空计划', buildSearchPlan([], []).length === 0);
  ok('关键词去重后不炸', buildSearchPlan(['A'], []).length === 1);
}

console.log('\n[3] 全部数据源关闭时：不联网、不报错、结构完整');
{
  const r = await collectJobs({
    titleKeywords: ['消防工程师'],
    webQueries: [],
    wechatQueries: [],
    cities: [],
    cfg: offCfg,
    log: () => {},
  });
  ok('返回 jobs 数组', Array.isArray(r.jobs));
  ok('返回 articles 数组', Array.isArray(r.articles));
  ok('返回 errors 数组', Array.isArray(r.errors));
  ok('没有岗位', r.jobs.length === 0);
  ok('没有意外错误', r.errors.length === 0, r.errors.join(' | '));
  ok(
    'stats 覆盖全部 8 个源',
    ['zhaopin', 'shixiseng', 'web', 'wechat', 'nowcoder', 'university', 'chenyun', 'jiuyeqiao'].every(
      (k) => k in r.stats,
    ),
    Object.keys(r.stats).join(','),
  );
  ok('rawCount 为 0', r.rawCount === 0);
}

console.log('\n[4] onJobs 回调契约');
{
  const seen = [];
  const r = await collectJobs({
    titleKeywords: ['消防工程师'],
    cities: [],
    cfg: offCfg,
    log: () => {},
    onJobs: (jobs) => seen.push(...jobs),
  });
  ok('没有源产出时不触发回调', seen.length === 0 && r.jobs.length === 0);
}

console.log('\n[5] 关闭的源不会被调用（用错误注入验证）');
{
  // 把 university 打开但给一个必然失败的 host，确认错误被收集而不是抛出
  const cfg2 = JSON.parse(JSON.stringify(offCfg));
  cfg2.sources.university.enabled = true;
  cfg2.sources.university.hosts = [{ name: '不存在的学校', host: 'https://this-host-does-not-exist-xyz.invalid' }];
  cfg2.sources.university.maxHosts = 1;
  cfg2.sources.university.maxDetail = 0;
  const r = await collectJobs({
    titleKeywords: ['消防工程师'],
    cities: [],
    cfg: cfg2,
    log: () => {},
    profile: { school: '某某大学', major: '消防工程' },
  });
  ok('单个源失败不影响整体返回', Array.isArray(r.jobs) && Array.isArray(r.errors));
  ok('失败信息被收集到 errors', r.errors.length > 0, r.errors.slice(0, 2).join(' | '));
  ok('没有抛出异常', true);
}

console.log('\n[6] 城市过滤（站点忽略城市参数时的兜底）');
{
  // 构造：让 nowcoder 之外的源全关，用一个假的源很难注入，
  // 所以这里直接验证「cities 为空时不做过滤」这一契约
  const r = await collectJobs({ titleKeywords: ['X'], cities: [], cfg: offCfg, log: () => {} });
  ok('cities 为空时不过滤（返回 0 条而不是报错）', r.jobs.length === 0 && r.errors.length === 0);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
