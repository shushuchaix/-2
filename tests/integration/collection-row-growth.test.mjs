import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createRunEventHub } from "../../src/application/run-events.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { rowKey } from "../../src/infrastructure/storage/sqlite-records.mjs";
import { DatabaseSync } from "node:sqlite";
import { createTempDir } from "../helpers/fixtures.mjs";
import { openSqliteRowStore } from "../../src/infrastructure/storage/sqlite-store.mjs";
import { createSqliteCollectionQueries } from "../../src/infrastructure/storage/sqlite-collection-queries.mjs";
import { writeTestEvidence } from "../helpers/evidence.mjs";

test("opening new and existing SQLite stores installs the two fixed collection head indexes", async (t) => {
  const filename = path.join(await createTempDir(t), "head-indexes.sqlite");
  const fresh = openSqliteRowStore({ filename });
  fresh.close();
  let probe = new DatabaseSync(filename);
  assert.ok(
    probe
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='index' AND name='rows_legacy_alias_routing'",
      )
      .get(),
  );
  assert.equal(
    probe
      .prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name IN ('rows_collection_heads','rows_collection_heads_all')",
      )
      .get().n,
    2,
  );
  probe.exec(
    "DROP INDEX rows_collection_heads; DROP INDEX rows_collection_heads_all; DROP INDEX rows_legacy_alias_routing;",
  );
  probe.close();
  const existing = openSqliteRowStore({ filename });
  existing.close();
  probe = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.ok(
      probe
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name='rows_legacy_alias_routing'",
        )
        .get(),
    );
    assert.equal(
      probe
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name IN ('rows_collection_heads','rows_collection_heads_all')",
        )
        .get().n,
      2,
    );
  } finally {
    probe.close();
  }
});

test("unchanged collection polling seeks finite heads through 1k to 100k unrelated changes", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit(),
    initial = await f.service.listSnapshot({ scope: f.scope }),
    probe = new DatabaseSync(path.join(f.dataDir, "workspace.sqlite")),
    receipts = [];
  let seeded = 0;
  const oldSql =
    "SELECT 1 AS changed FROM changes WHERE seq>? AND seq<=? AND (owner_id IS NULL OR (?=1 OR owner_id=?)) AND (collection IN ('runs','activityUnits','budgetUsage','activityMetrics','runEvents','activityJobIds','jobProjections','jobs','observations','evaluations','packages','versionMetadata') OR action='replace') LIMIT 1";
  try {
    for (const size of [1000, 10000, 100000]) {
      probe.exec("BEGIN IMMEDIATE");
      try {
        const insert = probe.prepare(
          "INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES(1,?,?,?,'synthetic-noise','put')",
        );
        for (let index = seeded; index < size; index++)
          insert.run(
            index % 2 ? "sourceHealth" : "budgetUsage",
            "noise-" + index,
            index % 2 ? f.scope.packageId : f.otherScope.packageId,
          );
        probe.exec("COMMIT");
      } catch (error) {
        probe.exec("ROLLBACK");
        throw error;
      }
      seeded = size;
      const globalHead = probe
          .prepare("SELECT max(seq) AS n FROM changes")
          .get().n,
        oldTimes = [],
        newTimes = [];
      f.repository.metrics({ reset: true });
      for (let attempt = 0; attempt < 7; attempt++) {
        let start = performance.now();
        assert.equal(
          probe
            .prepare(oldSql)
            .get(initial.cursor, globalHead, 0, f.scope.packageId),
          undefined,
        );
        oldTimes.push(performance.now() - start);
        start = performance.now();
        const result = await f.service.listSnapshot({
          scope: f.scope,
          afterSeq: initial.cursor,
        });
        newTimes.push(performance.now() - start);
        assert.equal(result.changed, false);
        assert.equal(result.cursor, globalHead);
        assert.deepEqual(result.collections, []);
      }
      const metrics = f.repository.metrics();
      assert.equal(metrics.maintenanceReads, 0);
      assert.equal(metrics.maintenanceExports, 0);
      assert.equal(metrics.rowsWritten, 0);
      assert.ok(
        metrics.decodedRows <= 35,
        `scope checks decoded ${metrics.decodedRows} rows across seven polls`,
      );
      if (receipts.length)
        assert.equal(metrics.decodedRows, receipts[0].decodedRows);
      receipts.push({
        size,
        oldTimes,
        newTimes,
        decodedRows: metrics.decodedRows,
        decodedBytes: metrics.decodedBytes,
      });
    }
    let headSql;
    const statement = (sql) => {
      if (sql.startsWith("SELECT max(seq) AS head FROM (")) headSql = sql;
      return probe.prepare(sql);
    };
    createSqliteCollectionQueries({
      db: probe,
      statement,
    }).queryCollectionSnapshot({ scope: f.scope, afterSeq: initial.cursor });
    assert.ok(headSql);
    const bindings = Array(12).fill(f.scope.packageId),
      plan = probe.prepare("EXPLAIN QUERY PLAN " + headSql).all(...bindings),
      vdbe = probe.prepare("EXPLAIN " + headSql).all(...bindings);
    assert.ok(plan.some((row) => /changes_job_owner/.test(row.detail)));
    assert.ok(plan.every((row) => !/SCAN changes/.test(row.detail)));
    await writeTestEvidence(
      "collection-row-growth", "collection-cursor-noise.json",
      JSON.stringify(
        {
          receipts,
          old: {
            sql: oldSql,
            plan: probe
              .prepare("EXPLAIN QUERY PLAN " + oldSql)
              .all(initial.cursor, 1e12, 0, f.scope.packageId),
            vdbe: probe
              .prepare("EXPLAIN " + oldSql)
              .all(initial.cursor, 1e12, 0, f.scope.packageId),
          },
          current: { sql: headSql, plan, vdbe },
        },
        null,
        2,
      ),
    );
  } finally {
    probe.close();
  }
  await f.service.pause(c.ref);
});

