// Default: isolated synthetic end-to-end tests. --live explicitly enables public collection.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!args.includes("--live")) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "tools/test-v2.mjs"), "--group", "e2e"],
    { cwd: root, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
await fs.mkdir(path.join(root, ".cache"), { recursive: true });
const dataDir =
  process.env.RJR_DATA_DIR ||
  (await fs.mkdtemp(path.join(root, ".cache", "e2e-live-")));
process.env.RJR_DATA_DIR = dataDir;
await fs.mkdir(dataDir, { recursive: true });
const [{ loadConfig }, { runPipeline }] = await Promise.all([
  import("../src/config.mjs"),
  import("../src/pipeline.mjs"),
]);
const cfg = loadConfig({ dataDir, quiet: true });
const useLlm = args.includes("--llm");
const resumeFile =
  args.find((a) => !a.startsWith("--")) ||
  path.join(root, "tools/sample-resume.txt");
const resumeText = await fs.readFile(resumeFile, "utf8");
const llm = useLlm
  ? new (await import("../src/llm/deepseek.mjs")).DeepSeek(cfg)
  : null;
console.log(
  "显式公网采集；模型 " +
    (useLlm ? "开启" : "关闭") +
    "；隔离输出目录 " +
    dataDir,
);
const result = await runPipeline({
  resumeText,
  llm,
  cfg,
  options: { useLlm },
  onEvent: (e) => {
    if (e.type === "stage") console.log(e.label);
  },
});
const output = path.join(dataDir, "e2e-live.json");
await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    jobs: result.jobs.length,
    stats: result.stats,
    issues: result.errors.length,
    output,
  }),
);
