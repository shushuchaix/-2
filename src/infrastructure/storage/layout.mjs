import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function resolveDataLayout(dataDir) {
  const root = path.resolve(dataDir);
  return Object.freeze({
    root,
    workspace: path.join(root, "workspace.v2.json"),
    previous: path.join(root, "workspace.v2.previous.json"),
    config: path.join(root, "config.json"),
    credentials: path.join(root, "credentials.v2.json"),
    lock: path.join(root, ".workspace.lock"),
    runs: path.join(root, "runs-v2"),
    legacyRuns: path.join(root, "runs"),
    backups: path.join(root, "backups"),
    cache: path.join(root, "cache"),
    logs: path.join(root, "logs"),
    control: path.join(root, "control"),
    controlState: path.join(root, "control", "state.json"),
    controlInitialized: path.join(root, "control", "initialized.json"),
    attachmentTemp: path.join(root, "cache", "attachment-temp"),
    attachmentManifest: path.join(
      root,
      "control",
      "attachment-cleanup",
      "manifest.json",
    ),
  });
}
export function ensureDataLayout(layout, { fsAdapter = fs } = {}) {
  const dirs = [
    layout.root,
    layout.runs,
    layout.legacyRuns,
    layout.backups,
    layout.cache,
    layout.logs,
  ];
  for (const dir of dirs) fsAdapter.mkdirSync(dir, { recursive: true });
  return dirs;
}
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
export function validKnownCache(name, value) {
  if (!object(value)) return false;
  if (name === "font-map.json")
    return (
      object(value.map) &&
      Object.entries(value.map).every(
        ([k, v]) => k.length > 0 && typeof v === "string",
      ) &&
      (value.savedAt === undefined || typeof value.savedAt === "string")
    );
  if (name === "university-hosts.json")
    return Object.values(value).every(
      (v) =>
        object(v) &&
        typeof v.host === "string" &&
        Number.isInteger(v.v) &&
        v.v > 0 &&
        (v.probedAt === undefined || typeof v.probedAt === "string"),
    );
  return false;
}
export function writeCacheJsonSync(
  filename,
  value,
  { fsAdapter = fs, exclusive = false } = {},
) {
  const tmp = filename + "." + randomUUID() + ".tmp";
  let fd;
  try {
    fsAdapter.mkdirSync(path.dirname(filename), { recursive: true });
    fd = fsAdapter.openSync(tmp, "wx");
    fsAdapter.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fsAdapter.fsyncSync(fd);
    fsAdapter.closeSync(fd);
    fd = undefined;
    if (exclusive) fsAdapter.linkSync(tmp, filename);
    else fsAdapter.renameSync(tmp, filename);
  } finally {
    if (fd !== undefined) fsAdapter.closeSync(fd);
    try {
      fsAdapter.unlinkSync(tmp);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
// Startup remains synchronous for existing CLI, server and source callers.
export function migrateKnownCaches(layout, { fsAdapter = fs } = {}) {
  const results = [];
  for (const name of ["font-map.json", "university-hosts.json"]) {
    const old = path.join(layout.root, name),
      current = path.join(layout.cache, name);
    try {
      if (fsAdapter.existsSync(current)) {
        const regular = fsAdapter.lstatSync(current).isFile();
        results.push({
          name,
          status:
            regular &&
            validKnownCache(
              name,
              JSON.parse(fsAdapter.readFileSync(current, "utf8")),
            )
              ? "current"
              : "invalid_current",
        });
        continue;
      }
      if (!fsAdapter.existsSync(old)) {
        results.push({ name, status: "absent" });
        continue;
      }
      if (!fsAdapter.lstatSync(old).isFile()) {
        results.push({ name, status: "invalid_old" });
        continue;
      }
      const raw = fsAdapter.readFileSync(old, "utf8"),
        value = JSON.parse(raw);
      if (!validKnownCache(name, value)) {
        results.push({ name, status: "invalid_old" });
        continue;
      }
      writeCacheJsonSync(current, value, { fsAdapter, exclusive: true });
      const verified = JSON.parse(fsAdapter.readFileSync(current, "utf8"));
      if (
        !validKnownCache(name, verified) ||
        JSON.stringify(value) !== JSON.stringify(verified)
      )
        throw Error("Cache verification failed");
      if (fsAdapter.readFileSync(old, "utf8") === raw)
        fsAdapter.unlinkSync(old);
      results.push({ name, status: "migrated" });
    } catch {
      results.push({ name, status: "retained" });
    }
  }
  return results;
}
