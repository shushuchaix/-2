import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runTestProcess,
  formatTestResult,
  publishTestResult,
} from "./lib/test-process.mjs";
process.env.RJR_DISABLE_LOCAL_CREDENTIALS = "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : p.endsWith(".test.mjs") ? [p] : [];
      })
    : [];
let files = walk(path.join(root, "tests")).sort();
const relative = (p) => path.relative(root, p).split(path.sep).join("/");
const index = args.indexOf("--file"),
  groupIndex = args.indexOf("--group");
if (index >= 0) {
  const candidate = path.resolve(root, args[index + 1] || "");
  if (!files.includes(candidate)) {
    console.error("Unknown test file");
    process.exit(1);
  }
  files = [candidate];
}
if (groupIndex >= 0) {
  const group = args[groupIndex + 1];
  if (!["unit", "integration", "e2e"].includes(group)) {
    console.error("Unknown test group");
    process.exit(1);
  }
  files = files.filter((p) => relative(p).startsWith("tests/" + group + "/"));
}
if (args.includes("--list")) {
  console.log(JSON.stringify(files.map(relative)));
  process.exit(0);
}
if (!files.length) {
  console.error("No tests discovered");
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjr-v2-"));
try {
  const result = runTestProcess({
    name: "v2 tests",
    args: [
      "--import",
      pathToFileURL(path.join(root, "tests/helpers/network-guard.mjs")).href,
      "--test",
      ...files,
    ],
    cwd: root,
    env: { RJR_DATA_DIR: dir },
    timeoutMs: 300000,
  });
  console.log(formatTestResult(result));
  publishTestResult(result);
  process.exitCode = result.code;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
