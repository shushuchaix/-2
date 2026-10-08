export function upsertVersion(versions, saved) {
  const found = versions.some((v) => v.revisionId === saved.revisionId);
  return found
    ? versions.map((v) => (v.revisionId === saved.revisionId ? saved : v))
    : [...versions, saved];
}
export function versionLabel(v) {
  return (
    (v.versionName || v.profile?.name || v.roles?.join(" / ") || "版本") +
    " · " +
    v.revisionId +
    (v.archivedAt ? " · 回收站" : v.enabled === false ? " · 已停用" : "")
  );
}
export function versionAvailability(target, profiles = []) {
  if (!target)
    return {
      canCollect: false,
      canRescore: false,
      reasonCode: "target_missing",
    };
  if (target.archivedAt)
    return {
      canCollect: false,
      canRescore: false,
      reasonCode: "target_archived",
    };
  if (
    profiles.find((p) => p.revisionId === target.profileRevisionId)?.archivedAt
  )
    return {
      canCollect: false,
      canRescore: false,
      reasonCode: "profile_archived",
    };
  if (target.availability) return target.availability;
  return {
    canCollect: target.enabled !== false,
    canRescore: true,
    reasonCode: target.enabled === false ? "target_disabled" : null,
  };
}
export function operationError(error) {
  const refs = Object.entries(error.references || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => k + "：" + n)
    .join("，");
  return (
    (error.message || "操作失败") +
    (refs ? "；引用记录：" + refs : "") +
    (error.diagnosticId && !error.message?.includes(error.diagnosticId)
      ? "（错误编号：" + error.diagnosticId + "）"
      : "")
  );
}
export function submissionNonce() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
  );
}
