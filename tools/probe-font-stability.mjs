// 判定：实习僧的混淆字体是「全局稳定」还是「每页轮换」
// 手法：用薪资字段的（混淆串 ↔ 明文数字）免费已知明文，跨页对比数字映射
import { decodeEntities, evalInlinePayload } from '../src/util/html.mjs';
import { hasPua } from '../src/sources/fontmap.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function listPage(keyword, city, page) {
  const params = new URLSearchParams({ keyword });
  if (city && city !== '全国') params.set('city', city);
  if (page > 1) params.set('page', String(page));
  const res = await fetch(`https://www.shixiseng.com/interns?${params}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();
  const nuxt = evalInlinePayload(html, '__NUXT__');
  return { html, items: nuxt?.data?.[0]?.interns?.data || [] };
}

function digitMapFrom(items) {
  const m = new Map(); // 码点 -> 数字字符
  let pairs = 0;
  for (const it of items) {
    for (const [obfRaw, plain] of [[it.maxsal, it.maxsalary], [it.minsal, it.minsalary]]) {
      const n = Number(plain);
      if (!obfRaw || !Number.isFinite(n) || n <= 0) continue;
      const obf = decodeEntities(String(obfRaw));
      const p = String(n);
      if (!hasPua(obf) || obf.length !== p.length) continue;
      pairs++;
      for (let i = 0; i < obf.length; i++) {
        const c = obf[i];
        if (!hasPua(c)) continue;
        if (!m.has(c)) m.set(c, p[i]);
      }
    }
  }
  return { m, pairs };
}

function fmt(m) {
  return [...m.entries()]
    .sort((a, b) => (a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${v}=U+${k.codePointAt(0).toString(16)}`)
    .join(' ');
}

const targets = [
  ['Java开发', '北京', 1],
  ['Java开发', '北京', 2],
  ['数据分析', '北京', 1],
  ['Java开发', '杭州', 1],
  ['产品经理', '上海', 1],
];

const results = [];
for (const [kw, city, page] of targets) {
  const { items } = await listPage(kw, city, page);
  const { m, pairs } = digitMapFrom(items);
  results.push({ label: `${kw}@${city} p${page}`, m, pairs, n: items.length });
  console.log(`\n[${kw}@${city} p${page}] 岗位 ${items.length} 条，薪资明文对 ${pairs} 组，学到数字 ${m.size} 个`);
  console.log('   ', fmt(m));
  await new Promise((r) => setTimeout(r, 900));
}

console.log('\n\n========== 跨页一致性对比 ==========');
const base = results[0];
console.log(`基准：${base.label}`);
let maxDisagree = 0;
for (const r of results.slice(1)) {
  let agree = 0, disagree = 0;
  const conflicts = [];
  for (const [k, v] of r.m) {
    if (base.m.has(k)) {
      if (base.m.get(k) === v) agree++;
      else { disagree++; conflicts.push(`U+${k.codePointAt(0).toString(16)}: ${base.m.get(k)} vs ${v}`); }
    }
  }
  const total = agree + disagree;
  console.log(`  ${r.label.padEnd(22)} 共有码点 ${String(total).padStart(2)}  一致 ${String(agree).padStart(2)}  冲突 ${disagree}`);
  if (conflicts.length) console.log(`      冲突详情: ${conflicts.slice(0, 8).join(' | ')}`);
  maxDisagree = Math.max(maxDisagree, disagree);
}

console.log('\n========== 结论 ==========');
if (maxDisagree === 0) {
  console.log('✅ 所有页面数字映射完全一致 → 混淆字体是「全局稳定」的，');
  console.log('   可以用少量样本学到的映射表解码任意页面的标题。');
} else {
  console.log('❌ 不同页面的映射存在冲突 → 字体「每页轮换」，');
  console.log('   映射表必须按「页面」隔离，解码只能在同页内进行。');
}

process.exit(0);
