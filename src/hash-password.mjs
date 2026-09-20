#!/usr/bin/env node
// 生成 config.json 用的密码哈希
// 用法：npm run hash-password -- "你的密码"
import { hashPassword } from './auth.mjs';

const password = process.argv.slice(2).join(' ').trim();

if (!password) {
  console.error('\n用法：npm run hash-password -- "你的密码"\n');
  console.error('生成后把结果填到 config.json 的 auth.passwordHash 字段。');
  console.error('更简单的方式是直接用环境变量 AUTH_PASSWORD=你的密码 启动。\n');
  process.exit(1);
}
if (password.length < 8) {
  console.error('\n建议密码至少 8 位。\n');
  process.exit(1);
}

const hash = hashPassword(password);
console.log('\n把下面这一行填到 config.json 的 auth.passwordHash：\n');
console.log(hash);
console.log('\n或者用环境变量启动（更推荐，避免密码写进文件）：');
console.log('  set AUTH_PASSWORD=' + password + ' && npm start        (Windows)');
console.log('  AUTH_PASSWORD=' + password + ' npm start                (macOS/Linux)\n');
