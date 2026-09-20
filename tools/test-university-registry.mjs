// 高校就业网注册表 / 自动发现 测试
// 用法：node tools/test-university-registry.mjs [--net]
//   --net 额外跑真实网络探测（慢，约 1 分钟）
import fs from 'node:fs';
import path from 'node:path';
import {
  VERIFIED_HOSTS,
  SCHOOL_ABBR,
  CACHE_VERSION,
  preferredKinds,
  isOwnSchool,
  resolveHosts,
  discoverHost,
  probeHost,
  collect,
} from '../src/sources/university.mjs';
import { DATA_ROOT } from '../src/config.mjs';

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

console.log('\n[1] 注册表结构');
ok('VERIFIED_HOSTS 非空', VERIFIED_HOSTS.length >= 5, `got ${VERIFIED_HOSTS.length}`);
ok(
  '每条都有 name/host/kind',
  VERIFIED_HOSTS.every((h) => h.name && /^https:\/\//.test(h.host) && h.kind),
);
ok(
  'host 无重复',
  new Set(VERIFIED_HOSTS.map((h) => h.host)).size === VERIFIED_HOSTS.length,
);
ok(
  '域名都不同校',
  new Set(VERIFIED_HOSTS.map((h) => h.name)).size === VERIFIED_HOSTS.length,
);
ok('缩写表已收录本校常用校', Object.keys(SCHOOL_ABBR).length >= 50, `got ${Object.keys(SCHOOL_ABBR).length}`);

console.log('\n[2] 专业 → 院校类型');
ok('计算机 → it 优先', preferredKinds({ major: '计算机科学与技术' })[0] === 'it');
ok('软件工程 → it 优先', preferredKinds({ major: '软件工程' })[0] === 'it');
ok('人工智能 → it 优先', preferredKinds({ major: '人工智能' })[0] === 'it');
ok('会计学 → finance 优先', preferredKinds({ major: '会计学' })[0] === 'finance');
ok('汉语言文学 → normal 优先', preferredKinds({ major: '汉语言文学' })[0] === 'normal');
ok('每种偏好都带 general 兜底', ['计算机', '会计学', '汉语言文学'].every((m) => preferredKinds({ major: m }).includes('general')));
ok('空专业 → 不限定', preferredKinds({}).length === 0);
ok('冷门专业 → 不限定', preferredKinds({ major: '考古学' }).length === 0);
// 关键回归：不能把「会计」误判成 it（"会计"里没有 it 关键词，但顺序错就可能被别的规则吃掉）
ok('会计学不会被判成 it', !preferredKinds({ major: '会计学' }).includes('it'));

console.log('\n[3] 本校识别（含子串误判回归）');
ok('全称命中', isOwnSchool(VERIFIED_HOSTS[0], { school: '西安电子科技大学' }));
ok('别名命中', isOwnSchool(VERIFIED_HOSTS[0], { school: '西电' }));
ok('简历里带后缀也命中', isOwnSchool(VERIFIED_HOSTS[0], { school: '西安电子科技大学（南校区）' }));
ok('非本校不命中', !isOwnSchool(VERIFIED_HOSTS[0], { school: '北京大学' }));
ok('无学校字段不命中', !isOwnSchool(VERIFIED_HOSTS[0], {}));
// 子串误判：'西安电子科技大学'.includes('电子科技大学') 为真，但这是两所不同的学校
ok(
  '成都电子科技大学 ≠ 西安电子科技大学',
  !isOwnSchool(VERIFIED_HOSTS[0], { school: '电子科技大学' }),
);
ok(
  '电子科技大学不会匹配任何已收录校',
  !VERIFIED_HOSTS.some((h) => isOwnSchool(h, { school: '电子科技大学' })),
);
// '东北大学秦皇岛分校'.includes('东北大学') 为真，但两校就业网不同
{
  const neuq = VERIFIED_HOSTS.find((h) => h.host === 'https://job.neuq.edu.cn');
  ok('东北大学 ≠ 东北大学秦皇岛分校', !isOwnSchool(neuq, { school: '东北大学' }));
}
ok('厦大别名命中', isOwnSchool(VERIFIED_HOSTS.find((h) => h.host === 'https://jy.xmu.edu.cn'), { school: '厦大' }));
ok('山财别名命中', isOwnSchool(VERIFIED_HOSTS.find((h) => h.host === 'https://job.sdufe.edu.cn'), { school: '山财' }));
ok('浙师大别名命中', isOwnSchool(VERIFIED_HOSTS.find((h) => h.host === 'https://career.zjnu.edu.cn'), { school: '浙师大' }));
// 四川大学曾被误收录（probeHost 假阳性），已移除；确认它不再出现在注册表里
ok('已被移除的四川大学不在注册表', !VERIFIED_HOSTS.some((h) => h.host === 'https://jy.scu.edu.cn'));

console.log('\n[4] resolveHosts（纯逻辑，走缓存/注册表，不联网）');
{
  const log = [];
  // 本校在注册表里 → 必须排第一
  const r = await resolveHosts(
    { school: '西安电子科技大学', major: '计算机科学与技术' },
    { maxHosts: 4, log: (m) => log.push(m) },
  );
  ok('返回 ≤ maxHosts', r.length <= 4, `got ${r.length}`);
  ok('本校排第一', r[0]?.host === 'https://job.xidian.edu.cn', `got ${r[0]?.host}`);
  ok('无重复 host', new Set(r.map((h) => h.host)).size === r.length);
  ok('it 类专业优先 it 院校', r.some((h) => h.kind === 'it'));
  ok('日志提到专业', log.some((m) => /专业/.test(m)), log.join(' | '));
}
{
  // 本校不在注册表、且无缩写 → 不崩，回落到注册表院校
  const r = await resolveHosts({ school: '某个不存在的学校', major: '软件工程' }, { maxHosts: 3, log: () => {} });
  ok('未收录学校不崩', r.length > 0 && r.length <= 3, `got ${r.length}`);
  ok('未收录学校时全为注册表院校', r.every((h) => VERIFIED_HOSTS.some((v) => v.host === h.host)));
}
{
  // 手动追加的 host 必须进结果（且排在专业匹配之前）
  const r = await resolveHosts(
    { school: '', major: '软件工程' },
    { extraHosts: [{ name: '某校', host: 'https://job.example.edu.cn' }], maxHosts: 4, log: () => {} },
  );
  ok('手动 host 进入结果', r.some((h) => h.host === 'https://job.example.edu.cn'));
  ok('手动 host 排在最前', r[0]?.host === 'https://job.example.edu.cn', `got ${r[0]?.host}`);
}
{
  // maxHosts 限制必须生效
  const r = await resolveHosts({ school: '', major: '' }, { maxHosts: 2, log: () => {} });
  ok('maxHosts=2 生效', r.length === 2, `got ${r.length}`);
}
{
  // 非 it 专业不应该把结果全挤成 it 院校
  const r = await resolveHosts({ school: '', major: '会计学' }, { maxHosts: 4, log: () => {} });
  ok('会计专业结果含综合类院校', r.some((h) => h.kind === 'general'), r.map((h) => h.kind).join(','));
  ok('会计专业首选财经类院校', r[0]?.kind === 'finance', `got ${r[0]?.kind} ${r[0]?.name}`);
  ok('会计专业不含 it 院校', !r.some((h) => h.kind === 'it'), r.map((h) => `${h.name}(${h.kind})`).join(' '));
}
{
  // 师范/文科专业应优先师范类
  const r = await resolveHosts({ school: '', major: '汉语言文学' }, { maxHosts: 4, log: () => {} });
  ok('文科专业首选师范类院校', r[0]?.kind === 'normal', `got ${r[0]?.kind} ${r[0]?.name}`);
}
{
  // 三类专业选出来的第一所必须不同 —— 这是「按专业选校」真正生效的判据
  const pick = async (major) => (await resolveHosts({ school: '', major }, { maxHosts: 4, log: () => {} }))[0]?.host;
  const [it, fin, norm] = await Promise.all([pick('计算机科学与技术'), pick('会计学'), pick('汉语言文学')]);
  ok('IT / 财经 / 文科 三类专业首选院校互不相同', new Set([it, fin, norm]).size === 3, `${it} | ${fin} | ${norm}`);
}
{
  // 计算机专业：it 类必须排在 general 前面
  const r = await resolveHosts({ school: '', major: '计算机科学与技术' }, { maxHosts: 4, log: () => {} });
  const firstGeneral = r.findIndex((h) => h.kind === 'general');
  const lastIt = r.map((h) => h.kind).lastIndexOf('it');
  ok('IT 专业：it 类排在 general 之前', lastIt < firstGeneral, r.map((h) => `${h.name}(${h.kind})`).join(' '));
}
{
  // 专业没识别出来时，也要优先综合类而不是按注册表顺序硬取
  const r = await resolveHosts({ school: '', major: '' }, { maxHosts: 4, log: () => {} });
  ok('专业未知时优先综合类', r[0]?.kind === 'general', `got ${r[0]?.kind} ${r[0]?.name}`);
}

console.log('\n[5] 缓存版本（旧选校逻辑的错误结论必须失效）');
{
  // 旧版 isOwnSchool 用双向子串匹配，把成都「电子科技大学」判成了西安电子科技大学，
  // 并把 xidian 的地址写进了缓存。这类错误结论不能一直被复用。
  const cacheFile = path.join(DATA_ROOT, 'university-hosts.json');
  const backup = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null;
  try {
    // ① 无版本号的旧缓存 + 错误地址 → 必须被忽略，回落到注册表得到正确地址
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ 西安电子科技大学: { host: 'https://wrong.example.com', probedAt: Date.now() } }),
      'utf8',
    );
    const h1 = await discoverHost('西安电子科技大学', { log: () => {} });
    ok('无版本号的旧缓存被忽略', h1 === 'https://job.xidian.edu.cn', String(h1));

    // ② 版本号正确 → 正常复用（用一所注册表里没有的学校验证，避免被注册表短路）
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ 测试用大学: { host: 'https://job.test.example.edu.cn', v: CACHE_VERSION, probedAt: Date.now() } }),
      'utf8',
    );
    const h2 = await discoverHost('测试用大学', { log: () => {} });
    ok('版本号正确的缓存被复用', h2 === 'https://job.test.example.edu.cn', String(h2));

    // ③ 版本号过期 → 忽略
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ 测试用大学: { host: 'https://stale.example.edu.cn', v: CACHE_VERSION - 1, probedAt: Date.now() } }),
      'utf8',
    );
    const h3 = await discoverHost('测试用大学', { log: () => {} });
    ok('版本号过期被忽略', h3 !== 'https://stale.example.edu.cn', String(h3 ?? 'null'));
  } finally {
    if (backup !== null) fs.writeFileSync(cacheFile, backup, 'utf8');
    else fs.rmSync(cacheFile, { force: true });
  }
}

