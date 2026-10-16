import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const library = new URL("../../tools/lib/bundled-resources.mjs", import.meta.url).href;
const guard = new URL("../helpers/network-guard.mjs", import.meta.url).href;

for (const relative of [true, false]) {
  test(`OCR package verification terminates and checks both roots with ${relative ? "relative" : "absolute"} paths`, async t => {
    const cache = path.join(repo, ".cache");
    await fs.mkdir(cache, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(cache, "ocr-path-test-"));
    t.after(async () => {
      if (!path.resolve(fixture).startsWith(path.resolve(cache) + path.sep))
        throw Error("OCR fixture cleanup scope invalid");
      await fs.rm(fixture, { recursive: true, force: true });
    });
    const appRoot = path.join(fixture, "app"), resourceDir = path.join(fixture, "ocr");
    await fs.mkdir(appRoot); await fs.mkdir(resourceDir);
    const bytes = Buffer.from("synthetic OCR asset");
    for (const base of [appRoot, resourceDir]) await fs.writeFile(path.join(base, "asset.bin"), bytes);
    await fs.writeFile(path.join(resourceDir, "manifest.json"), JSON.stringify({
      version: 1,
      files: ["app", "ocr"].map(root => ({ root, path: "asset.bin", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })),
    }));
    const input = {
      appRoot: relative ? path.relative(repo, appRoot) : appRoot,
      resourceDir: relative ? path.relative(repo, resourceDir) : resourceDir,
    };
    // A child deadline keeps the old parent-path loop from leaking a hung
    // verifier into the test runner. Only this synthetic fixture is read.
    const code = `const {verifyBundledOcr}=await import(${JSON.stringify(library)});process.stdout.write(JSON.stringify(await verifyBundledOcr(${JSON.stringify(input)})));`;
    let output, failure;
    try { output = await run(process.execPath, ["--import", guard, "--input-type=module", "-e", code], { cwd: repo, timeout: 2000, maxBuffer: 10000, windowsHide: true }); }
    catch (error) { failure = error; }
    assert.equal(!failure, true, "OCR verifier must finish valid relative and absolute roots within its deadline: " +
      (failure ? String(failure.code) + " " + String(failure.stderr || "").slice(-1200) : ""));
    assert.deepEqual(JSON.parse(output.stdout), { verified: true, files: 2 });
  });
}