const verifiedJob = (clock) =>
  job({
    title: "消防工程师",
    jobType: "social",
    graduationYear: null,
    description:
      "岗位职责：负责消防工程设施维护、安全检查、工程项目巡检与应急演练。任职要求：本科及以上学历，认真落实消防安全责任，整理工程维护记录，执行巡检操作流程。",
    detailStatus: "complete",
    deadlineAt: "2030-01-01T00:00:00.000Z",
    applyUrl: "https://jobs.example.com/application",
    applicationVerification: {
      status: 200,
      formVerified: true,
      checkedAt: new Date(clock.now()).toISOString(),
    },
  });
test("collection SQL cursor stays a data cursor while quality expires without writes at the exact 72 hour boundary", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit(),
    result = await c.commit({
      pageKey: "verified",
      records: [verifiedJob(f.clock)],
      nextCursor: null,
      done: true,
    });
  await createEvaluationService({ repository: f.repository }).evaluate({
    scope: f.scope,
    jobIds: result.jobIds,
    mode: "rules",
  });
  const first = await f.service.listSnapshot({ scope: f.scope });
  assert.equal(first.collections[0].quality.validNewUnique, 1);
  assert.ok(first.validUntil);
  const cursor = first.cursor;
  f.repository.metrics({ reset: true });
  f.clock.advance(72 * 3600000);
  const exact = await f.service.listSnapshot({ scope: f.scope });
  assert.equal(exact.collections[0].quality.validNewUnique, 1);
  assert.equal(exact.cursor, cursor);
  f.clock.advance(1);
  const unchanged = await f.service.listSnapshot({
    scope: f.scope,
    afterSeq: cursor,
  });
  assert.equal(unchanged.changed, false);
  const expired = await f.service.listSnapshot({ scope: f.scope });
  assert.equal(expired.cursor, cursor);
  assert.equal(expired.collections[0].quality.validNewUnique, 0);
  assert.equal(expired.collections[0].quality.applicationAvailable, 0);
  const metrics = f.repository.metrics();
  assert.equal(metrics.maintenanceReads, 0);
  assert.equal(metrics.maintenanceExports, 0);
  assert.equal(metrics.rowsWritten, 0);
  await f.service.pause(c.ref);
});

