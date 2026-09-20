// 找出「本次对话期间产生、但当前没有任何引用」的文件
//
// 判据（三个都要过才算孤儿）：
//   ① 不在 package.json 的 scripts 里
//   ② 不在 run-all-tests.mjs 的套件列表里
//   ③ 没有被任何 .mjs/.js 静态 import，也不是 electron/main 或全局入口
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const SELF = fileURLToPath(import.meta.url);

const SKIP_DIRS = new Set(['node_modules', '.git', '.npm-cache', 'dist', '.cache', '.tmp-test-data', 'build']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const all = walk(ROOT);
const code = all.filter((f) => /\.(mjs|js|css|html)$/.test(f));
const text = code.filter((f) => path.resolve(f) !== path.resolve(SELF));

// ① package.json 引用
const refs = new Set();
const pkgRaw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const pkg = JSON.parse(pkgRaw);
for (const cmd of Object.values(pkg.scripts)) {
  for (const m of cmd.matchAll(/([\w./-]+\.(?:mjs|js|html|css))/g)) refs.add(path.resolve(ROOT, m[1]));
}
// ② run-all-tests 引用
const runnerPath = path.join(ROOT, 'tools/run-all-tests.mjs');
if (fs.existsSync(runnerPath)) {
  const r = fs.readFileSync(runnerPath, 'utf8');
  for (const m of r.matchAll(/f: '([\w.-]+\.mjs)'/g)) refs.add(path.resolve(ROOT, 'tools', m[1]));
}
// ③ 被 import 的模块（含 HTML 里引用的 js/css）
const imported = new Set();
for (const f of text) {
  const src = fs.readFileSync(f, 'utf8');
  const fromDir = path.dirname(f);
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const t = path.resolve(fromDir, m[1]);
    imported.add(t);
    imported.add(t.replace(/\.mjs$/, '.js'));
  }
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) imported.add(path.resolve(fromDir, m[1]));
  // HTML 里的 src/href
  if (f.endsWith('.html')) {
    for (const m of src.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
      // 【坑】HTML 里写的是 `/app.js` 这种根相对路径。
      // 直接 path.resolve(fromDir, '/app.js') 会被当成绝对路径解析到盘根（E:\app.js），
      // 于是 public/app.js 被误报成孤儿。必须先剥掉开头的斜杠。
      imported.add(path.resolve(fromDir, m[1].replace(/^\/+/, '')));
    }
  }
}

// 合法入口（不需要被引用）
const ENTRIES = new Set(
  [
    'src/server.mjs',
    'src/cli.mjs',
    'src/doctor.mjs',
    'src/start-public.mjs',
    'src/hash-password.mjs',
    'electron/main.mjs',
    'public/index.html',
    'public/login.html',
    'tools/run-all-tests.mjs',
    'tools/build-desktop.mjs',
    'tools/fetch-electron.mjs',
    'tools/make-icon.mjs',
  ].map((p) => path.resolve(ROOT, p)),
);

const orphans = code.filter((f) => {
  const a = path.resolve(f);
  if (a === path.resolve(SELF)) return false;
  if (ENTRIES.has(a)) return false;
  if (refs.has(a) || imported.has(a)) return false;
  return true;
});

const kb = (f) => (fs.statSync(f).size / 1024).toFixed(1);
const when = (f) => new Date(fs.statSync(f).mtimeMs).toISOString().slice(5, 16).replace('T', ' ');

console.log('='.repeat(88));
console.log('  无任何引用、也非入口的文件');
console.log('='.repeat(88));
if (!orphans.length) {
  console.log('\n  ✅ 没有孤儿文件\n');
} else {
  console.log(`\n  共 ${orphans.length} 个：\n`);
  let total = 0;
  for (const f of orphans.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)) {
    total += fs.statSync(f).size;
    console.log(`  ${kb(f).padStart(6)} KB  ${when(f)}  ${rel(f)}`);
  }
  console.log(`\n  小计 ${(total / 1024).toFixed(0)} KB`);
}

/* 其他可能不需要的：数据产物 / 根目录散落文件 */
console.log('\n' + '='.repeat(88));
console.log('  数据与根目录散落文件');
console.log('='.repeat(88));
const DATA = path.join(ROOT, 'data');
if (fs.existsSync(DATA)) {
  for (const e of fs.readdirSync(DATA, { withFileTypes: true })) {
    const p = path.join(DATA, e.name);
    if (e.isDirectory()) {
      const files = fs.readdirSync(p);
      console.log(`  [目录] data/${e.name}/  ${files.length} 个文件`);
    } else {
      const keep = ['.session-secret', 'font-map.json', 'job-index.json', 'quota.json', 'university-hosts.json'];
      console.log(`  ${kb(p).padStart(6)} KB  ${when(p)}  data/${e.name}${keep.includes(e.name) ? '   ← 运行时必需' : '   ← ⚠️ 不在必需清单里'}`);
    }
  }
}
console.log('\n  根目录：');
for (const f of all.filter((f) => path.dirname(f) === ROOT)) {
  console.log(`  ${kb(f).padStart(6)} KB  ${when(f)}  ${path.basename(f)}`);
}
