import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createTempDir, profile, target } from "../helpers/fixtures.mjs";
import { createApplicationContext } from "../../src/application/context.mjs";
import { loadConfig, ensureDataDirs } from "../../src/config.mjs";
const resume =
  "合成学生 本科 软件工程 2027届毕业 Java开发 北京 求职意向 Java SQL 项目经历与实践";
async function run(dataDir, args) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.resolve("tests/helpers/network-guard.mjs")).href,
      "src/cli.mjs",
      ...args,
    ],
    {
      env: {
        ...process.env,
        RJR_DATA_DIR: dataDir,
        DEEPSEEK_API_KEY: "",
        TAVILY_API_KEY: "",
        BOCHA_API_KEY: "",
        SERPER_API_KEY: "",
      },
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  const code = await new Promise((r) => child.on("exit", r));
  return { code, stdout, stderr };
}
test("legacy JSON stdout and new targets command share confirmed workspace", async (t) => {
  const dataDir = await createTempDir(t);
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      auth: { mode: "none" },
      sources: Object.fromEntries(
        [
          "zhaopin",
          "shixiseng",
          "searchApi",
          "wechat",
          "nowcoder",
          "university",
          "chenyun",
          "jiuyeqiao",
        ].map((k) => [k, { enabled: false }]),
      ),
    }),
  );
  const old = await run(dataDir, [
    "--text",
    resume,
    "--no-llm",
    "--format",
    "json",
    "--cities",
    "北京，上海",
    "--all-years",
  ]);
  assert.equal(old.code, 0, old.stderr);
  const result = JSON.parse(old.stdout);
  assert.ok(Array.isArray(result.jobs));
  assert.deepEqual(result.resumeProfile.preferredCities, ["北京", "上海"]);
  const listed = await run(dataDir, ["targets", "list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.ok(JSON.parse(listed.stdout).targets.length);
});
test("data-dir seed precedes config loading even after earlier module import", async (t) => {
  const dataDir = await createTempDir(t);
  ensureDataDirs({ dataDir });
  const filename = path.join(dataDir, "config.json");
  assert.ok((await fs.stat(filename)).isFile());
  await fs.writeFile(
    filename,
    JSON.stringify({ deepseek: { model: "seed-data-dir" } }),
  );
  assert.equal(
    loadConfig({ quiet: true, dataDir }).deepseek.model,
    "seed-data-dir",
  );
});