test("ledger, activity summary and event head stay bounded with 1k, 5k and 10k unrelated jobs and reservations", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  const [templateId] = await f.ingest(f.otherScope, [
    job({ sourceRecordId: "growth-template" }),
  ]);
  const template = await f.repository.getRow(
    {
      collection: "jobs",
      id: templateId,
      ownerPackageId: f.otherScope.packageId,
    },
    { scope: f.otherScope },
  );
  const hub = createRunEventHub({ repository: f.repository }),
    receipts = [];
  let seeded = 0;
  for (const size of [1000, 5000, 10000]) {
    for (let offset = seeded; offset < size; offset += 200) {
      const count = Math.min(200, size - offset),
        jobs = [],
        reservations = [];
      for (let index = offset; index < offset + count; index++) {
        const id = "growth-job-" + index;
        const value = structuredClone(template);
        value.jobId = id;
        value.recordId = randomUUID();
        value.identityAliases = [];
        value.duplicateGroupIds = [];
        value.canonical = {
          ...value.canonical,
          sourceRecordId: id,
          company: "Synthetic growth company " + index,
          title: "Synthetic growth title " + index,
          description:
            "Synthetic isolated body " + index + " " + ".".repeat(2048),
        };
        jobs.push({
          collection: "jobs",
          id,
          ownerPackageId: f.otherScope.packageId,
          value,
        });
        const reservationId = "history-" + index;
        reservations.push({
          collection: "reservations",
          id: rowKey(
            c.ref.activityId,
            "collectionProgress.ledger.reservations",
            reservationId,
          ),
          ownerPackageId: f.scope.packageId,
          parent: {
            collection: "runs",
            id: c.ref.activityId,
            path: "collectionProgress.ledger.reservations",
          },
          runId: c.ref.activityId,
          targetRevisionId: f.scope.targetRevisionId,
          value: {
            reservationId,
            kind: "request",
            requestUpperBound: 0,
            costUpperBoundCny: 0,
            bytesUpperBound: 0,
            resourceKey: null,
            maxOutputTokens: 4000,
            status: "settled",
            epoch: c.token.epoch,
            sliceRunId: c.token.sliceRunId,
            createdAt: new Date(f.clock.now()).toISOString(),
            verifiedUsage: { requests: 0, bytes: 0, costCny: 0 },
          },
        });
      }
      await f.repository.transaction(
        {
          select: [
            {
              collection: "jobs",
              ownerPackageId: f.otherScope.packageId,
              ids: jobs.map((row) => row.id),
            },
            {
              collection: "reservations",
              ownerPackageId: f.scope.packageId,
              ids: reservations.map((row) => row.id),
            },
          ],
        },
        (tx) => {
          for (const row of [...jobs, ...reservations]) tx.putRow(row);
        },
        { operationMaintenance: true },
      );
    }
    seeded = size;
    const operations = {
      snapshot: () => f.ledger.snapshot(c.ref),
      get: () => f.service.get(c.ref),
      list: () => f.service.listSnapshot({ scope: f.scope }),
      eventHead: () => hub.getHead(c.token.sliceRunId, f.scope),
      reserveSettle: async () => {
        const reservationId = "measured-" + randomUUID();
        await f.ledger.reserve({
          ref: c.ref,
          token: c.token,
          operationLease: c.lease,
          reservationId,
          kind: "list",
          requestUpperBound: 1,
        });
        await f.ledger.settle({
          ref: c.ref,
          operationLease: c.lease,
          reservationId,
          verifiedUsage: { requests: 1 },
        });
      },
    };
    const receipt = { size, operations: {} };
    for (const [name, operation] of Object.entries(operations)) {
      f.repository.metrics({ reset: true });
      const elapsed = [];
      for (let attempt = 0; attempt < 7; attempt++) {
        const start = performance.now();
        await operation();
        elapsed.push(performance.now() - start);
      }
      elapsed.sort((a, b) => a - b);
      const metrics = f.repository.metrics();
      assert.equal(metrics.maintenanceReads, 0);
      assert.equal(metrics.maintenanceMutations, 0);
      assert.equal(metrics.maintenanceExports, 0);
      assert.ok(
        metrics.decodedBytes < 250000,
        `${name} decoded ${metrics.decodedBytes}`,
      );
      assert.ok(
        metrics.decodedRows < 250,
        `${name} decoded ${metrics.decodedRows}`,
      );
      receipt.operations[name] = {
        p50Ms: elapsed[3],
        p95Ms: elapsed[6],
        maxMs: elapsed[6],
        decodedRows: metrics.decodedRows,
        decodedBytes: metrics.decodedBytes,
        rowsWritten: metrics.rowsWritten,
        maintenanceReads: metrics.maintenanceReads,
        maintenanceExports: metrics.maintenanceExports,
      };
    }
    receipts.push(receipt);
  }
  await writeTestEvidence(
    "collection-row-growth", "growth-receipt.json",
    JSON.stringify(
      { node: process.version, measuredAt: new Date().toISOString(), receipts },
      null,
      2,
    ),
  );
  const probe = new DatabaseSync(path.join(f.dataDir, "workspace.sqlite"), {
      readOnly: true,
    }),
    plans = [];
  try {
    const statement = (sql) => {
      const prepared = probe.prepare(sql);
      return Object.fromEntries(
        ["get", "all"].map((method) => [
          method,
          (...bindings) => {
            plans.push({
              sql,
              plan: probe.prepare("EXPLAIN QUERY PLAN " + sql).all(...bindings),
            });
            return prepared[method](...bindings);
          },
        ]),
      );
    };
    const queries = createSqliteCollectionQueries({ db: probe, statement });
    queries.queryCollectionSnapshot({ scope: f.scope, asOf: f.clock.now() });
    queries.queryCollectionSnapshot({ allTargets: true, asOf: f.clock.now() });
    queries.queryRunHeads({ scope: f.scope });
    const heads = plans.filter((item) =>
      item.sql.includes("r.kind='collection_root'"),
    );
    assert.equal(heads.length, 2);
    assert.ok(
      heads[0].plan.some((row) => /rows_collection_heads/.test(row.detail)),
    );
    assert.ok(
      heads[1].plan.some((row) => /rows_collection_heads_all/.test(row.detail)),
    );
    assert.ok(
      heads.every((item) =>
        item.plan.every((row) => !/ORDER BY/.test(row.detail)),
      ),
    );
    for (const [sql, bindings] of [
      [
        "SELECT value FROM rows WHERE collection='reservations' AND owner_id=? AND id=?",
        [
          f.scope.packageId,
          rowKey(
            c.ref.activityId,
            "collectionProgress.ledger.reservations",
            "history-1",
          ),
        ],
      ],
      [
        "SELECT value FROM rows WHERE collection='activityJobIds' AND owner_id=? AND parent_id=? AND part_path=? ORDER BY ordinal DESC LIMIT 1",
        [f.scope.packageId, c.ref.activityId, "collectionProgress.newJobIds"],
      ],
    ])
      plans.push({
        sql,
        plan: probe.prepare("EXPLAIN QUERY PLAN " + sql).all(...bindings),
      });
    await writeTestEvidence(
      "collection-row-growth", "collection-query-plans.json",
      JSON.stringify(plans, null, 2),
    );
  } finally {
    probe.close();
  }
  await f.service.pause(c.ref);
});
