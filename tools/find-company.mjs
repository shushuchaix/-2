// 用已接入的通道查指定公司的招聘信息
import * as university from '../src/sources/university.mjs';
import * as wechat from '../src/sources/wechat.mjs';

const COMPANY = '通用航空';

console.log('='.repeat(76));
console.log(`  一、高校就业网检索「${COMPANY}」`);
console.log('='.repeat(76));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function uniSearch(hostInfo, keyword) {
  const out = [];
  for (const type of [1, 4]) {
    const url = `${hostInfo.host}/search/list?type=${type}&keyword=${encodeURIComponent(keyword)}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html, */*; q=0.01',
          Referer: `${hostInfo.host}/search/list`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      let text = buf.toString('utf8');
      if ((text.match(/\uFFFD/g) || []).length > text.length * 0.01) {
        try { text = new TextDecoder('gbk').decode(buf); } catch { /* ignore */ }
      }
      if (/暂无数据/.test(text)) continue;
      const items = university.parseSearchFragment(text);
      for (const it of items) {
        out.push({
          ...it,
          host: hostInfo.name,
          type: type === 1 ? '职位信息' : '招聘公告',
          url: it.href.startsWith('http') ? it.href : `${hostInfo.host}${it.href}`,
        });
      }
    } catch (e) {
      out.push({ error: e.message, host: hostInfo.name, type });
    }
  }
  return out;
}

for (const kw of [COMPANY, '通用航空有限责任公司', '航空']) {
  console.log(`\n--- 关键词「${kw}」 ---`);
  for (const h of university.DEFAULT_HOSTS) {
    const items = await uniSearch(h, kw);
    const errs = items.filter((x) => x.error);
    const hits = items.filter((x) => !x.error);
    if (errs.length && !hits.length) {
      console.log(`  ${h.name.padEnd(14)} 失败: ${errs[0].error?.slice(0, 40)}`);
      continue;
    }
    console.log(`  ${h.name.padEnd(14)} ${hits.length} 条`);
    hits.slice(0, 6).forEach((x) => {
      console.log(`     [${x.type}] ${x.title.slice(0, 46)} ${x.publishTime || ''}`);
      console.log(`        ${x.url}`);
    });
  }
}

console.log('\n' + '='.repeat(76));
console.log(`  二、搜狗微信检索「${COMPANY} 招聘」`);
console.log('='.repeat(76));
try {
  const r = await wechat.collectWechat({
    keywords: [`${COMPANY} 招聘`, `${COMPANY} 校园招聘`],
    roleKeywords: [COMPANY, '航空'],
    maxPages: 1,
    maxFetch: 6,
    delayMs: 1000,
    log: (m) => console.log(`  ${m}`),
  });
  console.log(`\n  共 ${r.jobs.length} 篇相关文章：`);
  for (const a of r.jobs.slice(0, 10)) {
    console.log(`\n  · ${a.title.slice(0, 50)}`);
    console.log(`    公众号「${a.extra.account || '?'}」 ${a.publishTime || ''} 相关度=${a.extra.relevance}`);
    if (a.description) console.log(`    正文 ${a.extra.textLength} 字: ${a.description.replace(/\s+/g, ' ').slice(0, 180)}`);
    if (a.url) console.log(`    ${a.url.slice(0, 100)}`);
  }
} catch (e) {
  console.log('  微信通道失败:', e.message);
}

process.exit(0);
