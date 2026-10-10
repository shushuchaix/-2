// 部署环境勘察
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function deploymentConfigSummary(cfg = {}) {
  const auth = cfg.auth || {},
    server = cfg.server || {};
  return {
    server: {
      host:
        typeof server.host === "string" &&
        /^[A-Za-z0-9.:[\]-]{1,253}$/.test(server.host)
          ? server.host
          : null,
      port:
        Number.isSafeInteger(server.port) &&
        server.port >= 0 &&
        server.port <= 65535
          ? server.port
          : null,
    },
    auth: {
      enabled: auth.mode === "password" || auth.enabled === true,
      passwordConfigured:
        typeof auth.passwordHash === "string" && auth.passwordHash.length > 0,
      sessionHours:
        Number.isSafeInteger(auth.sessionHours) &&
        auth.sessionHours > 0 &&
        auth.sessionHours <= 720
          ? auth.sessionHours
          : null,
    },
  };
}

function tryRun(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], timeout: 20000 })
      .toString()
      .trim();
  } catch (e) {
    return `__FAIL__ ${e.message.split("\n")[0]}`;
  }
}

async function main() {
  console.log("=== 1. 本地服务状态 ===");
  try {
    const r = await fetch("http://127.0.0.1:3210/api/health", {
      signal: AbortSignal.timeout(5000),
    });
    const h = await r.json();
    console.log(
      "  运行中 →",
      h.deepseek?.configured ? "DeepSeek 已配置" : "DeepSeek 未配置",
    );
  } catch {
    console.log("  未运行");
  }

  console.log("\n=== 2. 当前监听配置 ===");
  const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
  const summary = deploymentConfigSummary(cfg);
  console.log("  server:", JSON.stringify(summary.server));
  console.log("  auth 状态:", JSON.stringify(summary.auth));

  console.log("\n=== 3. 容器/部署工具可用性 ===");
  for (const [name, cmd] of [
    ["Docker", "docker --version"],
    ["Docker Compose", "docker compose version"],
    ["Git", "git --version"],
    ["nginx", "nginx -v"],
    ["Caddy", "caddy version"],
    ["winget", "winget --version"],
  ]) {
    const out = tryRun(cmd);
    console.log(
      `  ${name.padEnd(16)} ${out.startsWith("__FAIL__") ? "不可用" : out.split("\n")[0]}`,
    );
  }

  console.log("\n=== 4. Node 版本 ===");
  console.log("  ", process.version);

  console.log("\n=== 5. 本机网络地址（局域网/公网推断）===");
  const os = await import("node:os");
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal)
        console.log(`  ${name}: ${a.address}`);
    }
  }

  console.log("\n=== 6. 公网出口 IP ===");
  try {
    const r = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    console.log("  ", j.ip);
  } catch (e) {
    console.log("  获取失败:", e.message);
  }

  process.exit(0);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
