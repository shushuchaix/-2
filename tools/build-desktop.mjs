// 打包 Windows 免安装桌面版（自研打包流程）
//
// 为什么不用 @electron/packager：
//   它内部用 extract-zip 解压 Electron，而该库在本机环境下会「创建第一个目录后永久卡住」
//   （当时用隔离复现脚本确认过：提权后依然如此，与沙箱无关；该脚本已在后续清理中移除）。
//   本脚本改用自研解压器（1.6 秒完成同一压缩包），其余步骤（asar、图标、版本信息）
//   都用纯 JS 的 @electron/asar 与 resedit 完成，无子进程依赖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractZip } from "./lib/unzip.mjs";
import * as asar from "@electron/asar";
import { NtExecutable, NtExecutableResource, Data, Resource } from "resedit";
import { buildUi } from "./build-ui.mjs";
import { copyBundledResources } from "./lib/bundled-resources.mjs";
import {
  prodClosure,
  validateUiAssets,
  verifyPackageArchive,
  PUBLIC_RUNTIME_FILES,
} from "./verify-package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CACHE = path.join(ROOT, ".cache", "electron");
const TMP = path.join(ROOT, ".tmp");
const EXTRACT_TEST = path.join(DIST, "extract-test");

const APP_NAME = "简历岗位雷达";
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const electronVersion = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "node_modules", "electron", "package.json"),
    "utf8",
  ),
).version;

// 扫描 PDF 的 OCR 依赖原生 canvas；生产依赖保留并解包到真实路径。

const OUT_DIR = path.join(DIST, `${APP_NAME}-win32-x64`);
const EXE_NAME = `${APP_NAME}.exe`;

