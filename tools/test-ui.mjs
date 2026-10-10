import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const selected = args[0] === "--file" ? args[1] : null;
if (args.length && !(args.length === 2 && selected))
  throw Error("Usage: test-ui.mjs [--file tests/ui/name.test.tsx]");
const files = selected
  ? [selected]
  : (await fs.readdir(path.join(root, "tests/ui")))
      .filter((f) => f.endsWith(".test.tsx"))
      .map((f) => "tests/ui/" + f);
if (!files.length) throw Error("No React tests found");
for (const file of files) {
  if (!/^tests\/ui\/[a-z0-9-]+\.test\.tsx$/.test(file))
    throw Error("Invalid UI test path");
  await fs.access(path.join(root, file));
}
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rjr-ui-test-"));
if (
  path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) ||
  !path.basename(dataDir).startsWith("rjr-ui-test-")
)
  throw Error("Unexpected UI fixture directory");
try {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/helpers/network-guard.mjs",
      "--import",
      "tsx",
      "--import",
      "./tests/helpers/react-dom.mjs",
      "--test",
      ...files,
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 300000,
      env: {
        ...process.env,
        DEBUG_PRINT_LIMIT: "800",
        TSX_TSCONFIG_PATH: path.join(root, "tests/tsconfig.json"),
        RJR_DATA_DIR: dataDir,
      },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
