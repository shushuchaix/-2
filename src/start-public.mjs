#!/usr/bin/env node
// 一键以「对外可访问」模式启动：
//   - 监听 0.0.0.0
//   - 未设置 AUTH_PASSWORD 时自动生成一个随机强密码并打印
//   - 默认信任反向代理
// 适合快速在局域网/带反代的服务器上把站点跑起来。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

function genPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// 复用已有口令：优先环境变量，其次 .env 文件，最后生成
let password = process.env.AUTH_PASSWORD || '';
let source = '环境变量 AUTH_PASSWORD';

if (!password) {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/^\s*AUTH_PASSWORD\s*=\s*(.+)$/m);
    if (m && m[1].trim()) {
      password = m[1].trim();
      source = '.env 文件';
    }
  }
}

let generated = false;
if (!password) {
  password = genPassword();
  generated = true;
  source = '本次自动生成';
  // 写入 .env，避免重启后口令变化导致所有人被登出
  try {
    const envFile = path.join(ROOT, '.env');
    const line = `AUTH_PASSWORD=${password}\n`;
    if (fs.existsSync(envFile)) {
      const cur = fs.readFileSync(envFile, 'utf8');
      if (!/^\s*AUTH_PASSWORD\s*=/m.test(cur)) fs.appendFileSync(envFile, line, 'utf8');
    } else {
      fs.writeFileSync(envFile, line, 'utf8');
    }
  } catch {
    /* 写不了也不影响运行 */
  }
}

process.env.AUTH_PASSWORD = password;
process.env.HOST = process.env.HOST || '0.0.0.0';
process.env.TRUST_PROXY = process.env.TRUST_PROXY || '1';

console.log('');
console.log('  ┌────────────────────────────────────────────────┐');
console.log('  │  对外访问模式启动                              │');
console.log('  └────────────────────────────────────────────────┘');
console.log('');
console.log(`  访问密码：${password}`);
console.log(`  口令来源：${source}${generated ? '（已写入 .env，下次启动沿用）' : ''}`);
console.log('');
console.log('  ⚠ 请立刻把这个密码记下来，并通过 HTTPS 访问。');
console.log('    应用本身是明文 HTTP，直接暴露公网会让密码与简历内容以明文传输；');
console.log('    请务必放在 nginx / Caddy 之后（见 deploy/ 目录）。');
console.log('');

await import('./server.mjs');