/* ------------------------------ 工具 ------------------------------ */
let step = 0;
const totalSteps = 6;
function stage(label) {
  step++;
  console.log(`\n  [${step}/${totalSteps}] ${label}`);
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      copyRecursive(path.join(src, e.name), path.join(dest, e.name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/* ------------------------------ 前置检查 ------------------------------ */
console.log("\n=== 打包桌面版（免安装便携版）===\n");
await buildUi();
const uiAssets = validateUiAssets({ root: ROOT });
console.log(
  `  已验证界面入口、${uiAssets.js.length} 个 JS 和 ${uiAssets.css.length} 个 CSS 资源`,
);

const checks = [
  [
    "Electron 运行时",
    path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
    "node tools/fetch-electron.mjs",
  ],
  [
    "应用图标",
    path.join(ROOT, "build", "icon.ico"),
    "node tools/make-icon.mjs",
  ],
  [
    "Electron 压缩包",
    path.join(CACHE, `electron-v${electronVersion}-win32-x64.zip`),
    "node tools/fetch-electron.mjs",
  ],
];
let missing = false;
for (const [label, p, fix] of checks) {
  const ok = fs.existsSync(p);
  console.log(
    `  ${ok ? "✅" : "❌"} ${label}${ok ? "" : `  → 请先执行：${fix}`}`,
  );
  if (!ok) missing = true;
}
if (missing) {
  console.error("\n  缺少必要前置产物，已终止。\n");
  process.exit(1);
}

console.log(`\n  应用：${APP_NAME} v${pkg.version}`);
console.log(`  Electron：v${electronVersion}`);
console.log(`  输出：${path.relative(ROOT, OUT_DIR)}`);

const t0 = Date.now();

/* ------------------------------ 1. 清理 ------------------------------ */
stage("清理输出目录");
for (const target of [OUT_DIR, TMP, EXTRACT_TEST])
  if (
    !path.resolve(target).startsWith(path.resolve(ROOT) + path.sep) ||
    path.resolve(target) === path.resolve(ROOT)
  )
    throw Error("Unsafe build cleanup path");
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
console.log("      完成");

/* ------------------------------ 2. 解压 Electron ------------------------------ */
stage("解压 Electron 运行时");
{
  const zip = path.join(CACHE, `electron-v${electronVersion}-win32-x64.zip`);
  const t = Date.now();
  const r = extractZip(zip, OUT_DIR, (done, total) => {
    if (done % 25 === 0 || done === total)
      process.stdout.write(`\r      解压 ${done}/${total}   `);
  });
  process.stdout.write("\r" + " ".repeat(40) + "\r");
  console.log(
    `      ${r.files} 个文件，耗时 ${((Date.now() - t) / 1000).toFixed(1)}s`,
  );
}

/* ------------------------------ 3. 重命名主程序并清理 ------------------------------ */
stage("重命名主程序并精简语言包");
{
  const from = path.join(OUT_DIR, "electron.exe");
  const to = path.join(OUT_DIR, EXE_NAME);
  if (!fs.existsSync(from)) throw new Error(`解压结果里没有 electron.exe`);
  fs.renameSync(from, to);
  // 带上 LICENSE，符合 Electron 的分发要求
  const lic = path.join(ROOT, "node_modules", "electron", "LICENSE");
  if (fs.existsSync(lic))
    fs.copyFileSync(lic, path.join(OUT_DIR, "LICENSE.electron.txt"));
  console.log(`      ${EXE_NAME} ${mb(fs.statSync(to).size)}`);

  // 界面只有中文，其余 52 个语言包纯属浪费（约 42MB）
  const localesDir = path.join(OUT_DIR, "locales");
  const KEEP = new Set(["zh-CN.pak", "zh-TW.pak", "en-US.pak", "en-GB.pak"]);
  if (fs.existsSync(localesDir)) {
    const all = fs.readdirSync(localesDir);
    let freed = 0;
    let removed = 0;
    for (const f of all) {
      if (KEEP.has(f)) continue;
      const p = path.join(localesDir, f);
      freed += fs.statSync(p).size;
      fs.rmSync(p, { force: true });
      removed++;
    }
    console.log(
      `      语言包 ${all.length} → ${all.length - removed} 个，释放 ${mb(freed)}`,
    );
  }
}

/* ------------------------------ 4. 组装 app.asar ------------------------------ */
stage("打包应用代码为 app.asar");
{
  const appStage = path.join(TMP, "app");
  fs.mkdirSync(appStage, { recursive: true });

  // 精简过的 package.json：去掉 devDependencies 与只在源码态可用的脚本
  const slimPkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: pkg.type,
    description: pkg.description,
    main: pkg.main,
    dependencies: pkg.dependencies,
  };
  fs.writeFileSync(
    path.join(appStage, "package.json"),
    JSON.stringify(slimPkg, null, 2),
    "utf8",
  );

  // 应用代码
  for (const item of ["electron", "src", "build"]) {
    copyRecursive(path.join(ROOT, item), path.join(appStage, item));
  }
  copyRecursive(
    path.join(ROOT, "public/app"),
    path.join(appStage, "public/app"),
  );
  for (const rel of PUBLIC_RUNTIME_FILES)
    copyRecursive(
      path.join(ROOT, "public", rel),
      path.join(appStage, "public", rel),
    );
  for (const file of ["config.example.json", "README.md"]) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appStage, file));
  }

  // 生产依赖
  const closure = prodClosure({ root: ROOT });
  for (const name of closure) {
    copyRecursive(
      path.join(ROOT, "node_modules", name),
      path.join(appStage, "node_modules", name),
    );
  }
  console.log(`      依赖：${closure.join(", ")}`);
  console.log(`      暂存大小 ${mb(dirSize(appStage))}`);

  const asarPath = path.join(OUT_DIR, "resources", "app.asar");
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  await asar.createPackageWithOptions(appStage, asarPath, {
    unpackDir: "node_modules",
  });
  const resources = await copyBundledResources({
    project: ROOT,
    resourcesRoot: path.dirname(asarPath),
    appRoot: appStage,
  });
  console.log(
    `      独立运行时 ${resources.runtime} 文件；OCR 哈希清单 ${resources.ocr} 文件`,
  );
  console.log(`      app.asar ${mb(fs.statSync(asarPath).size)}`);

  // Electron 自带的默认应用包必须移除，否则会干扰
  fs.rmSync(path.join(OUT_DIR, "resources", "default_app.asar"), {
    force: true,
  });

  // 安全校验：asar 里绝不能出现密钥文件
  const listed = asar.listPackage(asarPath);
  const leaked = listed.filter((p) =>
    /(^|[\\/])(config\.json|\.env|\.credentials\.yaml)$/.test(p),
  );
  if (leaked.length)
    throw new Error(`app.asar 里出现了敏感文件：${leaked.join(", ")}`);
  console.log("      ✅ 已确认不包含 config.json / .env 等敏感文件");
  const verified = verifyPackageArchive({ archivePath: asarPath, root: ROOT });
  console.log(
    `      ✅ 已验证真实界面资产、${verified.dependencies.length} 个生产依赖及运行文件排除`,
  );
}

