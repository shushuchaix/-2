import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as asar from "@electron/asar";
import { parse } from "acorn";
import { verifyBundledOcr } from "./lib/bundled-resources.mjs";
import { verifyCollectionRuntime } from "../src/infrastructure/collection/runtime.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const EXCLUDE_MODULES = [];
export const PUBLIC_RUNTIME_FILES = [
  "login.html",
  "login.js",
  "style.css",
  "js/validation-rules.js",
  "js/diagnostic-rules.js",
  "js/version-management.js",
  "js/components/form-validation.js",
  "js/components/dom.js",
];
const REQUIRED_RUNTIME = [
  "electron/main.mjs",
  "electron/preload.cjs",
  "electron/credentials.mjs",
  "electron/directories.mjs",
  "electron/self-test.mjs",
  "electron/self-test-network.mjs",
  "src/server.mjs",
  "src/config.mjs",
  "src/application/context.mjs",
  "src/application/run-service.mjs",
  "src/application/purge-service.mjs",
  "src/infrastructure/storage/repository.mjs",
  "src/infrastructure/storage/package-control.mjs",
  "src/infrastructure/storage/bootstrap-workspace.mjs",
  "src/infrastructure/diagnostics/log.mjs",
  "src/domain/ontology.json",
  "src/sources/catalog/universities.json",
];

/** Shared with the desktop assembler: installed production dependencies, including optional modules. */
export function prodClosure({ root = ROOT, dependencies } = {}) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const seen = new Set();
  const walk = (name, optional = false) => {
    if (seen.has(name) || EXCLUDE_MODULES.includes(name)) return;
    const pj = path.join(root, "node_modules", name, "package.json");
    if (!fs.existsSync(pj)) {
      if (optional) return;
      throw Error("Missing production dependency: " + name);
    }
    seen.add(name);
    const p = JSON.parse(fs.readFileSync(pj, "utf8"));
    for (const d of Object.keys(p.dependencies || {}))
      walk(d, Object.hasOwn(p.optionalDependencies || {}, d));
    for (const d of Object.keys(p.optionalDependencies || {})) walk(d, true);
  };
  for (const d of Object.keys(dependencies || pkg.dependencies || {})) walk(d);
  return [...seen];
}

