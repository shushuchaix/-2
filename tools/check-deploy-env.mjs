// 部署环境勘察
import { execSync } from 'node:child_process';
import fs from 'node:fs';

function tryRun(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).toString().trim();
  } catch (e) {
    return `__FAIL__ ${e.message.split('\n')[0]}`;
  }
}

console.log('=== 1. 本地服务状态 ===');
try {
  const r = await fetch('http://127.0.0.1:3210/api/health', { signal: AbortSignal.timeout(5000) });
  const h = await r.json();
  console.log('  运行中 →', h.deepseek?.configured ? 'DeepSeek 已配置' : 'DeepSeek 未配置');
} catch {
  console.log('  未运行');
}

console.log('\n=== 2. 当前监听配置 ===');
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
console.log('  server:', JSON.stringify(cfg.server));
console.log('  auth 字段:', cfg.auth ? JSON.stringify(cfg.auth) : '(不存在 — 需新增)');

console.log('\n=== 3. 容器/部署工具可用性 ===');
for (const [name, cmd] of [
  ['Docker', 'docker --version'],
  ['Docker Compose', 'docker compose version'],
  ['Git', 'git --version'],
  ['nginx', 'nginx -v'],
  ['Caddy', 'caddy version'],
  ['winget', 'winget --version'],
]) {
  const out = tryRun(cmd);
  console.log(`  ${name.padEnd(16)} ${out.startsWith('__FAIL__') ? '不可用' : out.split('\n')[0]}`);
}

console.log('\n=== 4. Node 版本 ===');
console.log('  ', process.version);

console.log('\n=== 5. 本机网络地址（局域网/公网推断）===');
const os = await import('node:os');
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`  ${name}: ${a.address}`);
  }
}

console.log('\n=== 6. 公网出口 IP ===');
try {
  const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  console.log('  ', j.ip);
} catch (e) {
  console.log('  获取失败:', e.message);
}

process.exit(0);
