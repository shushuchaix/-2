import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyCollectionRuntime } from "../../src/infrastructure/collection/runtime.mjs";
export async function verifyBundledOcr({ appRoot, resourceDir }) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(resourceDir, "manifest.json"), "utf8"),
  );
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw Error("OCR manifest invalid");
  for (const item of manifest.files) {
    if (
      !["app", "ocr"].includes(item.root) ||
      typeof item.path !== "string" ||
      item.path.includes("\\") ||
      path.isAbsolute(item.path) ||
      item.path.split("/").some((s) => !s || s === "." || s === "..")
    )
      throw Error("OCR path invalid");
    const base = item.root === "app" ? appRoot : resourceDir,
      filename = path.join(base, item.path);
    let current = filename;
    while (current !== path.resolve(base)) {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw Error("OCR symlink forbidden");
      current = path.dirname(current);
    }
    const bytes = await fs.readFile(filename);
    if (
      bytes.length !== item.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== item.sha256
    )
      throw Error("OCR hash or size mismatch");
  }
  return { verified: true, files: manifest.files.length };
}
export async function copyBundledResources({
  project,
  resourcesRoot,
  appRoot,
}) {
  const runtimeRoot = path.join(project, ".cache/collection-runtime-dev"),
    runtime = await verifyCollectionRuntime({ root: runtimeRoot });
  if (!runtime.verified) throw Error("Collection runtime not verified");
  const target = path.join(resourcesRoot, "collection-runtime"),
    manifest = JSON.parse(
      await fs.readFile(path.join(runtimeRoot, "manifest.json"), "utf8"),
    );
  for (const item of [...manifest.files, { path: "manifest.json" }]) {
    const destination = path.join(target, item.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(runtimeRoot, item.path), destination);
  }
  const checked = await verifyCollectionRuntime({ root: target });
  if (!checked.verified) throw Error("Copied runtime not verified");
  await fs.cp(
    path.join(project, "resources/ocr"),
    path.join(resourcesRoot, "ocr"),
    { recursive: true },
  );
  const ocr = await verifyBundledOcr({
    appRoot,
    resourceDir: path.join(resourcesRoot, "ocr"),
  });
  return { runtime: manifest.files.length, ocr: ocr.files };
}