/** Validate actual references, including generated chunks and CSS resources. */
export function validateUiAssets({ root = ROOT, hasFile, readFile } = {}) {
  hasFile ||= (rel) =>
    fs.existsSync(path.join(root, rel)) &&
    fs.statSync(path.join(root, rel)).isFile();
  readFile ||= (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const index = "public/app/index.html";
  if (!hasFile(index)) throw Error("Missing UI asset: " + index);
  const html = readFile(index);
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html))
    throw Error("Inline UI scripts are forbidden");
  const urls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((url) => !url.startsWith("data:"));
  if (
    !urls.some((url) => url.endsWith(".js")) ||
    !urls.some((url) => url.endsWith(".css"))
  )
    throw Error("Missing UI JS/CSS entry");
  const visited = new Set([index]),
    queue = [];
  function add(url, from) {
    const clean = url.split(/[?#]/)[0];
    if (/^(?:data:|#)/.test(url)) return;
    if (/^(?:[a-z]+:|\/\/)/i.test(clean))
      throw Error("External UI asset is forbidden");
    const rel = clean.startsWith("/app/")
      ? "public" + clean
      : path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
    if (!rel.startsWith("public/app/") || rel.includes("\\"))
      throw Error("UI asset leaves application directory");
    if (!hasFile(rel)) throw Error("Missing UI asset: " + rel);
    if (!visited.has(rel)) {
      visited.add(rel);
      queue.push(rel);
    }
  }
  for (const url of urls) add(url, index);
  while (queue.length) {
    const file = queue.shift();
    if (file.endsWith(".js")) {
      const pending = [
        parse(readFile(file), { ecmaVersion: "latest", sourceType: "module" }),
      ];
      while (pending.length) {
        const node = pending.pop();
        if (
          [
            "ImportDeclaration",
            "ExportNamedDeclaration",
            "ExportAllDeclaration",
            "ImportExpression",
          ].includes(node.type) &&
          typeof node.source?.value === "string"
        )
          add(node.source.value, file);
        for (const value of Object.values(node)) {
          if (Array.isArray(value))
            for (const item of value) {
              if (item?.type) pending.push(item);
            }
          else if (value?.type) pending.push(value);
        }
      }
    } else if (file.endsWith(".css")) {
      for (const match of readFile(file).matchAll(
        /url\(\s*["']?([^"')\s]+)["']?\s*\)/g,
      ))
        add(match[1], file);
    }
  }
  return {
    index,
    assets: [...visited],
    js: [...visited].filter((file) => file.endsWith(".js")),
    css: [...visited].filter((file) => file.endsWith(".css")),
  };
}

function archiveFiles(header, prefix = "", result = []) {
  for (const [name, entry] of Object.entries(header.files || {})) {
    const full = prefix ? prefix + "/" + name : name;
    if (entry.files) archiveFiles(entry, full, result);
    else result.push(full);
  }
  return result;
}

function productionSourceFiles(root) {
  const files = [];
  function walk(rel) {
    for (const entry of fs.readdirSync(path.join(root, rel), {
      withFileTypes: true,
    })) {
      const file = rel + "/" + entry.name;
      if (entry.isSymbolicLink())
        throw Error("Symlink runtime source is forbidden: " + file);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const rel of ["electron", "src"]) walk(rel);
  return [
    ...files,
    ...PUBLIC_RUNTIME_FILES.map((rel) => "public/" + rel),
  ].sort();
}

export function verifyPackageArchive({
  archivePath = path.join(
    ROOT,
    "dist/简历岗位雷达-win32-x64/resources/app.asar",
  ),
  root = ROOT,
} = {}) {
  const buffer = fs.readFileSync(archivePath),
    headerLength = buffer.readUInt32LE(12);
  const files = archiveFiles(
      JSON.parse(buffer.toString("utf8", 16, 16 + headerLength)),
    ),
    listed = new Set(files);
  const read = (rel) =>
    asar
      .extractFile(archivePath, rel.split("/").join(path.sep))
      .toString("utf8");
  const forbidden = files.filter(
    (file) =>
      /^(?:data|control|cache|logs|credentials|tests|tools|ui|dist|\.cache|\.tmp|\.git|\.superpowers|\.npm-cache)\//.test(
        file,
      ) ||
      /(?:^|\/)(?:config\.json|\.env(?:\.[^/]+)?|\.?credentials(?:\.v2)?\.(?:json|ya?ml)|workspace\.v2(?:\.previous)?\.json|desktop-self-test\.json)$/.test(
        file,
      ) ||
      (file.startsWith("public/") &&
        !file.startsWith("public/app/") &&
        !PUBLIC_RUNTIME_FILES.some((rel) => file === "public/" + rel)),
  );
  if (forbidden.length)
    throw Error(
      "Forbidden packaged files: " + forbidden.slice(0, 8).join(", "),
    );
  for (const file of [
    ...REQUIRED_RUNTIME,
    ...PUBLIC_RUNTIME_FILES.map((rel) => "public/" + rel),
    "package.json",
  ])
    if (!listed.has(file)) throw Error("Missing runtime file: " + file);
  const matchedSources = [];
  for (const file of productionSourceFiles(root)) {
    if (!listed.has(file)) throw Error("Missing runtime file: " + file);
    const sourceBytes = fs.readFileSync(path.join(root, file));
    const packagedBytes = asar.extractFile(
      archivePath,
      file.split("/").join(path.sep),
    );
    const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
    if (sha256 !== createHash("sha256").update(packagedBytes).digest("hex"))
      throw Error("Source/package mismatch: " + file);
    if (
      /\b[A-Za-z]:[\\/](?:Users|用户)[\\/]|(?:\/home|\/Users)\/[^\s"'`]+\/(?:\.agent-reach|\.codex|\.agents)\//i.test(
        packagedBytes.toString("utf8"),
      )
    )
      throw Error("User-specific runtime path is forbidden: " + file);
    matchedSources.push({ file, sha256 });
  }
  const pkg = JSON.parse(read("package.json"));
  if (pkg.dependencies?.["@napi-rs/canvas"])
    for (const rel of [
      "node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
      "node_modules/pdfjs-dist/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
      "node_modules/tesseract.js/src/worker-script/node/index.js",
    ]) {
      if (
        !listed.has(rel) ||
        asar.statFile(archivePath, rel.split("/").join(path.sep)).unpacked !==
          true
      )
        throw Error("Native/OCR file must be unpacked: " + rel);
    }
  if (pkg.devDependencies || pkg.workspaces)
    throw Error("Development package metadata is forbidden");
  const closure = prodClosure({ root, dependencies: pkg.dependencies });
  for (const name of closure)
    if (!listed.has("node_modules/" + name + "/package.json"))
      throw Error("Missing packaged production dependency: " + name);
  const ui = validateUiAssets({
    hasFile: (rel) => listed.has(rel),
    readFile: read,
  });
  const text = buffer.toString("utf8");
  for (const re of [
    /\bsk-[A-Za-z0-9_-]{20,}/,
    /\btvly-[A-Za-z0-9_-]{20,}/,
    /\bbsa-[A-Za-z0-9_-]{20,}/,
  ])
    if (re.test(text))
      throw Error("Credential-shaped secret is forbidden in package");
  return {
    fileCount: files.length,
    bytes: buffer.length,
    ui,
    dependencies: closure,
    matchedSources,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const value = (flag) => {
    const i = process.argv.indexOf(flag);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  try {
    const report = verifyPackageArchive({
      archivePath: value("--archive"),
      root: value("--root"),
    });
    const archive =
        value("--archive") ||
        path.join(ROOT, "dist/简历岗位雷达-win32-x64/resources/app.asar"),
      resources = path.dirname(archive);
    const ocr = await verifyBundledOcr({
      appRoot: archive + ".unpacked",
      resourceDir: path.join(resources, "ocr"),
    });
    const runtime = await verifyCollectionRuntime({
      root: path.join(resources, "collection-runtime"),
    });
    if (!runtime.verified) throw Error("Bundled collection runtime invalid");
    console.log(`Bundled runtime verified; OCR ${ocr.files} hashes verified.`);
    console.log(
      `Package verified: ${report.fileCount} files, ${report.ui.js.length} JS assets, ${report.ui.css.length} CSS assets, ${report.dependencies.length} production dependencies, ${report.matchedSources.length} exact source hashes.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
