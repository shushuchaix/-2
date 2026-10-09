// 项目体检：结构 / 体量 / 死代码 / 卫生问题
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(
  dir,
  out = [],
  skip = new Set([
    "node_modules",
    ".git",
    ".npm-cache",
    "dist",
    ".cache",
    ".tmp",
    ".superpowers",
  ]),
) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, skip);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const lines = (p) => {
  try {
    return fs.readFileSync(p, "utf8").split("\n").length;
  } catch {
    return 0;
  }
};

console.log("=".repeat(88));
console.log("  1. 代码体量");
console.log("=".repeat(88));
const src = files.filter(
  (f) => f.endsWith(".mjs") && rel(f).startsWith("src/"),
);
const tools = files.filter(
  (f) => f.endsWith(".mjs") && rel(f).startsWith("tools/"),
);
const pub = files.filter((f) => rel(f).startsWith("public/"));
const totalSrc = src.reduce((a, f) => a + lines(f), 0);
const totalTools = tools.reduce((a, f) => a + lines(f), 0);
console.log(
  `  src/     ${String(src.length).padStart(3)} 文件  ${String(totalSrc).padStart(6)} 行`,
);
console.log(
  `  tools/   ${String(tools.length).padStart(3)} 文件  ${String(totalTools).padStart(6)} 行`,
);
console.log(
  `  public/  ${String(pub.length).padStart(3)} 文件  ${String(pub.reduce((a, f) => a + lines(f), 0)).padStart(6)} 行`,
);

console.log("\n  最大的 12 个源文件：");
for (const f of src.sort((a, b) => lines(b) - lines(a)).slice(0, 12)) {
  console.log(`    ${String(lines(f)).padStart(5)} 行  ${rel(f)}`);
}

console.log("\n" + "=".repeat(88));
console.log("  2. 测试覆盖");
console.log("=".repeat(88));
const tests = tools.filter((f) =>
  /test-|audit-|verify-/.test(path.basename(f)),
);
console.log(
  `  测试类脚本 ${tests.length} 个，共 ${tests.reduce((a, f) => a + lines(f), 0)} 行`,
);
// 每个 src 模块是否被某个测试直接 import
const srcMods = src.map(rel);
const testText = tests.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const untested = srcMods.filter((m) => {
  const base = path.basename(m);
  return !testText.includes(base);
});
console.log(`  没有任何测试直接 import 的 src 模块 ${untested.length} 个：`);
for (const u of untested) console.log(`    ${u}`);

