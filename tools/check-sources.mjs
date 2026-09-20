// 数据源健康检查：逐个独立探测，回答「现在还能不能拿到岗位」
// 用法：node tools/check-sources.mjs [--quick]
//
// 为什么需要它：这一路我加了 8 个源，但**任何一个失效都是静默的** ——
// 只有盯着端到端日志才发现。微信公众号源就是这么悄悄死掉的：
// 每次跑都报 4 条反爬错误、产出 0 篇文章，而结果集里看不出异常。
// 这个脚本把「每个源当前是否还能拿到数据」变成一条可定期执行的命令。
import { loadConfig } from '../src/config.mjs';
import * as zhaopin from '../src/sources/zhaopin.mjs';
import * as shixiseng from '../src/sources/shixiseng.mjs';
import * as nowcoder from '../src/sources/nowcoder.mjs';
import * as wechat from '../src/sources/wechat.mjs';
import * as searchapi from '../src/sources/searchapi.mjs';
import { probeHost as probeChenyun, CHENYUN_HOSTS } from '../src/sources/chenyun.mjs';
import { probeHost as probeJiuyeqiao } from '../src/sources/jiuyeqiao.mjs';
import { probeHost as probeCailifang, VERIFIED_HOSTS } from '../src/sources/university.mjs';

const QUICK = process.argv.includes('--quick');
const cfg = loadConfig({ quiet: true });
const KEYWORDS = ['消防工程师', '安全工程师'];

const results = [];
const quiet = () => {};

async function run(name, enabled, fn, { required = 1 } = {}) {
  if (!enabled) {
    results.push({ name, status: 'disabled', detail: '配置中已关闭' });
    console.log(`  ⏸  ${name.padEnd(18)} 已关闭`);
    return;
  }
  const t0 = Date.now();
  try {
    const r = await fn();
    const n = r?.count ?? 0;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r?.unconfigured) {
      results.push({ name, status: 'unconfigured', detail: r.detail });
      console.log(`  ○  ${name.padEnd(18)} ${r.detail}`);
      return;
    }
    if (r?.transient) {
      results.push({ name, status: 'transient', detail: r.detail });
      console.log(`  ◐  ${name.padEnd(18)} ${r.detail}`);
      return;
    }
    const ok = n >= required;
    results.push({ name, status: ok ? 'ok' : 'empty', count: n, secs, detail: r?.detail || '' });
    console.log(`  ${ok ? '✅' : '⚠️ '} ${name.padEnd(18)} ${String(n).padStart(3)} 条  ${secs}s  ${r?.detail || ''}`);
    for (const e of (r?.errors || []).slice(0, 2)) console.log(`       ! ${e}`);
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ name, status: 'error', detail: e.message, secs });
    console.log(`  ❌ ${name.padEnd(18)} 失败 ${secs}s  ${e.message}`);
  }
}

console.log('\n=== 数据源健康检查 ===\n');

await run('智联招聘', cfg.sources.zhaopin?.enabled, async () => {
  // 注意：各源的抓取入口名不统一（zhaopin/shixiseng 是 search，other 是 collect）——
  // 这正是需要这个健康检查的原因之一，接口不统一时很容易以为「源坏了」其实是名字写错。
  const r = await zhaopin.search({
    keyword: KEYWORDS[0],
    city: '全国',
    maxPages: 1,
    delayMs: 300,
    log: quiet,
  });
  return { count: (r.jobs || []).length, errors: r.errors, detail: r.jobs?.[0]?.title?.slice(0, 22) || '' };
});

await run('实习僧', cfg.sources.shixiseng?.enabled, async () => {
  const r = await shixiseng.search({
    keyword: KEYWORDS[0],
    city: '全国',
    maxPages: 1,
    delayMs: 400,
    log: quiet,
  });
  return { count: (r.jobs || []).length, errors: r.errors };
});

await run('牛客校招', cfg.sources.nowcoder?.enabled, async () => {
  const r = await nowcoder.collect({ targetYear: '2027', includeSchedule: false, log: quiet });
  return { count: (r.jobs || []).length, errors: r.errors, detail: r.jobs?.[0]?.company || '' };
});

await run('高校就业网·才立方', cfg.sources.university?.enabled, async () => {
  const alive = [];
  for (const h of VERIFIED_HOSTS.slice(0, 4)) {
    if (await probeCailifang(h.host)) alive.push(h.name);
  }
  return {
    count: alive.length,
    detail: alive.length ? `可用：${alive.join('、')}` : '全部不可用',
  };
});

