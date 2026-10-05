// 校验部署资产：compose YAML 可解析、Dockerfile 引用的路径真实存在、配置项与代码一致
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from '../src/config.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`);
  }
};

/* ---------- 1. docker-compose.yml ---------- */
console.log('\n=== 1. docker-compose.yml ===');
const composePath = path.join(ROOT, 'docker-compose.yml');
const composeText = fs.readFileSync(composePath, 'utf8');

let compose = null;
try {
  // 复用 DSH 自带的 js-yaml（本项目的依赖里没有 YAML 库）
  const require = createRequire(import.meta.url);
  const candidates = [
    'C:/Users/31069/.dsh/profiles/node_modules/js-yaml/index.js',
    'js-yaml',
  ];
  let yaml = null;
  for (const c of candidates) {
    try {
      yaml = require(c);
      break;
    } catch {
      /* 试下一个 */
    }
  }
  if (!yaml) throw new Error('未找到 js-yaml');
  compose = yaml.load(composeText);
  check('YAML 解析成功', typeof compose === 'object' && compose !== null);
} catch (e) {
  check('YAML 解析成功', false, e.message);
}

if (compose) {
  const svc = compose.services?.radar;
  check('定义了 radar 服务', Boolean(svc));
  check('配置了 .env 文件', (svc.env_file || []).includes('.env'));
  check('挂载了 data 卷（保留历史与字体缓存）', (svc.volumes || []).some((v) => String(v).includes('./data:/app/data')));
  check(
    '端口只发布到 127.0.0.1（强制走反代，避免明文传输密码）',
    (svc.ports || []).every((p) => String(p).startsWith('127.0.0.1:')),
    JSON.stringify(svc.ports),
  );
  check('设置了 TRUST_PROXY=1', svc.environment?.TRUST_PROXY === '1');
  check('设置了自动重启', svc.restart === 'unless-stopped');
  check('限制了日志体积（防止磁盘被写满）', Boolean(svc.logging?.options?.['max-size']));
}

/* ---------- 2. Dockerfile ---------- */
console.log('\n=== 2. Dockerfile ===');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

check('使用 node 官方镜像', /^FROM\s+node:/m.test(dockerfile));
check('设置了 NODE_ENV=production', dockerfile.includes('NODE_ENV=production'));
check('默认监听 0.0.0.0', dockerfile.includes('HOST=0.0.0.0'));
check('默认信任反代（容器必然在反代/平台之后）', dockerfile.includes('TRUST_PROXY=1'));
check('以非 root 用户运行', /^USER\s+node/m.test(dockerfile));
check('声明了 VOLUME', /^VOLUME/m.test(dockerfile));
check('配置了 HEALTHCHECK', /^HEALTHCHECK/m.test(dockerfile));
check('安装依赖时省略 devDependencies', dockerfile.includes('--omit=dev'));

// COPY 的源路径必须真实存在
const copySources = [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*(\S+)/gm)].map((m) => m[1]);
for (const src of copySources) {
  if (src.includes('*')) continue;
  check(`COPY 源路径存在：${src}`, fs.existsSync(path.join(ROOT, src)));
}
check(
  '未把 config.json / .env 拷进镜像（避免密钥泄漏）',
  !copySources.includes('config.json') && !copySources.includes('.env'),
);

/* ---------- 3. .dockerignore ---------- */
console.log('\n=== 3. .dockerignore ===');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
for (const must of ['node_modules', 'data', 'config.json', '.env']) {
  check(`排除了 ${must}`, dockerignore.split('\n').some((l) => l.trim() === must));
}

/* ---------- 4. .env.example 与代码读取的环境变量是否对齐 ---------- */
console.log('\n=== 4. 环境变量一致性 ===');
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const documented = new Set(
  [...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/gm)].map((m) => m[1]),
);

