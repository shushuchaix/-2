// 一键跑完全部测试与审计（本地和 CI 共用）
// 用法：node tools/run-all-tests.mjs [--skip-network]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildUi } from "./build-ui.mjs";
import { TEST_SUITES, assertTestRegistration } from "./lib/test-suites.mjs";
import {
  runTestProcess,
  runTestPipeline,
  formatTestResult,
} from "./lib/test-process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_NET = process.argv.includes("--skip-network");
// Applies before the build gate and is inherited by every offline subprocess.
if (SKIP_NET) process.env.RJR_DISABLE_LOCAL_CREDENTIALS = "1";

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

assertTestRegistration({
  files: fs
    .readdirSync(path.join(ROOT, "tools"))
    .filter((file) => /^test-.*\.mjs$/.test(file)),
});
const steps = [
  ...TEST_SUITES.map((suite) => ({
    ...suite,
    name: suite.f,
    skipReason:
      suite.artifact && !process.argv.includes("--package")
        ? "仅 --package 验证实际构建产物"
        : SKIP_NET && !suite.offline
          ? "需要联网"
          : undefined,
  })),
  { name: "v2 tests", f: "test-v2.mjs", offline: true },
  { name: "React UI tests", f: "test-ui.mjs", offline: true },
];
console.log("\n" + "=".repeat(84));
console.log("  全量测试");
console.log("=".repeat(84) + "\n");
// A missing or invalid renderer stops every downstream server/package check.
const results = await runTestPipeline({
  prerequisite: { name: "UI前置构建", run: buildUi },
  steps,
  runStep: (step) => {
    console.log(`\n${"─".repeat(84)}\n  ▶ ${step.name}\n${"─".repeat(84)}`);
    const preload = step.offline
      ? [
          "--import",
          pathToFileURL(path.join(ROOT, "tests/helpers/network-guard.mjs"))
            .href,
        ]
      : [];
    return runTestProcess({
      name: step.name,
      args: [...preload, path.join(ROOT, "tools", step.f)],
      cwd: ROOT,
      timeoutMs: 300000,
      resultFile: ["test-v2.mjs", "test-ui.mjs"].includes(step.f)
        ? path.join(TMP_DATA, "suite-" + step.f + ".json")
        : undefined,
      env: {
        RJR_DATA_DIR: TMP_DATA,
        RJR_TEST_ALLOWED_ORIGINS:
          step.f === "test-desktop.mjs"
            ? "http://127.0.0.1:3422"
            : step.f === "test-security.mjs"
              ? "http://127.0.0.1:3311"
              : "",
      },
    });
  },
  onResult: (result) => console.log("  " + formatTestResult(result)),
});
const failed = results.filter(
  (r) => !["passed", "skipped", "not_run"].includes(r.status),
);
const skipped = results.filter((r) => r.status === "skipped");
const notRun = results.filter((r) => r.status === "not_run");
const passed = results.filter((r) => r.status === "passed");

console.log("\n" + "=".repeat(84));
console.log(
  `  步骤 ${results.length} 个 ｜ 通过 ${passed.length} ｜ 失败 ${failed.length} ｜ 跳过 ${skipped.length} ｜ 未运行 ${notRun.length}`,
);
console.log("\n  明细：");
for (const r of results) {
  console.log(
    `    ${formatTestResult(r)}${r.durationMs === undefined ? "" : " · 实际耗时 " + r.durationMs + "ms"}`,
  );
}
if (failed.length) {
  console.log("\n  失败套件：");
  for (const f of failed) console.log("    " + formatTestResult(f));
}
console.log("=".repeat(84) + "\n");

process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