console.log("\n" + "=".repeat(88));
console.log("  3. 死代码：导出了但全项目没人 import 的符号");
console.log("=".repeat(88));
const allText = files
  .filter((f) => /\.(mjs|js|html)$/.test(f))
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n");
const dead = [];
for (const f of src) {
  const t = fs.readFileSync(f, "utf8");
  for (const m of t.matchAll(
    /export (?:async )?function (\w+)|export const (\w+)/g,
  )) {
    const name = m[1] || m[2];
    // 统计除定义处以外的引用
    const uses = (allText.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
    if (uses <= 1) dead.push(`${rel(f)} → ${name}`);
  }
}
console.log(
  dead.length ? dead.map((d) => `    ${d}`).join("\n") : "    （无）",
);

console.log("\n" + "=".repeat(88));
console.log("  4. 数据目录卫生");
console.log("=".repeat(88));
const dataDir = path.join(ROOT, "data");
if (fs.existsSync(dataDir)) {
  const runs = fs.existsSync(path.join(dataDir, "runs"))
    ? fs.readdirSync(path.join(dataDir, "runs"))
    : [];
  const runSize = runs.reduce(
    (a, f) => a + fs.statSync(path.join(dataDir, "runs", f)).size,
    0,
  );
  console.log(
    `  runs/          ${String(runs.length).padStart(3)} 个文件  ${(runSize / 1048576).toFixed(1)} MB`,
  );
  const loose = fs.readdirSync(dataDir).filter((f) => f.startsWith("e2e-"));
  const looseSize = loose.reduce(
    (a, f) => a + fs.statSync(path.join(dataDir, f)).size,
    0,
  );
  console.log(
    `  e2e-*.json     ${String(loose.length).padStart(3)} 个文件  ${(looseSize / 1048576).toFixed(1)} MB  ← 测试产物`,
  );
  console.log(
    `  config.json    ${fs.existsSync(path.join(dataDir, "config.json")) ? "存在（旧版本残留，网页版不读它）" : "不存在"}`,
  );
}

console.log("\n" + "=".repeat(88));
console.log("  5. tools/ 里的一次性脚本");
console.log("=".repeat(88));
const probes = tools.filter((f) =>
  /probe-|diag-|grab-|check-|smoke-|debug-/.test(path.basename(f)),
);
console.log(
  `  probe/diag/一次性脚本 ${probes.length} 个，共 ${probes.reduce((a, f) => a + lines(f), 0)} 行`,
);
const byPrefix = {};
for (const f of probes) {
  const k = path
    .basename(f)
    .replace(/-\d+\.mjs$/, "")
    .replace(/\.mjs$/, "");
  byPrefix[k] = (byPrefix[k] || 0) + 1;
}
const dupes = Object.entries(byPrefix)
  .filter(([, n]) => n > 1)
  .sort((a, b) => b[1] - a[1]);
console.log("  同一主题反复迭代的：");
for (const [k, n] of dupes.slice(0, 12)) console.log(`    ${k}: ${n} 个`);

console.log("\n" + "=".repeat(88));
console.log("  6. 潜在卫生问题");
console.log("=".repeat(88));
// 重复函数定义
const fnDefs = {};
for (const f of src) {
  const t = fs.readFileSync(f, "utf8");
  for (const m of t.matchAll(/^(?:export )?function (\w+)/gm)) {
    (fnDefs[m[1]] ||= []).push(rel(f));
  }
}
const dupFns = Object.entries(fnDefs).filter(([, arr]) => arr.length > 1);
console.log("  同名函数出现在多个文件（可能需要提取共用）：");
for (const [name, arr] of dupFns)
  console.log(`    ${name.padEnd(20)} ${arr.join(", ")}`);

// 硬编码密钥扫描
// 【坑】Tavily 的 key 形如 `tvly-dev-xxxx`（带连字符）——
// 字符集不包含连字符的正则会**漏报真实格式的 key**。这里统一用宽松字符集。
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/, // DeepSeek
  /tvly-[A-Za-z0-9_-]{20,}/, // Tavily（含 tvly-dev-）
  /bsa-[A-Za-z0-9_-]{20,}/, // 博查
];
const secretHits = [];
for (const f of files.filter(
  (f) => /\.(mjs|js|json|md)$/.test(f) && !rel(f).startsWith("dist/"),
)) {
  const t = fs.readFileSync(f, "utf8");
  for (const re of SECRET_PATTERNS) {
    for (const m of t.matchAll(new RegExp(re, "g"))) {
      secretHits.push(`${rel(f)} → ${m[0].slice(0, 14)}…`);
    }
  }
}
console.log("\n  硬编码密钥扫描：", secretHits.length ? "" : "✅ 未发现");
for (const h of secretHits) console.log(`    ⚠️ ${h}`);

// 超长文件预警
console.log("\n  超过 800 行的文件（维护性预警）：");
const long = files.filter(
  (f) =>
    /\.(mjs|md|css|js)$/.test(f) &&
    !rel(f).startsWith("dist/") &&
    lines(f) > 800,
);
for (const f of long.sort((a, b) => lines(b) - lines(a)))
  console.log(`    ${String(lines(f)).padStart(5)} 行  ${rel(f)}`);

// TODO / FIXME
const todos = [];
for (const f of files.filter((f) => f.endsWith(".mjs"))) {
  const t = fs.readFileSync(f, "utf8");
  for (const m of t.matchAll(/(TODO|FIXME|XXX|HACK)[:：]?\s*(.{0,60})/g))
    todos.push(`${rel(f)}: ${m[1]} ${m[2].trim()}`);
}
console.log("\n  TODO/FIXME 标记：", todos.length || "（无）");
for (const t of todos.slice(0, 8)) console.log(`    ${t}`);
