import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentHash } from './content-hash.mjs';
import { hasLiveOwner } from './process-owner.mjs';
import { assertSnapshotPath, assertSnapshotOwner, snapshotPath } from './managed-snapshots.mjs';
import { packageError } from '../../domain/packages.mjs';

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
const token = head => JSON.stringify(head);
const issueFor = (code, runId) => ({ code, runId, message: code === 'missing_snapshot' ? '运行快照缺失。' : '运行快照未通过完整性检查。' });
const retryError = () => packageError('recovery_state_changed', '运行恢复期间身份持续改变，已停止业务访问。', 503);

/** Startup only. Head metadata covers every owner; bodies retain normal access checks. */
export async function recoverWorkspaceRows(repository, { operationGate }) {
  await operationGate.recover();
  const interruptedRunIds = [], orphanSnapshots = [], issues = [], deferredChecks = [];
  const deferred = new Set();
  const defer = head => {
    const key = JSON.stringify([head.runId, head.deferredReason]);
    if (!deferred.has(key)) { deferred.add(key); deferredChecks.push({ runId: head.runId, reason: head.deferredReason }); }
  };

  const prepare = async head => {
    if (!head || head.deferredReason || !head.snapshotRef) return { head };
    const files = await repository.queryRows({ collection: 'files', ownerPackageId: head.ownerPackageId, where: { runId: head.runId, kind: 'run_snapshot' }, limit: 2, total: false }, { operationMaintenance: true, access: 'management' });
    return { head, file: files.rows.length === 1 && !files.hasMore ? files.rows[0].value : null };
  };
  const preparationChanged = Symbol('recovery preparation changed');
  const revoked = new Set(['package_not_found', 'package_expired', 'package_purge_pending', 'package_archived', 'workspace_maintenance_pending']);
  const prepareOrRetry = async head => {
    try { return await prepare(head); }
    catch (error) {
      if (revoked.has(error.code)) return preparationChanged;
      throw error;
    }
  };

  const checkSnapshot = async ({ head, file }) => {
    if (!head.snapshotRef) return [];
    try {
      const filename = snapshotPath(repository.dataDir, head.runId);
      if (head.snapshotRefType !== 'object' || head.snapshotRef.path !== `runs-v2/${head.runId}.json` || typeof head.snapshotRef.hash !== 'string') throw Error('snapshot reference invalid');
      await assertSnapshotPath(repository.dataDir, filename, fs);
      if (!file || file.ownerPackageId !== head.ownerPackageId || file.runId !== head.runId || file.path !== head.snapshotRef.path || file.hash !== head.snapshotRef.hash) throw Error('snapshot registration invalid');
      const snapshot = JSON.parse(await fs.readFile(filename, 'utf8'));
      const pkg = { packageId: head.ownerPackageId, kind: head.packageKind, state: head.packageState, purgeAt: head.purgeAt };
      assertSnapshotOwner({ packages: { [head.ownerPackageId]: pkg }, runs: { [head.runId]: head } }, head.runId, snapshot, repository.clock, { access: 'management' });
      if (snapshot.recordId !== file.snapshotRecordId || (snapshot.run?.runId && snapshot.run.runId !== head.runId) || contentHash(snapshot) !== head.snapshotRef.hash) throw Error('snapshot identity/hash invalid');
      return [];
    } catch (error) {
      return [issueFor(error.code === 'ENOENT' ? 'missing_snapshot' : 'invalid_snapshot', head.runId)];
    }
  };

  const sameFile = (fence, prepared) => {
    if (!prepared.head.snapshotRef) return true;
    const page = fence.queryRows({ collection: 'files', ownerPackageId: prepared.head.ownerPackageId, where: { runId: prepared.head.runId, kind: 'run_snapshot' }, limit: 2, total: false });
    const file = page.rows.length === 1 && !page.hasMore ? page.rows[0].value : null;
    return JSON.stringify(file) === JSON.stringify(prepared.file);
  };

  const appendAndInterrupt = (fence, head, newIssues, interrupt) => {
    const existing = new Set(); let afterId;
    do {
      const page = fence.queryRecoveryRecordKeys({ runId: head.runId, limit: 200, ...(afterId ? { afterId } : {}) });
      for (const row of page.rows) existing.add(row.code);
      afterId = page.hasMore ? page.nextCursor : null;
    } while (afterId);
    const additions = newIssues.filter(issue => !existing.has(issue.code));
    if (!interrupt && !additions.length) return;
    const max = additions.length ? fence.aggregateRows({ collection: 'recoveryRecords', operation: 'max', field: 'ordinal', limit: 1 }).groups[0]?.value : null;
    let ordinal = max === null || max === undefined ? 0 : max + 1;
    if (!Number.isSafeInteger(ordinal) || !Number.isSafeInteger(ordinal + additions.length)) throw packageError('sqlite_sequence_exhausted', '恢复记录序号超出范围。', 503);
    const rows = additions.map(issue => ({ id: 'recovery-' + randomUUID(), ordinal: ordinal++, value: { ...issue, ...(head.ownerPackageId ? { ownerPackageId: head.ownerPackageId, recordId: randomUUID() } : {}) } }));
    const select = [
      ...(interrupt ? [{ collection: 'runs', ownerPackageId: head.ownerPackageId, ids: [head.runId] }] : []),
      ...(rows.length ? [{ collection: 'recoveryRecords', ids: rows.map(row => row.id), ...(head.ownerPackageId ? { ownerPackageId: head.ownerPackageId } : {}) }] : []),
    ];
    fence.transaction({ select }, tx => {
      if (interrupt) {
        const run = tx.getRow({ collection: 'runs', ownerPackageId: head.ownerPackageId, id: head.runId });
        if (!run || run.recordId !== head.recordId || (run.ownerPid ?? null) !== head.ownerPid || !['queued', 'running'].includes(run.status) || hasLiveOwner(run)) throw retryError();
        tx.putRow({ collection: 'runs', id: head.runId, ownerPackageId: head.ownerPackageId, value: { ...run, status: 'interrupted', stage: 'interrupted', finishedAt: new Date(repository.clock.now()).toISOString() } });
      }
      for (const row of rows) tx.putRow({ collection: 'recoveryRecords', ...row, ...(head.ownerPackageId ? { ownerPackageId: head.ownerPackageId } : {}) });
    });
  };

  const recoverOne = async firstHead => {
    const runId = firstHead.runId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = attempt ? (await repository.queryRecoveryRunHeads({ runId, limit: 1 })).rows[0] : firstHead;
      if (!head) return;
      if (head.deferredReason) { defer(head); return; }
      const prepared = await prepareOrRetry(head);
      if (prepared === preparationChanged) continue;
      const found = !head.snapshotRef && head.mode && terminal.has(head.status)
        ? [issueFor('missing_snapshot', runId)] : await checkSnapshot(prepared);
      const candidate = ['queued', 'running'].includes(head.status) && !hasLiveOwner(head);
      if (!candidate && !found.length) {
        // Clean heads without a snapshot need no lock or second read. Snapshot
        // validation rechecks metadata after asynchronous file IO.
        if (!head.snapshotRef) return;
        const again = await prepareOrRetry((await repository.queryRecoveryRunHeads({ runId, limit: 1 })).rows[0]);
        if (again === preparationChanged) continue;
        if (token(again.head) === token(head) && JSON.stringify(again.file) === JSON.stringify(prepared.file)) return;
        continue;
      }
      const result = await repository.withWriteFence(fence => {
        const current = fence.queryRecoveryRunHeads({ runId, limit: 1 }).rows[0] || null;
        if (token(current) !== token(head)) return { retry: true };
        if (!sameFile(fence, prepared)) return { retry: true };
        const interrupt = ['queued', 'running'].includes(current.status) && !hasLiveOwner(current);
        appendAndInterrupt(fence, current, found, interrupt);
        return { interrupted: interrupt };
      }, { operationMaintenance: true, access: 'management' });
      if (result.retry) continue;
      if (result.interrupted) interruptedRunIds.push(runId);
      issues.push(...found); return;
    }
    throw retryError();
  };

  let afterId;
  do {
    const page = await repository.queryRecoveryRunHeads({ limit: 200, ...(afterId ? { afterId } : {}) });
    for (const head of page.rows) await recoverOne(head);
    afterId = page.hasMore ? page.nextCursor : null;
  } while (afterId);

  const directory = path.join(repository.dataDir, 'runs-v2');
  let entries;
  try { await assertSnapshotPath(repository.dataDir, directory, fs, { allowMissing: true }); entries = await fs.opendir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entries) for await (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const runId = entry.name.slice(0, -5);
    const preliminary = (await repository.queryRecoveryRunHeads({ runId, limit: 1 })).rows[0];
    if (preliminary?.snapshotRef && !preliminary.deferredReason) continue;
    await repository.withWriteFence(fence => {
      const head = fence.queryRecoveryRunHeads({ runId, limit: 1 }).rows[0] || null;
      if (head?.deferredReason) { defer(head); return; }
      if (head?.snapshotRef) return;
      orphanSnapshots.push(runId);
      appendAndInterrupt(fence, head || { runId, ownerPackageId: null }, [{ code: 'orphan_snapshot', runId }], false);
    }, { operationMaintenance: true, access: 'management' });
  }
  return { interruptedRunIds, orphanSnapshots, issues, deferredChecks };
}
