// 校验打包产物：① 新代码确实进去了 ② 敏感文件确实没进去 ③ 不含真实密钥
import fs from 'node:fs';

const p = 'dist/简历岗位雷达-win32-x64/resources/app.asar';
const buf = fs.readFileSync(p);

/* ---------- 解析 asar 头部，拿到文件清单 ---------- */
function readHeader(b) {
  const jsonLen = b.readUInt32LE(12);
  const json = b.toString('utf8', 16, 16 + jsonLen);
  return JSON.parse(json);
}
const header = readHeader(buf);

/** 递归收集所有文件路径 */
function walk(node, prefix = '', out = []) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (v.files) walk(v, full, out);
    else out.push(full);
  }
  return out;
}
const files = walk(header);

const has = (re) => files.filter((f) => re.test(f));
let bad = 0;

/* ---------- ① 新代码在不在 ---------- */
console.log('【① 新代码是否已打包】');
for (const f of ['src/sources/university.mjs','src/match/campus.mjs','src/sources/nowcoder.mjs','src/application/context.mjs','src/application/run-service.mjs','src/infrastructure/storage/repository.mjs','src/domain/ontology.json','src/sources/catalog/universities.json','public/js/main.js','public/js/pages/profiles.js','public/js/pages/jobs.js','public/js/pages/applications.js','public/js/pages/settings.js','public/js/pages/workbench.js','public/styles/tokens.css','electron/preload.cjs','electron/credentials.mjs','node_modules/acorn/package.json','node_modules/linkedom/package.json']) {
  const ok = files.includes(f);
  if (!ok) bad++;
  console.log(`${ok ? '✅' : '❌'} ${f}`);
}
// 【坑】必须按 utf8 解码：asar 正文是 UTF-8 字节流。
// 早期这里用 toString('latin1')，每个字节变成一个字符，
// 于是**任何中文关键词都永远匹配不上** —— 会得出「中文串不在包里」的错误结论（曾因此误判过一次）。
const asarStr = buf.toString('utf8');
for (const n of ['VERIFIED_HOSTS', 'resolveHosts', 'preferredKinds', 'SCHOOL_ABBR']) {
  const ok = asarStr.includes(n);
  if (!ok) bad++;
  console.log(`${ok ? '✅' : '❌'} 含符号 ${n}`);
}

/* ---------- ② 敏感文件在不在 ---------- */
console.log('\n【② 敏感文件是否被打进去】');
const sensitive = [
  /^config\.json$/,
  /^\.env$/,
  /credentials\.yaml$/,
  /^data\//,
  /^dist\//,
  /test-security\.mjs$/,
  /^\.npm-cache/,
];
for (const re of sensitive) {
  const hits = has(re);
  if (hits.length) bad++;
  console.log(`${hits.length ? '⚠️' : '✅'} ${re.source} ${hits.length ? '→ ' + hits.slice(0, 3).join(', ') : ''}`);
}

/* ---------- ③ 真实密钥 ---------- */
console.log('\n【③ 是否含真实密钥】');
// 【坑】Tavily 的 key 形如 `tvly-dev-xxxx`（带连字符）。
// 原来的正则写成 /tvly-[A-Za-z0-9]{20,}/，遇到 `tvly-dev-` 会在连字符处断掉，
// 结果是**真实格式的 Tavily key 泄漏了也扫不出来**。字符集必须包含连字符。
for (const [label, re] of [
  ['DeepSeek sk- 密钥', /sk-[A-Za-z0-9_-]{20,}/],
  ['Tavily Key（tvly- / tvly-dev-）', /tvly-[A-Za-z0-9_-]{20,}/],
  ['博查 bsa- Key', /bsa-[A-Za-z0-9_-]{20,}/],
  // 不加「40 位十六进制」这种通用模式：asar 里的 integrity/sha1 摘要天然就是 40 位十六进制，
  // 加了必然误报（实测报了一次假泄漏）。Serper 的 key 恰好就是这个形状，无法与哈希区分，
  // 与其每次都假警报，不如不扫 —— 有前缀的 key 才是能可靠识别的。
]) {
  const hit = re.test(asarStr);
  if (hit) bad++;
  console.log(`${hit ? '⚠️ 泄漏' : '✅ 不含'} ${label}`);
}

console.log(`\nasar ${(buf.length / 1048576).toFixed(1)} MB，文件 ${files.length} 个，问题 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
