// Windows recycle recovery. Default is inspection; existing files are never overwritten.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const RECYCLE =
  "E:\\$RECYCLE.BIN\\S-1-5-21-3977033360-1255995190-1098039860-1001";
const TARGET_ROOT = "E:\\简历脚本";
const error = (code) => Object.assign(Error(code), { code });
export function isRecoveryPath(root, candidate) {
  const api = /^[A-Za-z]:[\\/]/.test(root) ? path.win32 : path;
  if (!api.isAbsolute(root) || !api.isAbsolute(candidate)) return false;
  const relative = api.relative(api.resolve(root), api.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + api.sep) &&
      !api.isAbsolute(relative))
  );
}
function noLinks(value) {
  const absolute = path.resolve(value),
    parts = absolute.slice(path.parse(absolute).root.length).split(path.sep);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.existsSync(current) ? fs.lstatSync(current) : null;
    if (stat?.isSymbolicLink()) throw error("recovery_link_forbidden");
  }
}
export function restoreEntry({ source, destination, targetRoot }) {
  const target = path.resolve(destination),
    root = path.resolve(targetRoot);
  if (!isRecoveryPath(root, target)) throw error("recovery_outside_root");
  const folders = [],
    files = [];
  function plan(src, dest) {
    if (!isRecoveryPath(root, dest)) throw error("recovery_outside_root");
    noLinks(dest);
    const stat = fs.lstatSync(src);
    if (stat.isSymbolicLink()) throw error("recovery_link_forbidden");
    if (stat.isDirectory()) {
      if (fs.existsSync(dest) && !fs.lstatSync(dest).isDirectory())
        throw error("recovery_conflict");
      folders.push(dest);
      for (const entry of fs.readdirSync(src, { withFileTypes: true }))
        plan(path.join(src, entry.name), path.join(dest, entry.name));
    } else if (stat.isFile()) {
      if (fs.existsSync(dest)) throw error("recovery_conflict");
      files.push({ src, dest });
    } else throw error("recovery_type_invalid");
  }
  noLinks(source);
  plan(path.resolve(source), target);
  for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
  for (const { src, dest } of files) {
    noLinks(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  }
  return { restoredFiles: files.length };
}
function parseIFile(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 28 || buf.length > 65536)
    throw error("recovery_metadata_invalid");
  const version = buf.readBigUInt64LE(0);
  let originalPath;
  if (version === 2n) {
    const chars = buf.readUInt32LE(24);
    if (chars < 2 || 28 + chars * 2 > buf.length)
      throw error("recovery_metadata_invalid");
    originalPath = buf.toString("utf16le", 28, 28 + (chars - 1) * 2);
  } else if (version === 1n)
    originalPath = buf.toString("utf16le", 24).replace(/\0+$/, "");
  else throw error("recovery_metadata_invalid");
  return { originalPath };
}
export function inspectRecycle({
  recycleDir = RECYCLE,
  targetRoot = TARGET_ROOT,
} = {}) {
  const entries = [];
  for (const name of fs
    .readdirSync(recycleDir)
    .filter((name) => name.startsWith("$I"))) {
    try {
      const meta = parseIFile(path.join(recycleDir, name));
      const content = path.join(recycleDir, "$R" + name.slice(2));
      if (
        isRecoveryPath(targetRoot, meta.originalPath) &&
        fs.existsSync(content)
      )
        entries.push({
          source: content,
          destination: meta.originalPath,
          targetRoot,
        });
    } catch {
      /* Malformed metadata cannot select a recovery target. */
    }
  }
  return entries;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const entries = inspectRecycle(),
    apply = process.argv.includes("--apply");
  console.log("目标范围内可恢复条目：" + entries.length);
  let restoredFiles = 0,
    failed = 0;
  for (const entry of entries) {
    if (!apply) {
      console.log(entry.destination);
      continue;
    }
    try {
      restoredFiles += restoreEntry(entry).restoredFiles;
    } catch (failure) {
      failed++;
      console.log("恢复跳过：" + (failure.code || "recovery_failed"));
    }
  }
  console.log(JSON.stringify({ apply, restoredFiles, failed }));
  if (!apply)
    console.log("演练模式；使用 --apply 恢复。已有内容冲突会跳过整条。");
}
