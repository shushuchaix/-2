// 验证候选就业网是否真的可用（有近期校招数据、详情页能解析）
// 用法：node tools/verify-candidate-hosts.mjs
import { parseSearchFragment, parseJobDetail, parseNoticeDetail, probeHost } from '../src/sources/university.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchText(url, { xhr = false, referer = '' } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html, */*; q=0.01',
      ...(referer ? { Referer: referer } : {}),
      ...(xhr ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let text = buf.toString('utf8');
  if ((text.match(/\uFFFD/g) || []).length > text.length * 0.01) {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      /* ignore */
    }
  }
  return text;
}

const CANDIDATES = [
  { name: '山东财经大学', host: 'https://job.sdufe.edu.cn', kind: 'finance' },
  { name: '浙江师范大学', host: 'https://career.zjnu.edu.cn', kind: 'normal' },
];

const KEYWORDS = ['Java', '财务', '会计', '软件开发'];

for (const c of CANDIDATES) {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`  ${c.name}  ${c.host}  [${c.kind}]`);
  console.log('='.repeat(74));

  console.log(`  probeHost: ${(await probeHost(c.host)) ? '✅ true' : '❌ false'}`);

  let total = 0;
  const items = [];
  for (const kw of KEYWORDS) {
    for (const type of [1, 4]) {
      try {
        const html = await fetchText(`${c.host}/search/list?type=${type}&keyword=${encodeURIComponent(kw)}`, {
          xhr: true,
          referer: `${c.host}/search/list`,
        });
        if (/暂无数据/.test(html)) {
          console.log(`    「${kw}」type=${type} → 暂无数据`);
          continue;
        }
        const list = parseSearchFragment(html);
        total += list.length;
        console.log(`    「${kw}」type=${type} → ${list.length} 条`);
        for (const it of list.slice(0, 3)) items.push({ ...it, kw, type });
      } catch (e) {
        console.log(`    「${kw}」type=${type} → 失败 ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  console.log(`  合计列表 ${total} 条`);

  // 抓最多 5 条详情，验证详情页解析
  let okDetail = 0;
  for (const it of items.slice(0, 5)) {
    const url = it.href.startsWith('http') ? it.href : `${c.host}${it.href}`;
    try {
      const html = await fetchText(url, { referer: `${c.host}/search/list` });
      const isNotice = /\/campus\/view\/id\//.test(url);
      const d = isNotice ? parseNoticeDetail(html) : parseJobDetail(html);
      const usable = Boolean(d.title);
      if (usable) okDetail++;
      console.log(
        `      ${usable ? '✅' : '❌'} [${it.kw}/${it.type === 1 ? '职位' : '公告'}] ${String(it.title).slice(0, 34)}` +
          `  city=${d.city || '-'}  salary=${d.salary || '-'}  职位表=${d.positions?.length ?? '-'}`,
      );
      console.log(`         ${url}`);
    } catch (e) {
      console.log(`      ❌ 详情失败 ${e.message}  ${url}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  console.log(`\n  结论：列表 ${total} 条，详情解析成功 ${okDetail}/5`);
  console.log(
    total > 0 && okDetail > 0
      ? `  ✅ ${c.name} 可用，建议加入注册表`
      : `  ❌ ${c.name} 数据不可用，不要加入`,
  );
}
