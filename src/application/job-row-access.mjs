import { rowKey } from '../infrastructure/storage/sqlite-records.mjs';
import { assertScope, packageError } from '../domain/packages.mjs';
import { confirmedGroupHeadId } from '../domain/job-read-model.mjs';

export const jobSelector = (collection, scope, ids, extra = {}) => ({ collection, ownerPackageId: scope.packageId, ...(ids ? { ids } : {}), ...extra });
export async function readAllJobRows(port, selector) {
  const rows = []; let afterId;
  do {
    const page = await port.queryRows({ ...selector, limit: 200, total: false, ...(afterId ? { afterId } : {}) });
    rows.push(...page.rows); if (!page.hasMore) break;
    afterId = page.nextCursor;
    if (!afterId) throw packageError('job_read_set_incomplete', '岗位关联读取未取得完整游标。');
  } while (true);
  return rows;
}

export async function readOwnedTarget(port, scope, asOf = Date.now()) {
  if (!scope?.packageId || !scope?.targetRevisionId) throw packageError('version_scope_required', '请选择准确的目标版本。');
  const view = await port.readView({ select: [
    { collection: 'packages', ids: [scope?.packageId || ''], limit: 1 },
    jobSelector('targets', scope || {}, [scope?.targetRevisionId || '']),
    jobSelector('profileCopies', scope || {}, null, { where: { parentId: scope?.targetRevisionId || '' }, limit: 1 }),
  ] }, { scope });
  const pkg = view.rows.packages?.[scope.packageId];
  assertScope({ packages: { [scope.packageId]: pkg } }, scope, asOf);
  const target = view.rows.targets?.[scope.targetRevisionId], copy = Object.values(view.rows.profileCopies || {})[0];
  if (!target || !copy) throw packageError('version_fact_unavailable', '目标缺少自有简历画像。');
  return { pkg, target: { ...target, profileSnapshot: copy } };
}

/** Resolve stable entity IDs using indexed aliases and a finite redirect chain. */
export async function resolveOwnedJobId(port, scope, requestedId) {
  let id = requestedId; const seen = new Set();
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(id)) throw packageError('job_redirect_cycle', '岗位重定向存在循环。');
    seen.add(id);
    const view = await port.readView({ select: [jobSelector('jobs', scope, [id]), jobSelector('jobRedirects', scope, [id])] }, { scope });
    if (view.rows.jobs?.[id]) return id;
    const redirect = view.rows.jobRedirects?.[id];
    if (redirect) { id = redirect.toJobId; continue; }
    const result = await port.findJobIdentityCandidates({ ownerPackageId: scope.packageId, keys: [{ kind: 'alias', resourceKey: id }], limit: 2 }, { scope });
    if (result.hasMore || result.jobIds.length > 1) throw packageError('job_identity_ambiguous', '该来源标识对应多个不同岗位，请选择具体岗位。');
    if (result.jobIds.length === 1) { id = result.jobIds[0]; continue; }
    throw packageError(/^j-/.test(id) ? 'package_scope_mismatch' : 'job_not_found', /^j-/.test(id) ? '岗位不存在于所选目标版本。' : '岗位不存在。', /^j-/.test(id) ? 409 : 404);
  }
  throw packageError('job_redirect_depth', '岗位重定向链超过读取上限。');
}

export function workspaceFromJobRows(rows, { scope, target, pkg }) {
  const workspace = {
    schemaVersion: 3, _scope: { ...scope }, packages: { [scope.packageId]: pkg },
    targets: { [target.targetId]: [structuredClone(target)] }, profiles: { [target.profileSnapshot.profileId]: [structuredClone(target.profileSnapshot)] },
    jobs: {}, jobProjections: {}, jobRelations: {}, observations: {}, evaluations: {}, applications: {}, runs: {},
    targetMembers: { [scope.targetRevisionId]: {} }, identityAliases: Object.create(null), jobRedirects: {}, duplicateGroups: {}, settings: {},
  };
  for (const [collection, values] of Object.entries(rows)) {
    if (collection === 'targetMembers') {
      for (const [id, member] of Object.entries(values)) workspace.targetMembers[scope.targetRevisionId][JSON.parse(id)[1]] = member;
    } else if (collection === 'identityAliasLinks') {
      for (const [id, jobId] of Object.entries(values)) {
        const alias = JSON.parse(id)[0];
        (workspace.identityAliases[alias] ||= []).push(jobId);
      }
    } else if (collection === 'profileCopies' || collection === 'targets' || collection === 'packages') continue;
    else workspace[collection] = structuredClone(values);
  }
  for (const job of Object.values(workspace.jobs)) for (const alias of job.identityAliases || []) (workspace.identityAliases[alias] ||= []).push(job.jobId);
  return workspace;
}

/** Explicit per-job historical closure, only for commands/details/evaluation. */
export async function loadJobClosure(port, scope, jobIds, { includeHistory = true, includeIdentity = false } = {}) {
  const targetContext = await readOwnedTarget(port, scope);
  const rows = {}, records = [], ids = [...new Set(jobIds)];
  const append = (collection, items) => { rows[collection] ||= {}; for (const item of items) { rows[collection][item.id] = item.value; records.push({ collection, ...item }); } };
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100), view = await port.readView({ select: [
      jobSelector('jobs', scope, batch), jobSelector('jobProjections', scope, batch),
      jobSelector('targetMembers', scope, batch.map(id => rowKey(scope.targetRevisionId, id))),
    ] }, { scope });
    for (const [collection, values] of Object.entries(view.rows)) append(collection, Object.entries(values).map(([id, value]) => ({ id, value, indexes: view.indexes[collection][id] })));
    if (includeHistory) for (const collection of ['observations', 'evaluations', 'applications', ...(includeIdentity ? ['jobIdentityKeys', 'jobFactBasis', 'jobRelations'] : [])]) append(collection, await readAllJobRows(port, jobSelector(collection, scope, null, { where: { jobId: { in: batch } } })));
    if (includeIdentity) append('identityAliasLinks', await readAllJobRows(port, jobSelector('identityAliasLinks', scope, null, { where: { jobId: { in: batch } } })));
  }
  if (includeIdentity) {
    const groupIds = [...new Set(Object.values(rows.jobRelations || {}).filter(row => row.kind === 'confirmed_group_member').map(row => row.groupId))];
    for (let offset = 0; offset < groupIds.length; offset += 1000) {
      const view = await port.readView({ select: [jobSelector('jobRelations', scope, groupIds.slice(offset, offset + 1000).map(confirmedGroupHeadId))] }, { scope });
      append('jobRelations', Object.entries(view.rows.jobRelations || {}).map(([id, value]) => ({ id, value, indexes: view.indexes.jobRelations[id] })));
    }
  }
  return { ...targetContext, rows, records, workspace: workspaceFromJobRows(rows, { scope, ...targetContext }) };
}

export function explicitSelectors(scope, records, additional = []) {
  const collections = new Map();
  for (const record of [...records, ...additional]) {
    const k = record.collection, list = collections.get(k) || new Set(); list.add(record.id); collections.set(k, list);
  }
  const selectors = [];
  for (const [collection, ids] of collections) {
    const all = [...ids]; for (let offset = 0; offset < all.length; offset += 1000) selectors.push(jobSelector(collection, scope, all.slice(offset, offset + 1000)));
  }
  if (selectors.length > 60) throw packageError('job_write_set_too_large', '本次关联变更过多，请分批处理。', 400);
  return selectors;
}
