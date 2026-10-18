import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteRecoveryQueries } from '../../src/infrastructure/storage/sqlite-recovery-queries.mjs';

test('fixed recovery metadata pages include all versions and collection roots without materializing private parts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE rows(collection TEXT,id TEXT,record_id TEXT,owner_id TEXT,ordinal INTEGER,run_id TEXT,value TEXT,PRIMARY KEY(collection,id));
      CREATE TABLE package_keys(id TEXT PRIMARY KEY,kind TEXT,state TEXT);`);
    const insert = db.prepare('INSERT INTO rows VALUES(?,?,?,?,?,?,?)');
    for (const [id, state] of [['active', 'active'], ['trash', 'trashed'], ['pending', 'purge_pending'], ['purged', 'purged']]) {
      db.prepare('INSERT INTO package_keys VALUES(?,?,?)').run(id, 'target', state);
      insert.run('packages', id, null, null, 0, null, JSON.stringify({ purgeAt: '2026-10-08T00:00:00.000Z', profile: 'PRIVATE-PROFILE' }));
    }
    for (let index = 0; index < 205; index++) {
      const id = 'run-' + String(index).padStart(3, '0'), owner = ['active', 'trash', 'pending', 'purged'][index % 4];
      insert.run('runs', id, 'record-' + index, owner, 0, id, JSON.stringify({ runId: id, status: 'completed', mode: 'rules', collectionRole: index === 0 ? 'collection_root' : 'collection_slice', snapshotRef: { path: `runs-v2/${id}.json`, hash: 'hash' }, description: 'PRIVATE-BODY', profileSnapshot: { text: 'PRIVATE-RESUME' }, collectionProgress: { ledger: { reservations: { private: 'DO-NOT-DECODE' } } } }));
    }
    let counted = 0; const seenSql = [];
    const queries = createSqliteRecoveryQueries({ statement(sql) { seenSql.push(sql); return db.prepare(sql); }, countRows(n) { counted += n; } });
    const first = queries.queryRecoveryRunHeads({ limit: 200 }); assert.equal(first.rows.length, 200); assert.equal(first.hasMore, true);
    const last = queries.queryRecoveryRunHeads({ limit: 200, afterId: first.nextCursor }); assert.equal(last.rows.length, 5); assert.equal(last.hasMore, false); assert.equal(counted, 205);
    assert.equal(first.rows[0].collectionRole, 'collection_root'); assert.deepEqual(new Set(first.rows.map(row => row.packageState)), new Set(['active', 'trashed', 'purge_pending', 'purged']));
    assert.equal(/PRIVATE|DO-NOT-DECODE/.test(JSON.stringify([first, last])), false);
    assert.equal(seenSql.some(sql => /SELECT\s+(?:\*|r\.value)\b/i.test(sql)), false);
    assert.equal(queries.queryRecoveryRunHeads({ runId: 'run-004', limit: 1 }).rows[0].runId, 'run-004');
    for (const input of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { afterId: 2 }, { arbitrary: '$.secret' }, { runId: 'x', afterId: 'y' }]) assert.throws(() => queries.queryRecoveryRunHeads(input));
    assert.throws(() => queries.queryRecoveryRecordKeys({ runId: 'x', where: { code: 'x' } }));
  } finally { db.close(); }
});
