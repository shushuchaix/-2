// Maintenance only removes explicitly selected test artifacts; package trash owns personal retention.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function cleanData({
  dataDir = path.join(ROOT, "data"),
  apply = false,
} = {}) {
  const root = path.resolve(dataDir),
    actions = [];
  if (!fs.existsSync(root))
    return { apply: apply === true, actions, freedBytes: 0 };
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw Error("Unsafe maintenance directory");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/^e2e-.*\.json$/.test(entry.name)) continue;
    const target = path.resolve(root, entry.name);
    const relative = path.relative(root, target);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      throw Error("Unsafe maintenance target");
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    actions.push({
      relativePath: relative,
      size: stat.size,
      reason: "test_artifact",
    });
    if (apply === true) fs.unlinkSync(target);
  }
  return {
    apply: apply === true,
    actions,
    freedBytes: actions.reduce((sum, action) => sum + action.size, 0),
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = cleanData({ apply: process.argv.includes("--apply") });
  console.log(
    result.apply
      ? "已清理测试产物。"
      : "演练模式：使用 --apply 执行测试产物清理。",
  );
  console.log(JSON.stringify(result, null, 2));
}