console.log('\n[6] collect() 参数契约');{
  // 显式传 hosts 时必须原样使用（不触发自动解析）
  const seen = [];
  const r = await collect({
    keywords: ['Java'],
    hosts: [],
    profile: { school: '西安电子科技大学', major: '计算机' },
    maxDetail: 0,
    maxPerKeyword: 0,
    log: () => {},
  });
  ok('空 hosts + maxDetail=0 也不报错', Array.isArray(r.jobs) && Array.isArray(r.errors));
  ok('stats 含 probed/ownSchool 字段', 'probed' in r.stats || 'university' in r.stats);
}

if (process.argv.includes('--net')) {
  console.log('\n[7] 真实网络探测（--net）');
  // probeHost 是「发现未收录学校」的核心，必须证明它对真站点判 true、对假站点判 false
  ok('probeHost 对可用站点判 true', (await probeHost('https://job.xidian.edu.cn')) === true);
  ok('probeHost 对不存在站点判 false', (await probeHost('https://job.this-host-does-not-exist-xyz.edu.cn')) === false);
  // 回归：四川大学 jy.scu.edu.cn 的 /search/list 不存在，直接返回首页 HTML（127KB），
  // 旧版 probeHost 只看页面里有没有 view/id 和 <li，把它误判成可用并写进了注册表。
  ok(
    'probeHost 不会把「返回整页 HTML」的站点判为可用（四川大学）',
    (await probeHost('https://jy.scu.edu.cn')) === false,
  );

  for (const school of ['西安电子科技大学', '北京邮电大学']) {
    const t0 = Date.now();
    const host = await discoverHost(school, { log: (m) => console.log(`    ${m.trim()}`), force: true });
    const ms = Date.now() - t0;
    console.log(`    ${school} → ${host || '（未找到）'}  ${(ms / 1000).toFixed(1)}s`);
    ok(`${school} 探测流程走通（返回字符串或 null）`, host === null || typeof host === 'string', String(host));
    if (school === '西安电子科技大学') ok('  西电应命中注册表', host === 'https://job.xidian.edu.cn', String(host));
    if (school === '北京邮电大学') ok('  北邮实测不在支持范围内', host === null, String(host));
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
