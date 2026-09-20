// 从 Windows 回收站恢复 E:\简历脚本
//
// 回收站里 $I<ID><ext> 是元数据（内含原始路径），$R<ID><ext> 是实际内容。
// 默认只做演练（--dry），确认真实路径无误后再加 --apply 执行。
import fs from 'node:fs';
import path from 'node:path';

const RECYCLE = 'E:\\$RECYCLE.BIN\\S-1-5-21-3977033360-1255995190-1098039860-1001';
const TARGET_ROOT = 'E:\\简历脚本';
const APPLY = process.argv.includes('--apply');

/** 解析 $I 元数据：返回 { originalPath, deletedAt, size } */
function parseIFile(file) {
  const buf = fs.readFileSync(file);
  const version = buf.readBigUInt64LE(0);
  const size = buf.readBigUInt64LE(8);
  const filetime = buf.readBigUInt64LE(16);
  // FILETIME → JS Date（100ns since 1601-01-01）
  const epoch1601 = 116444736000000000n;
  const deletedAt = new Date(Number((filetime - epoch1601) / 10000n));
  // 版本 2：偏移 24 是字符数，28 起为 UTF-16LE 路径
  let originalPath = '';
  if (version === 2n) {
    const chars = buf.readUInt32LE(24);
    originalPath = buf.toString('utf16le', 28, 28 + (chars - 1) * 2);
  } else {
    originalPath = buf.toString('utf16le', 24).replace(/\0+$/, '');
  }
  return { version, size: Number(size), deletedAt, originalPath };
}

const entries = fs
  .readdirSync(RECYCLE)
  .filter((n) => n.startsWith('$I'))
  .map((name) => {
    const iPath = path.join(RECYCLE, name);
    const rName = '$R' + name.slice(2);
    const rPath = path.join(RECYCLE, rName);
    let meta = null;
    try {
      meta = parseIFile(iPath);
    } catch (e) {
      meta = { error: e.message };
    }
    const exists = fs.existsSync(rPath);
    let kind = '缺失';
    let detail = '';
    if (exists) {
      const st = fs.statSync(rPath);
      kind = st.isDirectory() ? '目录' : '文件';
      detail = st.isDirectory() ? `${fs.readdirSync(rPath).length} 项` : `${st.size} 字节`;
    }
    return { name, rName, rPath, exists, kind, detail, ...meta };
  })
  .filter((e) => e.originalPath);

entries.sort((a, b) => a.originalPath.localeCompare(b.originalPath));

console.log(`\n回收站条目：${entries.length} 个\n`);
console.log('原始路径'.padEnd(52) + '类型'.padEnd(6) + '内容'.padEnd(12) + '删除时间');
console.log('─'.repeat(100));
for (const e of entries) {
  console.log(
    e.originalPath.padEnd(52) +
      e.kind.padEnd(6) +
      e.detail.padEnd(12) +
      (e.deletedAt instanceof Date && !isNaN(e.deletedAt) ? e.deletedAt.toLocaleString('zh-CN') : '?'),
  );
}

// 安全检查：所有路径都必须在目标工作区内
const outside = entries.filter((e) => !e.originalPath.startsWith(TARGET_ROOT));
console.log('');
if (outside.length) {
  console.log('⚠ 有条目不在目标工作区内，已跳过：');
  outside.forEach((e) => console.log('   ' + e.originalPath));
} else {
  console.log('✅ 全部条目的原始路径都在 ' + TARGET_ROOT + ' 内');
}

const restorable = entries.filter((e) => e.exists && e.originalPath.startsWith(TARGET_ROOT));
const totalFiles = restorable.reduce((n, e) => {
  if (e.kind === '文件') return n + 1;
  const count = (dir) => {
    let c = 0;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) c += count(path.join(dir, item.name));
      else c++;
    }
    return c;
  };
  return n + count(e.rPath);
}, 0);

console.log(`\n可恢复：${restorable.length} 个条目，合计约 ${totalFiles} 个文件`);

if (!APPLY) {
  console.log('\n【演练模式】未做任何改动。确认无误后执行：');
  console.log('  node tools/recover-recycle.mjs --apply\n');
  process.exit(0);
}

console.log('\n开始恢复…\n');
let okFiles = 0;
let skipped = 0;

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
      copyRecursive(path.join(src, item.name), path.join(dest, item.name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  okFiles++;
}

for (const e of restorable) {
  try {
    copyRecursive(e.rPath, e.originalPath);
    console.log(`  ✅ 恢复 ${e.originalPath.replace(TARGET_ROOT, '.')}`);
  } catch (err) {
    skipped++;
    console.log(`  ❌ 失败 ${e.originalPath} — ${err.message}`);
  }
}

console.log(`\n完成：恢复 ${okFiles} 个文件，失败 ${skipped} 项\n`);
