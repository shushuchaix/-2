import { inputError } from "../../public/js/validation-rules.js";
import { versionNameKey } from "./workspace-management.mjs";
import { createHash } from "node:crypto";
export const versionNameHash = (kind, name) =>
  createHash("sha256")
    .update(JSON.stringify([kind, versionNameKey(name)]))
    .digest("hex");
export function normalizeVersionName(value) {
  if (typeof value !== "string")
    throw inputError({ versionName: "请填写版本名称（1–60 个字符）。" });
  const versionName = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if ([...versionName].length < 1 || [...versionName].length > 60)
    throw inputError({ versionName: "版本名称需要 1–60 个字符。" });
  return { versionName, nameKey: versionNameKey(versionName) };
}
export function assertVersionNameAvailable(
  w,
  { kind, versionName, revisionId = null, control },
) {
  const normalized = normalizeVersionName(versionName);
  const packageOccupied = Object.values(w.packages || {}).find(
    (p) =>
      p.versionId !== revisionId &&
      p.kind === kind &&
      p.state !== "purged" &&
      versionNameKey(p.versionName) === normalized.nameKey,
  );
  const pendingName = Object.values(control?.purgeTasks || {}).some(
    (t) =>
      t.phase !== "completed" &&
      t.nameHash === versionNameHash(kind, normalized.versionName),
  );
  if (packageOccupied || pendingName)
    throw Object.assign(
      inputError(
        { versionName: "该版本名称已被占用，请查看已有版本或使用其他名称。" },
        "该版本名称已被占用。",
        409,
      ),
      {
        code: "version_name_conflict",
        conflictingRevisionId: packageOccupied?.versionId,
      },
    );
  const occupied = Object.entries(w.versionMetadata || {}).find(
    ([id, m]) =>
      id !== revisionId && m.kind === kind && m.nameKey === normalized.nameKey,
  );
  if (occupied)
    throw Object.assign(
      inputError(
        { versionName: "该版本名称已被占用，请查看已有版本或使用其他名称。" },
        "该版本名称已被占用。",
        409,
      ),
      { code: "version_name_conflict", conflictingRevisionId: occupied[0] },
    );
  return normalized;
}
