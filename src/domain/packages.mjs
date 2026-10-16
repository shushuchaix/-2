export const PACKAGE_KINDS = ['profile', 'target', 'legacy_unassigned'];
export const PACKAGE_STATES = ['active', 'trashed', 'purge_pending', 'purged'];
export const RETENTION_MS = 72 * 60 * 60 * 1000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function packageError(code, message, status = 409) {
  return Object.assign(new Error(message), {code, status});
}
export function archiveDeadline(archivedAt) {
  const at = new Date(archivedAt).getTime();
  if (!Number.isFinite(at)) throw packageError('package_invalid_date', '回收时间无效。', 400);
  return new Date(at + RETENTION_MS).toISOString();
}
export function isExpired(pkg, now = new Date()) {
  return pkg.state === 'trashed' && new Date(now).getTime() >= Date.parse(pkg.purgeAt);
}
export function requirePackage(w, packageId, {access = 'business', now = new Date()} = {}) {
  const p = w.packages?.[packageId];
  if (!p || p.state === 'purged') throw packageError('package_not_found', '版本数据包不存在。', 404);
  if (p.state === 'purge_pending') throw packageError('package_purge_pending', '该版本正在永久清理，请在回收站查看进度。');
  if (!['business','trash_read','management'].includes(access)) throw packageError('package_scope_mismatch','访问范围无效。');
  if (p.state === 'trashed') {
    if (isExpired(p, now)) throw packageError('package_expired','该版本已满三天，不能恢复或读取正文。');
    if (access === 'business') throw packageError('package_archived','该版本已进入回收站，请先恢复。');
  } else if (access === 'trash_read') throw packageError('package_scope_mismatch','该版本不在回收站。');
  return p;
}
export function assertScope(w, scope, now = new Date()) {
  if (!scope?.packageId || !scope?.targetRevisionId) throw packageError('version_scope_required','请选择准确的目标版本。');
  const p = requirePackage(w, scope.packageId, {now});
  if (p.kind !== 'target' || p.versionId !== scope.targetRevisionId)
    throw packageError('package_scope_mismatch','数据包与目标版本不一致。');
  return p;
}
export function assertOwned(w, record, packageId) {
  if (!record || record.ownerPackageId !== packageId || !w.packages?.[packageId])
    throw packageError('package_scope_mismatch','Private record ownership does not match its package.');
}
