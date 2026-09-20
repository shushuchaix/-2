// 桌面外壳自检（不启动 Electron，进程内起服务跑同一套断言）
//
// 为什么不用 Electron 跑：Electron 需要图形环境与更宽的沙箱权限，
// 在受限环境里会因为 ACCESS_VIOLATION 直接崩溃，而崩溃原因与应用本身无关。
// 这里把「Electron 外壳会做的检查」在 Node 里等价复现一遍，覆盖真正容易出问题的部分：
//   - 桌面模式的环境变量与数据目录重定向
//   - 内置 HTTP 服务的静态资源与 API
//   - PDF 文本提取（pdfjs 是 ESM + 动态 import，打包后最容易坏的就是它）
//   - 打包产物 asar 里代码是否齐全、敏感文件是否被排除
//
// 想验真实窗口，直接双击 exe，或运行 `简历岗位雷达.exe --self-test`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`);
  }
};

/* ---------- 模拟桌面外壳的运行环境（必须在 import src 之前设置） ---------- */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjr-desktop-'));
const PORT = 3422;
process.env.RJR_DESKTOP = '1';
process.env.RJR_DATA_DIR = dataDir;
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
delete process.env.AUTH_PASSWORD;
delete process.env.ALLOW_PUBLIC_NO_AUTH;

console.log('\n=== 桌面外壳自检（Node 内等价复现） ===\n');
console.log(`  数据目录：${dataDir}`);
console.log(`  应用根目录：${ROOT}\n`);

const appUrl = `http://127.0.0.1:${PORT}`;
let server;

try {
  const { startServer } = await import('../src/server.mjs');
  const { DATA_ROOT, IS_DESKTOP, ensureDataDirs } = await import('../src/config.mjs');
  ensureDataDirs();

  server = startServer().server;
  await new Promise((r) => server.once('listening', r));

  check('标记为桌面模式', IS_DESKTOP === true);
  check('数据目录已重定向', DATA_ROOT === dataDir, DATA_ROOT);
  check('内置服务监听本机端口', /^http:\/\/127\.0\.0\.1:\d+$/.test(appUrl), appUrl);

  const page = await fetch(`${appUrl}/`);
  const html = await page.text();
  check(
    '首页可访问且内容正确',
    page.status === 200 && html.includes('简历岗位雷达'),
    `HTTP ${page.status}, ${html.length} 字节`,
  );

  const s = await (await fetch(`${appUrl}/api/session`)).json();
  check('会话接口标记 desktop=true', s.desktop === true);
  check('桌面模式免登录', s.authRequired === false, `authRequired=${s.authRequired}`);
  check('会话接口返回数据目录', s.dataDir === dataDir, String(s.dataDir));
  check('返回 DeepSeek 配置状态', typeof s.deepseekConfigured === 'boolean', `deepseekConfigured=${s.deepseekConfigured}`);

  for (const f of ['/app.js', '/style.css', '/login.js', '/login']) {
    const r = await fetch(`${appUrl}${f}`);
    check(`静态资源 ${f}`, r.status === 200, `HTTP ${r.status}`);
  }

  const h = await (await fetch(`${appUrl}/api/health`)).json();
  check('/api/health 正常', h.ok === true && Boolean(h.version), `version=${h.version}`);

  const probe = path.join(dataDir, '.write-probe');
  fs.writeFileSync(probe, 'ok', 'utf8');
  const wrote = fs.readFileSync(probe, 'utf8') === 'ok';
  fs.rmSync(probe, { force: true });
  check('数据目录可写', wrote, dataDir);

  check('应用图标存在', fs.existsSync(path.join(ROOT, 'build', 'icon.ico')));
  check('配置文件已就位', fs.existsSync(path.join(dataDir, 'config.json')), path.join(dataDir, 'config.json'));

  /* ---------- PDF 提取：打包后最容易坏的一环 ---------- */
  const { extractResumeText } = await import('../src/resume/extract-text.mjs');
  const pdfBuf = makeTestPdf([
    'Zhang Ming',
    'Java Spring Boot MySQL Redis Docker',
    'Beijing University of Posts and Telecommunications',
  ]);
  const parsed = await extractResumeText(pdfBuf, 'self-test.pdf');
  check(
    'PDF 文本提取可用（验证 pdfjs 能正常加载）',
    parsed.format === 'pdf' && /Spring/.test(parsed.text),
    `提取 ${parsed.text.length} 字：${parsed.text.replace(/\s+/g, ' ').slice(0, 46)}`,
  );

  /* ---------- 打包产物检查（如果在 dist 下找到 exe） ---------- */
  const asarPath = path.join(ROOT, 'dist', '简历岗位雷达-win32-x64', 'resources', 'app.asar');
  if (fs.existsSync(asarPath)) {
    const buf = fs.readFileSync(asarPath);
    const jsonLen = buf.readUInt32LE(12);
    const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));
    const walk = (node, prefix = '', out = []) => {
      for (const [name, v] of Object.entries(node.files || {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (v.files) walk(v, full, out);
        else out.push(full);
      }
      return out;
    };
    const files = walk(header);
    const str = buf.toString('latin1');

    check('打包产物含高校就业网适配器', files.includes('src/sources/university.mjs'));
    check('打包产物含自动选校逻辑', str.includes('resolveHosts'));
    check(
      '打包产物不含 config.json / .env',
      !files.some((f) => /^config\.json$|^\.env$|credentials\.yaml$/.test(f)),
    );
    check('打包产物不含真实密钥', !/sk-[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9]{20,}/.test(str));
  } else {
    console.log('  ℹ️  未找到 dist 打包产物，跳过打包检查（先跑 npm run dist:desktop）');
  }
} catch (e) {
  check('自检执行', false, e.message);
  if (process.env.DEBUG) console.error(e.stack);
} finally {
  if (server) server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

/** 手工拼一个最小可解析的 PDF，避免为自检引入二进制测试文件 */
function makeTestPdf(lines) {
  const content = lines.map((l, i) => `BT /F1 12 Tf 40 ${740 - i * 20} Td (${l}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((o, i) => {
    offsets[i + 1] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'='.repeat(60)}\n`);
process.exit(fail === 0 ? 0 : 1);