/* ------------------------------ 5. 写入图标与版本信息 ------------------------------ */
stage("写入图标与版本信息");
{
  const exePath = path.join(OUT_DIR, EXE_NAME);
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  // 图标
  const iconFile = Data.IconFile.from(
    fs.readFileSync(path.join(ROOT, "build", "icon.ico")),
  );
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033,
    iconFile.icons.map((i) => i.data),
  );
  console.log(`      图标 ${iconFile.icons.length} 个尺寸`);

  // 版本信息
  const [maj, min, pat] = String(pkg.version)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const vi = Resource.VersionInfo.createEmpty();
  vi.setFileVersion(maj, min, pat, 0);
  vi.setProductVersion(maj, min, pat, 0);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      ProductName: APP_NAME,
      FileDescription: "简历岗位雷达 —— 简历关键词驱动的校招/实习岗位检索工具",
      CompanyName: "Resume Job Radar",
      InternalName: "ResumeJobRadar",
      OriginalFilename: EXE_NAME,
      LegalCopyright: "For personal job-seeking use",
      FileVersion: pkg.version,
      ProductVersion: pkg.version,
    },
  );
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`      版本 ${pkg.version}、产品名已写入`);
}

/* ------------------------------ 6. 校验与收尾 ------------------------------ */
stage("校验产物");
{
  const exePath = path.join(OUT_DIR, EXE_NAME);
  const asarPath = path.join(OUT_DIR, "resources", "app.asar");
  const problems = [];

  if (!fs.existsSync(exePath)) problems.push("缺少主程序");
  if (!fs.existsSync(asarPath)) problems.push("缺少 app.asar");
  if (fs.existsSync(path.join(OUT_DIR, "resources", "default_app.asar")))
    problems.push("default_app.asar 未清理");

  // 校验 exe 内确实写入了版本信息
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const vis = Resource.VersionInfo.fromEntries(res.entries);
  const productName = vis[0]?.getStringValues({
    lang: 1033,
    codepage: 1200,
  })?.ProductName;
  if (productName !== APP_NAME)
    problems.push(`版本信息未写入（读到 ProductName=${productName}）`);
  else console.log(`      ✅ exe 版本信息：${productName}`);

  const sizes = {
    exe: fs.statSync(exePath).size,
    asar: fs.statSync(asarPath).size,
    total: dirSize(OUT_DIR),
  };
  if (problems.length) {
    console.error(`\n  ❌ ${problems.join("；")}\n`);
    process.exit(1);
  }

  console.log(`      ✅ 目录结构完整（${fs.readdirSync(OUT_DIR).length} 项）`);
  console.log(
    `      exe ${mb(sizes.exe)} ｜ app.asar ${mb(sizes.asar)} ｜ 整包 ${mb(sizes.total)}`,
  );
}

// 收尾
fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(EXTRACT_TEST, {
  recursive: true,
  force: true,
});

console.log(`\n  ✅ 打包完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(
  `\n  可执行文件：${path.relative(ROOT, path.join(OUT_DIR, EXE_NAME))}`,
);
console.log(
  `  整个 ${path.relative(ROOT, OUT_DIR)} 目录即为免安装版，可整体拷贝到任意 Windows 电脑。`,
);
console.log(`  双击 ${EXE_NAME} 即可运行，无需安装 Node.js。\n`);