const configSrc = fs.readFileSync(path.join(ROOT, 'src', 'config.mjs'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
const allSrc = configSrc + '\n' + serverSrc;

/**
 * 判断代码是否读取了某个环境变量。
 * 三种写法都要覆盖：
 *   process.env.NAME          常规写法
 *   process.env['NAME']       下标写法
 *   ['NAME', fn]              批量循环里以字符串字面量出现（config.mjs 的限额覆盖）
 */
function codeReadsEnv(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`process\\.env\\.${esc}\\b`).test(allSrc)) return true;
  if (new RegExp(`process\\.env\\[\\s*['"]${esc}['"]\\s*\\]`).test(allSrc)) return true;
  if (new RegExp(`['"]${esc}['"]`).test(configSrc)) return true;
  return false;
}

const important = [
  'AUTH_PASSWORD',
  'AUTH_SECRET',
  'AUTH_MODE',
  'HOST',
  'PORT',
  'TRUST_PROXY',
  'PUBLIC_URL',
  'DAILY_LIMIT',
  'IP_DAILY_LIMIT',
  'MAX_CONCURRENT',
  'MAX_QUEUE',
  'PER_IP_COOLDOWN_MS',
  'ALLOW_PUBLIC_NO_AUTH',
  'DEEPSEEK_API_KEY',
  'TAVILY_API_KEY',
  'BOCHA_API_KEY',
  'SERPER_API_KEY',
];
for (const v of important) {
  const inCode = codeReadsEnv(v);
  const inDoc = documented.has(v);
  check(`${v}：代码读取 ✓ / 文档说明 ${inDoc ? '✓' : '✗'}`, inCode && inDoc, inCode ? '' : '代码里没读取');
}

/* ---------- 5. 反代配置的关键点 ---------- */
console.log('\n=== 5. 反向代理配置 ===');
const nginx = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx.conf'), 'utf8');
const caddy = fs.readFileSync(path.join(ROOT, 'deploy', 'Caddyfile'), 'utf8');

check('nginx：/api/analyze 关闭了响应缓冲', /location = \/api\/analyze[\s\S]{0,400}proxy_buffering off;/.test(nginx));
check('nginx：放宽了读取超时（检索需 40–90 秒）', /proxy_read_timeout\s+\d{3,}s/.test(nginx));
check('nginx：放大了上传体积限制', /client_max_body_size\s+\d+m/.test(nginx));
check('nginx：配置了 HTTP → HTTPS 跳转', nginx.includes('return 301 https://'));
check('nginx：传递了 X-Forwarded-For', nginx.includes('X-Forwarded-For'));
check('nginx：登录接口单独限流', /location = \/api\/login[\s\S]{0,200}limit_req/.test(nginx));

check('Caddy：关闭了缓冲（flush_interval -1）', caddy.includes('flush_interval -1'));
check('Caddy：放宽了读写超时', /read_timeout\s+\d{3,}s/.test(caddy) && /write_timeout\s+\d{3,}s/.test(caddy));
check('Caddy：设置了请求体上限', /max_size\s+\d+MB/.test(caddy));

/* ---------- 6. 前端资源完整性（CSP 禁止内联脚本，故必须独立文件） ---------- */
console.log('\n=== 6. 前端资源 ===');
for (const f of ['index.html', 'app.js', 'style.css', 'login.html', 'login.js']) {
  check(`public/${f} 存在`, fs.existsSync(path.join(ROOT, 'public', f)));
}
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
check('index.html 无内联 <script>（否则会被 CSP 拦截）', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(indexHtml));
check('login.html 无内联 <script>', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(loginHtml));
check('login.html 引用了 login.js', loginHtml.includes('/login.js'));
check('index.html 有退出登录按钮', fs.readFileSync(path.join(ROOT,'public/js/components/shell.js'),'utf8').includes('logoutBtn'));
check('index.html 采用模块入口', indexHtml.includes('/js/main.js')); 

/* ---------- 汇总 ---------- */
console.log(`\n${'='.repeat(66)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'='.repeat(66)}\n`);
process.exit(fail === 0 ? 0 : 1);