await run('高校就业网·晨云', cfg.sources.chenyun?.enabled, async () => {
  const hosts = CHENYUN_HOSTS;
  const alive = [];
  let netFail = 0;
  for (const h of hosts) {
    // 不能用 probeHost 判断「网络错误」—— 它内部 catch 掉所有异常只返回 false，
    // 于是「被限流」和「站点失效」会混成同一种结果。这里直接打列表接口并保留异常。
    try {
      const res = await fetch(`${h.host}/index/index/employjoblistdata.html`, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ResumeJobRadar/1.0)',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `${h.host}/index/index/employjob.html`,
        },
        body: 'page=1',
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        netFail++;
        continue;
      }
      if (await probeChenyun(h.host)) alive.push(h.name);
    } catch {
      netFail++;
    }
  }
  // 全部因网络层错误失败 → 大概率是被限流（IP 频控），不是站点失效，别误报成「需处理」
  if (!alive.length && netFail === hosts.length) {
    return { count: 0, detail: '网络层被拒（ECONNRESET / 超时，多为 IP 频控）', transient: true };
  }
  return { count: alive.length, detail: alive.join('、') || '连得上但列表为空' };
});

await run('就业桥', cfg.sources.jiuyeqiao?.enabled, async () => {
  const r = await probeJiuyeqiao();
  return { count: r ? 1 : 0, detail: r ? '列表接口正常' : '列表接口无数据' };
});

await run('微信公众号', cfg.sources.wechat?.enabled, async () => {
  const r = await wechat.collectWechat({
    keywords: ['2027届 校园招聘'],
    maxPages: 1,
    maxFetch: 2,
    delayMs: 1500,
    cfg,
    log: quiet,
  });
  return { count: (r.jobs || []).length, errors: r.errors };
});

await run('全网搜索 API', cfg.sources.searchApi?.enabled, async () => {
  // 【坑】不能用 cfg.search.provider —— 那是原始配置值，默认是 'auto'。
  // 'auto' 只是「按已配置的 key 自动选」的占位符，真正的通道由 config.mjs 的
  // resolveSearchProvider() 解析后放进 cfg.__activeSearchProvider。
  // 直接把 'auto' 传给适配器会得到「未知搜索通道：auto」，看起来像源坏了，其实是取值取错了。
  const provider = cfg.__activeSearchProvider;
  const key = provider ? cfg.__searchKeys?.[provider] : '';
  if (!provider || !key) {
    return { count: 0, detail: '未配置 Key（可选通道，不影响其他源）', unconfigured: true };
  }
  const r = await searchapi.searchAll(['2027届 消防 校园招聘'], {
    provider,
    apiKey: key,
    maxResults: 5,
    log: quiet,
  });
  return { count: (r.jobs || []).length, errors: r.errors, detail: searchapi.providerLabel(provider) };
});

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(72));
const ok = results.filter((r) => r.status === 'ok');
const bad = results.filter((r) => r.status === 'empty' || r.status === 'error');
const off = results.filter((r) => r.status === 'disabled');
const unconf = results.filter((r) => r.status === 'unconfigured');
const trans = results.filter((r) => r.status === 'transient');
console.log(
  `  可用 ${ok.length} 个 ｜ 异常 ${bad.length} 个 ｜ 未配置 ${unconf.length} 个 ｜ 被限流 ${trans.length} 个 ｜ 关闭 ${off.length} 个`,
);
if (trans.length) {
  console.log('\n  被限流的源（通常是短时间探测太频繁，隔一会儿会恢复）：');
  for (const t of trans) console.log(`    ◐  ${t.name} — ${t.detail}`);
}
if (bad.length) {
  console.log('\n  需要处理的源：');
  for (const b of bad) {
    console.log(`    ${b.status === 'error' ? '❌' : '⚠️ '} ${b.name} — ${b.status === 'error' ? b.detail : '能连上但拿不到数据（可能已失效）'}`);
  }
  console.log('\n  提示：失效的源应当显式关闭（config.sources.<name>.enabled = false），');
  console.log('        否则每轮检索都会白花时间并产生噪声错误日志。');
}
console.log('='.repeat(72) + '\n');

process.exit(0);
