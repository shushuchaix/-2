// 验证：用详情页明文标题反推字体映射，再解码列表页全部标题
import { decodeEntities, evalInlinePayload } from '../src/util/html.mjs';
import { hasPua, learnFromPair, decodeWithMap, coverage, mapSize } from '../src/sources/fontmap.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: 'https://www.shixiseng.com/' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  return res.ok ? res.text() : '';
}

const evalNuxt=html=>evalInlinePayload(html,'__NUXT__');

/** 从详情页 <title> 推出候选明文标题 */
export function titleCandidatesFromDetail(html) {
  const raw = (html.match(/<title>([^<]*)<\/title>/) || [, ''])[1].trim();
  if (!raw) return { candidates: [], raw };
  const segs = raw
    .replace(/-\s*实习僧\s*$/, '')
    .split(/[-–|｜]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const cands = new Set();
  for (const seg of segs) {
    cands.add(seg);
    cands.add(seg.replace(/(实习生?)?招聘$/, ''));
    cands.add(seg.replace(/(实习生?)?招聘$/, '').replace(/实习$/, ''));
    cands.add(seg.replace(/招聘$/, ''));
  }
  return { candidates: [...cands].filter((s) => s.length >= 2), raw };
}

const map = new Map();

for (const kw of ['Java开发']) {
  console.log(`\n########## 列表页关键词「${kw}」 ##########`);
  const listHtml = await get(`https://www.shixiseng.com/interns?keyword=${encodeURIComponent(kw)}&city=${encodeURIComponent('北京')}`);
  const nuxt = evalNuxt(listHtml);
  const items = nuxt?.data?.[0]?.interns?.data || [];
  console.log('列表条数:', items.length);

  const rows = items.map((it) => {
    const obf = decodeEntities(String(it.name || ''));
    return { uuid: it.uuid, cname: it.cname, obf, obfuscated: hasPua(obf) };
  });
  console.log('含混淆的条数:', rows.filter((r) => r.obfuscated).length, '/', rows.length);

  console.log('\n--- 抓详情页学习映射 ---');
  const samples = rows.filter((r) => r.obfuscated).slice(0, 6);
  for (const s of samples) {
    const html = await get(`https://www.shixiseng.com/intern/${s.uuid}`);
    const { candidates, raw } = titleCandidatesFromDetail(html);
    const match = candidates.find((c) => c.length === s.obf.length && (!hasPua(c)));
    let learned = 0;
    if (match) learned = learnFromPair(s.obf, match, map);
    console.log(`  ${s.uuid} obf=${JSON.stringify(s.obf)} len=${s.obf.length}`);
    console.log(`     title="${raw}"`);
    console.log(`     候选=${JSON.stringify(candidates)} → 匹配=${match ? JSON.stringify(match) : '无'} 学到=${learned} 累计=${mapSize(map)}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n--- 映射表（${mapSize(map)} 条）---`);
  console.log(
    [...map.entries()]
      .filter(([k]) => !k.startsWith('__'))
      .map(([k, v]) => `${k.codePointAt(0).toString(16)}→${v}`)
      .join(' '),
  );

  console.log('\n--- 用映射表解码全部标题 ---');
  let okCount = 0;
  for (const r of rows) {
    if (!r.obfuscated) {
      console.log(`  [明文] ${r.obf}`);
      continue;
    }
    const cov = coverage(r.obf, map);
    const dec = decodeWithMap(r.obf, map);
    const clean = dec.replace(/[\uE000-\uF8FF]/g, '□');
    if (cov === 1) okCount++;
    console.log(`  [${(cov * 100).toFixed(0).padStart(3)}%] ${JSON.stringify(r.obf)} → ${clean}`);
  }
  console.log(`\n完整解码: ${okCount}/${rows.filter((r) => r.obfuscated).length} 条混淆标题`);
}

process.exit(0);
