// 用严格的 probeHost 复核注册表里每一所院校，揪出「看着可用实则抓不到」的假阳性
// 用法：node tools/audit-registry.mjs
import { VERIFIED_HOSTS, probeHost, parseSearchFragment } from '../src/sources/university.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function rawItems(host, type, keyword) {
  const res = await fetch(`${host}/search/list?type=${type}&keyword=${encodeURIComponent(keyword)}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html, */*; q=0.01',
      Referer: `${host}/search/list`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let text = buf.toString('utf8');
  if ((text.match(/\uFFFD/g) || []).length > text.length * 0.01) {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      /* ignore */
    }
  }
  return { status: res.status, bytes: buf.length, text, items: parseSearchFragment(text) };
}

console.log('='.repeat(80));
console.log('  注册表复核：每一项都必须真的能解析出条目');
console.log('='.repeat(80) + '\n');

const bad = [];
for (const h of VERIFIED_HOSTS) {
  const ok = await probeHost(h.host);
  const a = await rawItems(h.host, 1, '招聘');
  const b = await rawItems(h.host, 4, '招聘');
  const isFullPage = /<html[\s>]|<!DOCTYPE html>/i.test(a.text);

  console.log(`  ${ok ? '✅' : '❌'} ${h.name}  [${h.kind}]  ${h.host}`);
  console.log(
    `       probeHost=${ok}   type=1: HTTP ${a.status} ${a.bytes}B 解析 ${a.items.length} 条` +
      `   type=4: HTTP ${b.status} ${b.bytes}B 解析 ${b.items.length} 条` +
      `${isFullPage ? '   ⚠️ 返回的是整页 HTML' : ''}`,
  );
  if (!ok || a.items.length + b.items.length === 0) {
    bad.push(h);
    console.log('       ⚠️ 建议从注册表移除');
  }
  await new Promise((r) => setTimeout(r, 600));
}

console.log(`\n  复核 ${VERIFIED_HOSTS.length} 所：可用 ${VERIFIED_HOSTS.length - bad.length}，需移除 ${bad.length}`);
if (bad.length) for (const h of bad) console.log(`    - ${h.name} ${h.host}`);
process.exit(bad.length === 0 ? 0 : 1);
