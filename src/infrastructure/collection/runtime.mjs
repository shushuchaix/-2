import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
const empty = (issues) => ({
  available: false,
  verified: false,
  capabilities: { static: false, dynamic: false, enhanced: false },
  issues,
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function verifyCollectionRuntime({
  root,
  manifest,
  offline = true,
} = {}) {
  try {
    root = path.resolve(root);
    if ((await fs.lstat(root)).isSymbolicLink())
      return empty(["runtime_link_forbidden"]);
    manifest ||= JSON.parse(
      await fs.readFile(path.join(root, "manifest.json"), "utf8"),
    );
    if (
      manifest.version !== 1 ||
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch ||
      manifest.python?.version !== "3.14.8" ||
      !Array.isArray(manifest.files) ||
      manifest.files.length < 10 ||
      manifest.files.length > 20000
    )
      return empty(["runtime_manifest_invalid"]);
    for (const item of manifest.files) {
      if (
        typeof item.path !== "string" ||
        item.path.includes("\\") ||
        path.isAbsolute(item.path) ||
        item.path.split("/").some((p) => !p || p === "." || p === "..") ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      )
        return empty(["runtime_path_invalid"]);
      const filename = path.join(root, item.path);
      let current = filename;
      while (current !== root) {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) return empty(["runtime_link_forbidden"]);
        current = path.dirname(current);
      }
      const bytes = await fs.readFile(filename);
      if (bytes.length !== item.bytes || sha(bytes) !== item.sha256)
        return empty(["runtime_hash_mismatch"]);
    }
    const python = path.join(root, "python/python.exe");
    const code =
      'import sys,sysconfig,struct,json,importlib.metadata as m;from scrapling.fetchers import Fetcher,DynamicFetcher,StealthyFetcher;print(json.dumps({"python":".".join(map(str,sys.version_info[:3])),"gilDisabled":bool(sysconfig.get_config_var("Py_GIL_DISABLED")),"bits":struct.calcsize("P")*8,"packages":{k:m.version(k) for k in ["scrapling","playwright","patchright","browserforge","apify-fingerprint-datapoints"]}}))';
    const checked = await new Promise((resolve, reject) => {
      let output = "";
      const child = spawn(python, ["-I", "-B", "-c", code], {
        cwd: root,
        windowsHide: true,
        shell: false,
        env: {
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PLAYWRIGHT_BROWSERS_PATH: path.join(root, "browsers"),
          PLAYWRIGHT_SKIP_BROWSER_GC: "1",
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Runtime probe timeout"));
      }, 15000);
      child.stdout.on("data", (b) => {
        output += b.toString();
        if (output.length > 10000) child.kill();
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(Error("Runtime import failed"));
        else {
          try {
            resolve(JSON.parse(output));
          } catch (e) {
            reject(e);
          }
        }
      });
    });
    if (
      checked.python !== manifest.python.version ||
      checked.gilDisabled ||
      checked.bits !== 64 ||
      Object.entries(manifest.packages).some(
        ([name, version]) => checked.packages[name] !== version,
      )
    )
      return empty(["runtime_version_mismatch"]);
    const browsers = {};
    for (const [mode, module] of [
      ["dynamic", "playwright"],
      ["enhanced", "patchright"],
    ]) {
      const table = JSON.parse(
        await fs.readFile(
          path.join(
            root,
            "python/Lib/site-packages",
            module,
            "driver/package/browsers.json",
          ),
          "utf8",
        ),
      );
      const declared = manifest.browsers?.[module]?.[0],
        actual = table.browsers.find((b) => b.name === "chromium");
      if (
        !declared ||
        declared.revision !== actual?.revision ||
        declared.browserVersion !== actual?.browserVersion
      )
        return empty(["runtime_browser_revision_mismatch"]);
      browsers[mode] = path.join(
        root,
        "browsers",
        "chromium-" + actual.revision,
        "chrome-win64/chrome.exe",
      );
      await fs.access(browsers[mode]);
    }
    const workerPath = path.join(root, "worker/collection_worker.py");
    await fs.access(workerPath);
    void offline;
    return {
      available: true,
      verified: true,
      root,
      python,
      workerPath,
      browsers,
      capabilities: { static: true, dynamic: true, enhanced: true },
      issues: [],
      manifest,
    };
  } catch {
    return empty(["runtime_unavailable"]);
  }
}
