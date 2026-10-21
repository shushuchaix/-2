import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
export async function buildUi() {
  for (const args of [
    ["node_modules/typescript/bin/tsc", "-p", "ui/tsconfig.json", "--noEmit"],
    ["node_modules/vite/bin/vite.js", "build", "--config", "ui/vite.config.ts"],
  ]) {
    const child = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw Error("UI build failed: " + args[0]);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildUi();
