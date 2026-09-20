// 检查 package.json 的脚本键是否有重复（JSON.parse 会静默去重，必须扫原文）
import fs from 'node:fs';

const t = fs.readFileSync('package.json', 'utf8');
const keys = [...t.matchAll(/^\s{4}"([a-zA-Z0-9:_-]+)":/gm)].map((m) => m[1]);
const seen = new Set();
const dup = [];
for (const k of keys) {
  if (seen.has(k)) dup.push(k);
  seen.add(k);
}
console.log(`  脚本键 ${keys.length} 个`);
console.log(dup.length ? `  ❌ 重复: ${[...new Set(dup)].join(', ')}` : '  ✅ 无重复键');

// 顺带确认每个 test:* 脚本指向的文件真的存在
const o = JSON.parse(t);
const missing = [];
for (const [name, cmd] of Object.entries(o.scripts)) {
  const m = cmd.match(/node\s+(tools\/[\w.-]+\.mjs)/);
  if (m && !fs.existsSync(m[1])) missing.push(`${name} → ${m[1]}`);
}
console.log(missing.length ? `  ❌ 指向不存在的文件:\n     ${missing.join('\n     ')}` : '  ✅ 所有脚本指向的文件都存在');

process.exit(dup.length || missing.length ? 1 : 0);
