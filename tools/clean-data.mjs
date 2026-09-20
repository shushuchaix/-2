// 数据目录维护：清理测试产物 + runs 保留策略
// 用法：node tools/clean-data.mjs [--dry-run] [--keep=20]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const DRY = process.argv.includes('--dry-run');
const KEEP = Number((process.argv.find((a) => a.startsWith('--keep=')) || '').split('=')[1]) || 20;

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
let freed = 0;
const actions = [];

function remove(p, why) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  const size = st.isDirectory() ? dirSize(p) : st.size;
  actions.push({ p: path.relative(ROOT, p).replace(/\\/g, '/'), size, why });
  freed += size;
  if (!DRY) fs.rmSync(p, { recursive: true, force: true });
}

function dirSize(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}

console.log(`\n=== 数据目录维护 ${DRY ? '（试运行，不实际删除）' : ''} ===\n`);

/* 1. 测试产物：e2e-*.json 是我这几轮端到端跑出来的中间结果，不是用户数据 */
if (fs.existsSync(DATA)) {
  for (const f of fs.readdirSync(DATA)) {
    if (/^e2e-.*\.json$/.test(f)) remove(path.join(DATA, f), '端到端测试产物');
  }
}

/* 2. 过期上传：uploads/ 里超过 7 天的简历原文 */
const uploads = path.join(DATA, 'uploads');
if (fs.existsSync(uploads)) {
  const cutoff = Date.now() - 7 * 864e5;
  for (const f of fs.readdirSync(uploads)) {
    const p = path.join(uploads, f);
    if (fs.statSync(p).mtimeMs < cutoff) remove(p, '7 天前的上传简历');
  }
}

/* 3. runs 保留策略：只留最近 N 次 */
const runs = path.join(DATA, 'runs');
if (fs.existsSync(runs)) {
  const files = fs
    .readdirSync(runs)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: fs.statSync(path.join(runs, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of files.slice(KEEP)) remove(path.join(runs, f), `超出保留数（保留最近 ${KEEP} 次）`);
}

/* 4. 旧版残留：data/config.json 是早期版本生成的，网页版读的是根目录 config.json，它会误导人 */
const strayConfig = path.join(DATA, 'config.json');
if (fs.existsSync(strayConfig)) {
  remove(strayConfig, '旧版本残留（网页版读根目录的 config.json，这份不生效）');
}

/* ---------- 报告 ---------- */
if (!actions.length) {
  console.log('  ✅ 无需清理\n');
} else {
  const byWhy = {};
  for (const a of actions) {
    byWhy[a.why] = byWhy[a.why] || { n: 0, size: 0 };
    byWhy[a.why].n++;
    byWhy[a.why].size += a.size;
  }
  for (const [why, v] of Object.entries(byWhy)) {
    console.log(`  ${DRY ? '将删除' : '已删除'} ${String(v.n).padStart(3)} 项  ${mb(v.size).padStart(9)}  ${why}`);
  }
  console.log(`\n  合计释放 ${mb(freed)}`);
  if (DRY) console.log('  （这是试运行；去掉 --dry-run 才会真的删）');
  console.log('');
}
