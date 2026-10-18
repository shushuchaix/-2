/** Fixed startup recovery metadata only. No arbitrary JSON paths or private DTOs. */
export function createSqliteRecoveryQueries({ statement, countRows }) {
  const options = (input, allowed) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw Error('Invalid recovery metadata selector');
    const { limit = 200, afterId = '' } = input;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || typeof afterId !== 'string' || afterId.length > 4096) throw Error('Invalid recovery metadata cursor');
    return { limit, afterId };
  };
  const page = (rows, limit) => {
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    countRows(rows.length);
    return { rows, hasMore, nextCursor: hasMore ? rows.at(-1).id : null };
  };
  return {
    queryRecoveryRunHeads(input = {}) {
      const { limit, afterId } = options(input, ['runId', 'afterId', 'limit']);
      if (input.runId !== undefined && (typeof input.runId !== 'string' || input.runId.length > 4096 || input.afterId !== undefined)) throw Error('Invalid recovery run identity');
      const single = input.runId !== undefined;
      const rows = statement(`SELECT r.id, r.record_id AS recordId, r.owner_id AS ownerPackageId,
        json_extract(r.value,'$.ownerPid') AS ownerPid,
        json_extract(r.value,'$.mode') AS mode, json_extract(r.value,'$.status') AS status,
        json_extract(r.value,'$.collectionRole') AS collectionRole,
        json_type(r.value,'$.snapshotRef') AS snapshotRefType,
        json_extract(r.value,'$.snapshotRef.path') AS snapshotPath,
        json_extract(r.value,'$.snapshotRef.hash') AS snapshotHash,
        k.kind AS packageKind, k.state AS packageState, json_extract(p.value,'$.purgeAt') AS purgeAt
        FROM rows r LEFT JOIN package_keys k ON k.id=r.owner_id
        LEFT JOIN rows p ON p.collection='packages' AND p.id=r.owner_id
        WHERE r.collection='runs' AND r.id ${single ? '=' : '>'} ? ORDER BY r.id LIMIT ?`)
        .all(single ? input.runId : afterId, limit + 1)
        .map(row => ({ ...row, runId: row.id, snapshotRef: row.snapshotRefType === null || row.snapshotRefType === 'null' ? null : { path: row.snapshotPath, hash: row.snapshotHash } }));
      return page(rows, limit);
    },
    queryRecoveryRecordKeys(input) {
      const { limit, afterId } = options(input, ['runId', 'afterId', 'limit']);
      if (typeof input.runId !== 'string' || input.runId.length > 4096) throw Error('Invalid recovery record identity');
      const rows = statement(`SELECT id,ordinal,record_id AS recordId,
        json_extract(value,'$.code') AS code FROM rows
        WHERE collection='recoveryRecords' AND run_id=? AND id>? ORDER BY id LIMIT ?`)
        .all(input.runId, afterId, limit + 1);
      return page(rows, limit);
    },
  };
}
