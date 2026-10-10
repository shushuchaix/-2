// Focused synthetic diagnosis; final release proof is the packaged --self-test.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
const project = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  ),
  directory = await fs.mkdtemp(path.join(project, ".cache/bundled-probe-"));
await fs.writeFile(
  path.join(directory, "package.json"),
  JSON.stringify({ type: "module", main: "main.mjs" }),
);
await fs.writeFile(
  path.join(directory, "main.mjs"),
  `import {app} from 'electron';
import fs from 'node:fs/promises';
import {installSelfTestNetworkGuard} from ${JSON.stringify(pathToFileURL(path.join(project, "electron/self-test-network.mjs")).href)};
import {runBundledResourcesSelfTest} from ${JSON.stringify(pathToFileURL(path.join(project, "electron/bundled-runtime-self-test.mjs")).href)};
app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(directory)});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{const guard=installSelfTestNetworkGuard();
try{guard.setAllowedOrigin('http://127.0.0.1:1');const result=await runBundledResourcesSelfTest({resourcesRoot:${JSON.stringify(path.join(project, "dist/简历岗位雷达-win32-x64/resources"))},dataDir:${JSON.stringify(directory)},networkGuard:guard});await fs.writeFile(${JSON.stringify(path.join(directory, "bundled-report.json"))},JSON.stringify(result));app.exit(0)}catch(error){await fs.writeFile(${JSON.stringify(path.join(directory, "bundled-report.json"))},JSON.stringify({failed:true,code:error.code||error.name,message:error.message}));app.exit(1)}finally{guard.dispose()}}).catch(error=>{console.error(error);app.exit(1)});`,
);
const env = { ...process.env };
for (const key of [
  "PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "ELECTRON_RUN_AS_NODE",
])
  delete env[key];
const child = spawn(
  path.join(project, "node_modules/electron/dist/electron.exe"),
  [directory],
  { env, windowsHide: true, shell: false, stdio: "inherit" },
);
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
console.log(
  await fs.readFile(path.join(directory, "bundled-report.json"), "utf8"),
);
