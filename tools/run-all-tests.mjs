// 一键跑完全部测试与审计（本地和 CI 共用）
// 用法：node tools/run-all-tests.mjs [--skip-network]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_NET = process.argv.includes("--skip-network");

// 测试全程用隔离的数据目录，避免碰到真实的 data/（检索记录、配额、索引）。
// 【为什么要在结束时删掉】早先只设不删，结果项目根目录残留了一个 .tmp-test-data/；
// 它既没被 .gitignore 覆盖，也没人知道那是干什么的 —— 典型的「自己造的垃圾自己收」没做到。
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
const TMP_DATA = fs.mkdtempSync(path.join(ROOT, ".cache", "test-run-"));
function cleanupTmp() {
  try {
    if (!path.resolve(TMP_DATA).startsWith(path.resolve(ROOT) + path.sep))
      throw new Error("Test cleanup path outside workspace");
    fs.rmSync(TMP_DATA, { recursive: true, force: true });
  } catch {
    /* 删不掉也不影响测试结果 */
  }
}
process.on("exit", cleanupTmp);
process.on("SIGINT", () => {
  cleanupTmp();
  process.exit(130);
});

/**
 * 需要联网的套件：CI 里也能跑，但网络抖动会造成假失败，
 * 所以单独标出来，可以用 --skip-network 跳过。
 */
const SUITES = [
  // 纯离线：必定要跑
  { f: "test-security.mjs", offline: true },
  { f: "test-deploy-assets.mjs", offline: true },
  { f: "test-desktop.mjs", offline: true },
  { f: "test-export.mjs", offline: true },
  { f: "test-sources-index.mjs", offline: true },
  { f: "test-searchapi.mjs", offline: true },
  { f: "test-store.mjs", offline: true },
  { f: "test-cert-proficiency.mjs", offline: true },
  { f: "test-requirement-severity.mjs", offline: true },
  { f: "test-filters-intern-degree.mjs", offline: true },
  { f: "test-destinations.mjs", offline: true },
  { f: "verify-package.mjs", offline: true, artifact: true },
  { f: "audit-project.mjs", offline: true },
  { f: "audit-soft-requirements.mjs", offline: true },
  { f: "check-package-json.mjs", offline: true },
  // 实习僧字体混淆解码：这两个此前存在但没接入运行器（属于「孤儿测试」），
  // 实测能跑通且不联网，接进来增加覆盖
  { f: "test-fontmap.mjs", offline: true },
  { f: "test-font-stability.mjs", offline: true },
  // 需要联网
  // 注意 test-profile-pin 虽然是本地跑，但「钉死学校」会触发就业网探测（真实网络），
  // 所以必须归到联网组，否则离线 CI 里会假失败
  // test-campus 的第一/五节是纯离线断言，但第二/三/四节会真抓牛客/智联/实习僧，
  // 且 fetchCampusJobs() / fetchSchedule() 没有 try/catch —— 网络一抖就崩。
  // 它此前标成 offline，与上面「离线套件不依赖外部站点」的注释自相矛盾，
  // 会让离线 CI 假失败。归到联网组才对。
  { f: "test-campus.mjs", offline: false },
  { f: "test-profile-pin.mjs", offline: false },
  { f: "test-university-registry.mjs", offline: false },
  { f: "test-fire-safety-profile.mjs", offline: false },
  { f: "test-chenyun.mjs", offline: false },
  { f: "test-jiuyeqiao.mjs", offline: false },
];

const results = [];
console.log("\n" + "=".repeat(84));
console.log("  全量测试");
console.log("=".repeat(84) + "\n");

for (const s of SUITES) {
  if (s.artifact && !process.argv.includes("--package")) {
    console.log("  跳过 " + s.f + "（仅 --package 验证实际构建产物）");
    results.push({ ...s, code: 0, skipped: true });
    continue;
  }
  if (SKIP_NET && !s.offline) {
    console.log(`  ⏭  ${s.f.padEnd(34)} 跳过（需要联网）`);
    results.push({ ...s, code: 0, skipped: true });
    continue;
  }
  console.log(`\n${"─".repeat(84)}\n  ▶ ${s.f}\n${"─".repeat(84)}`);
  const t0 = Date.now();
  // 【重要】必须用 stdio:'inherit'。
  // 受限环境下不允许创建命名管道，child_process 一旦用默认的 'pipe' 捕获输出就会 EPERM，
  // 表现为「所有套件 0.0s 全失败」这种极难定位的现象。
  // inherit 让子进程直接写当前终端，退出码仍然拿得到 —— 代价只是无法在这里解析断言条数。
  const preload = s.offline
    ? [
        "--import",
        pathToFileURL(path.join(ROOT, "tests/helpers/network-guard.mjs")).href,
      ]
    : [];
  const r = spawnSync(
    process.execPath,
    [...preload, path.join(ROOT, "tools", s.f)],
    {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 300000,
      env: {
        ...process.env,
        RJR_DATA_DIR: TMP_DATA,
        RJR_TEST_ALLOWED_ORIGINS:
          s.f === "test-desktop.mjs"
            ? "http://127.0.0.1:3422"
            : s.f === "test-security.mjs"
              ? "http://127.0.0.1:3311"
              : "",
      },
    },
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const code = r.status ?? 1;
  results.push({ ...s, code, secs });
}

const v2 = spawnSync(process.execPath, [path.join(ROOT, "tools/test-v2.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  timeout: 300000,
});
results.push({ f: "v2 tests", offline: true, code: v2.status ?? 1 });
const failed = results.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.skipped);
const passed = results.length - failed.length - skipped.length;

console.log("\n" + "=".repeat(84));
console.log(
  `  套件 ${results.length} 个 ｜ 通过 ${passed} ｜ 失败 ${failed.length} ｜ 跳过 ${skipped.length}`,
);
console.log("\n  明细：");
for (const r of results) {
  const mark = r.skipped ? "⏭ " : r.code === 0 ? "✅" : "❌";
  console.log(
    `    ${mark} ${r.f.padEnd(34)} ${String(r.secs || "-").padStart(6)}s`,
  );
}
if (failed.length) {
  console.log("\n  失败套件：");
  for (const f of failed) console.log(`    ❌ ${f.f}`);
}
console.log("=".repeat(84) + "\n");

process.exit(failed.length ? 1 : 0);
