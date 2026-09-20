// 下载并安装 Electron 运行时二进制
//
// 背景：electron 包的 postinstall（install.js）在本沙箱环境下会「静默失败但退出码为 0」，
// 且它读取的环境变量名是 electron_config_cache 而非 ELECTRON_CACHE，容易踩坑。
// 这里改为自己下载 + 自研解压，行为完全可控，并把 zip 留在本地供打包器复用。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extractZip } from './lib/unzip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_PKG = path.join(ROOT, 'node_modules', 'electron');
const CACHE_DIR = path.join(ROOT, '.cache', 'electron');

const MIRRORS = [
  (v) => `https://npmmirror.com/mirrors/electron/${v}/electron-v${v}-win32-x64.zip`,
  (v) => `https://registry.npmmirror.com/-/binary/electron/${v}/electron-v${v}-win32-x64.zip`,
  (v) => `https://github.com/electron/electron/releases/download/v${v}/electron-v${v}-win32-x64.zip`,
];

function human(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastPrint = 0;

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastPrint > 700) {
      lastPrint = now;
      const pct = total ? ((received / total) * 100).toFixed(0) : '?';
      process.stdout.write(`\r  下载中 ${pct}%  ${human(received)}${total ? ' / ' + human(total) : ''}   `);
    }
  });

  await pipeline(body, fs.createWriteStream(dest));
  process.stdout.write(`\r  下载完成  ${human(received)}${' '.repeat(30)}\n`);
  return received;
}

/* ---------------- 主流程 ---------------- */
if (!fs.existsSync(ELECTRON_PKG)) {
  console.error('未找到 node_modules/electron，请先执行：npm install');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(ELECTRON_PKG, 'package.json'), 'utf8')).version;
const distDir = path.join(ELECTRON_PKG, 'dist');
const marker = path.join(distDir, 'electron.exe');

console.log(`\n=== Electron 运行时安装（v${version}）===`);

if (fs.existsSync(marker) && fs.existsSync(path.join(ELECTRON_PKG, 'path.txt'))) {
  console.log(`  ✅ 已安装：${marker}`);
  console.log(`     大小 ${human(fs.statSync(marker).size)}\n`);
  process.exit(0);
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
const zipPath = path.join(CACHE_DIR, `electron-v${version}-win32-x64.zip`);

if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 100 * 1024 * 1024) {
  console.log(`  使用已缓存压缩包 ${zipPath}（${human(fs.statSync(zipPath).size)}）`);
} else {
  let ok = false;
  for (const [i, mirror] of MIRRORS.entries()) {
    const url = mirror(version);
    console.log(`  源 ${i + 1}/${MIRRORS.length}：${url}`);
    try {
      await download(url, zipPath);
      ok = true;
      break;
    } catch (e) {
      console.log(`    失败：${e.message}`);
      fs.rmSync(zipPath, { force: true });
    }
  }
  if (!ok) {
    console.error('\n  ❌ 所有下载源均失败\n');
    process.exit(1);
  }
}

console.log(`\n  解压到 ${path.relative(ROOT, distDir)} …`);
fs.rmSync(distDir, { recursive: true, force: true });
const t0 = Date.now();
try {
  const r = extractZip(zipPath, distDir, (done, total, current) => {
    if (done % 20 === 0 || done === total) {
      process.stdout.write(`\r  解压 ${done}/${total}  ${current.slice(0, 40).padEnd(42)}`);
    }
  });
  process.stdout.write('\r' + ' '.repeat(70) + '\r');
  console.log(`  ✅ 解压完成：${r.files} 个文件，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error(`\n  ❌ 解压失败：${e.message}\n`);
  process.exit(1);
}

// install.js 依赖 path.txt 定位可执行文件
fs.writeFileSync(path.join(ELECTRON_PKG, 'path.txt'), 'electron.exe');

if (!fs.existsSync(marker)) {
  console.error(`\n  ❌ 解压后未找到 ${marker}\n`);
  process.exit(1);
}

console.log(`  ✅ electron.exe ${human(fs.statSync(marker).size)}`);
console.log(`  ✅ 已写入 path.txt`);
console.log(`\n  压缩包保留在 ${path.relative(ROOT, zipPath)}，打包器可直接复用（electronZipDir）\n`);
