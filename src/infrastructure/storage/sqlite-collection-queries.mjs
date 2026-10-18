import { collectionUsageSnapshot } from "../../domain/collection-projections.mjs";
import { createSqliteJobQueries } from "./sqlite-job-queries.mjs";

const invalid = () =>
  Object.assign(Error("Invalid collection query."), {
    code: "sqlite_selection_invalid",
    status: 400,
  });
const relevant = [
  "runs",
  "activityUnits",
  "budgetUsage",
  "activityMetrics",
  "runEvents",
  "activityJobIds",
  "jobProjections",
  "jobs",
  "observations",
  "evaluations",
  "versionMetadata",
];
/** Fixed storage queries. The core owns the read transaction and authorization. */
export function createSqliteCollectionQueries({
  db,
  statement = (sql) => db.prepare(sql),
  countRows = () => {},
  countDecoded = () => {},
}) {
  const jobs = createSqliteJobQueries({ db, statement, countRows });
  function queryCollectionSlicePage({
    scope,
    activityId,
    afterId = "",
    limit = 200,
    excludedOwnerPackageIds = [],
  } = {}) {
    const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096;
    if (!text(scope?.packageId) || !text(scope?.targetRevisionId) || !text(activityId) ||
      typeof afterId !== "string" || afterId.length > 4096 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid();
    const root = statement(`SELECT 1 AS present FROM rows r JOIN package_keys k ON k.id=r.owner_id
      WHERE r.collection='runs' AND r.id=? AND r.owner_id=? AND r.target_revision_id=?
      AND r.kind='collection_root' AND k.kind='target' AND k.state='active'
      AND NOT EXISTS(SELECT 1 FROM json_each(?) excluded WHERE excluded.value=r.owner_id)`)
      .get(activityId, scope.packageId, scope.targetRevisionId, JSON.stringify(excludedOwnerPackageIds));
    countRows(1);
    if (!root) throw Object.assign(Error("采集活动不属于此目标版本。"), { code: "collection_scope", status: 409 });
    // Existing collectionActivityId references and row_refs_target_fk route only
    // this activity's children; slice bodies and unrelated runs are not decoded.
    const rows = statement(`SELECT refs.id AS runId FROM row_refs refs INDEXED BY row_refs_target_fk
      CROSS JOIN rows r
      WHERE refs.target_collection='runs' AND refs.target_id=? AND refs.owner_id=?
      AND refs.collection='runs' AND refs.field='collectionActivityId' AND refs.id>?
      AND r.collection='runs' AND r.id=refs.id AND r.owner_id=refs.owner_id
      AND r.target_revision_id=? AND r.kind='collection_slice'
      ORDER BY refs.id LIMIT ?`)
      .all(activityId, scope.packageId, afterId, scope.targetRevisionId, limit + 1);
    countRows(rows.length);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { sliceRunIds: rows.map((row) => row.runId), hasMore,
      nextCursor: hasMore ? rows.at(-1).runId : null };
  }
  function decode(value) {
    if (value == null) return null;
    countDecoded(value);
    return JSON.parse(value);
  }
  function queryCollectionSnapshot({
    scope,
    allTargets = false,
    afterSeq,
    limit = 200,
    asOf = Date.now(),
    excludedOwnerPackageIds = [],
    activityId,
  } = {}) {
    if (
      typeof allTargets !== "boolean" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (afterSeq !== undefined &&
        (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) ||
      (!allTargets && (!scope?.packageId || !scope?.targetRevisionId)) ||
      (allTargets && (scope?.packageId || scope?.targetRevisionId))
    )
      throw invalid();
    const at = new Date(asOf).toISOString();
    const cursor = statement(
      "SELECT coalesce(max(seq),0) AS head FROM changes",
    ).get().head;
    countRows(1);
    if (afterSeq !== undefined && afterSeq > cursor) throw invalid();
    let changed = afterSeq === undefined;
    if (!changed && excludedOwnerPackageIds.length) {
      const hidden = statement(
        "SELECT 1 AS n FROM package_keys k JOIN json_each(?) excluded ON excluded.value=k.id WHERE k.state='active' AND (?=1 OR k.id=?) LIMIT 1",
      ).get(
        JSON.stringify(excludedOwnerPackageIds),
        allTargets ? 1 : 0,
        scope?.packageId || null,
      );
      countRows(hidden ? 1 : 0);
      changed = !!hidden;
    }
    if (!changed) {
      // Each branch seeks the last relevant sequence through a fixed composite index.
      // A global afterSeq range would scan unrelated owners and ledger churn.
      const branches = relevant.map(
        (collection) =>
          `SELECT coalesce(max(seq),0) AS seq FROM changes WHERE collection='${collection}'${allTargets ? "" : " AND owner_id=?"}`,
      );
      branches.push(
        `SELECT coalesce(max(seq),0) AS seq FROM changes WHERE collection='packages'${allTargets ? "" : " AND id=?"}`,
      );
      branches.push(
        "SELECT coalesce(max(seq),0) AS seq FROM changes WHERE collection='workspace'",
      );
      const row = statement(
        `SELECT max(seq) AS head FROM (${branches.join(" UNION ALL ")})`,
      ).get(
        ...(allTargets ? [] : Array(relevant.length + 1).fill(scope.packageId)),
      );
      countRows(1);
      changed = row.head > afterSeq;
    }
    if (!changed) return { cursor, changed: false, collections: [] };
    const ownerCondition = allTargets
      ? "1=1"
      : "r.owner_id=? AND r.target_revision_id=?";
    const rootBindings = [
      ...(allTargets ? [] : [scope.packageId, scope.targetRevisionId]),
      ...(activityId ? [activityId] : []),
      JSON.stringify(excludedOwnerPackageIds),
      limit,
    ];
    const rows =
      statement(`SELECT r.id,r.owner_id,r.target_revision_id,r.value,u.value AS usage,m.value AS metrics,k.version_id,
        json_extract(p.value,'$.versionName') AS version_name
      FROM rows r ${activityId ? "" : `INDEXED BY ${allTargets ? "rows_collection_heads_all" : "rows_collection_heads"}`} JOIN package_keys k ON k.id=r.owner_id
      JOIN rows p ON p.collection='packages' AND p.id=k.id
      LEFT JOIN rows u ON u.collection='budgetUsage' AND u.owner_id=r.owner_id AND u.id=r.id
      LEFT JOIN rows m ON m.collection='activityMetrics' AND m.owner_id=r.owner_id AND m.id=r.id
      WHERE r.collection='runs' AND r.kind='collection_root' AND k.kind='target' AND k.state='active'
        AND ${ownerCondition}
        ${activityId ? "AND r.id=?" : ""}
        AND NOT EXISTS(SELECT 1 FROM json_each(?) excluded WHERE excluded.value=r.owner_id)
      ORDER BY r.sort_at DESC,r.id ASC LIMIT ?`).all(...rootBindings);
    countRows(rows.length);
    const collections = rows.map((row) => {
      const root = decode(row.value),
        usage = collectionUsageSnapshot(
          root.collectionProgress,
          decode(row.usage),
        ),
        metrics = decode(row.metrics) || {};
      root.collectionUsage = usage;
      root.scope = {
        packageId: row.owner_id,
        targetRevisionId: row.target_revision_id || row.version_id,
      };
      root.versionName = row.version_name;
      root.collectionProgress.metrics = {
        ...metrics,
        ...root.collectionProgress.metrics,
      };
      root.collectionProgress.unitSummary =
        statement(`SELECT count(*) AS totalUnits,
        coalesce(sum(CASE WHEN status<>'completed' THEN 1 ELSE 0 END),0) AS pendingUnits,
        count(DISTINCT json_array(source_id,site_id)) AS plannedSites,
        count(DISTINCT CASE WHEN json_extract(value,'$.committedPages')>0 THEN json_array(source_id,site_id) END) AS actualSites
        FROM rows WHERE collection='activityUnits' AND owner_id=? AND parent_id=?`).get(
          row.owner_id,
          row.id,
        );
      countRows(1);
      if (activityId) {
        const unitRows = statement(
          "SELECT id,json_remove(value,'$.seenIds','$.seenFingerprints','$.seenCursorHashes','$.committedPageKeys') AS value FROM rows WHERE collection='activityUnits' AND owner_id=? AND parent_id=? AND part_path='collectionProgress.units' ORDER BY id LIMIT 201",
        ).all(row.owner_id, row.id);
        countRows(unitRows.length);
        root.collectionProgress.units = Object.fromEntries(
          unitRows.slice(0, 200).map((unitRow) => {
            const unit = decode(unitRow.value);
            return [unit.unitId, unit];
          }),
        );
        root.collectionProgress.unitPage = {
          hasMore: unitRows.length > 200,
          nextCursor: unitRows.length > 200 ? unitRows[199].id : null,
        };
      }
      root.quality = jobs.queryJobQuality({
        ownerPackageId: row.owner_id,
        activityId: row.id,
        asOf: at,
      });
      root.quality.knownRequests = usage.knownPhysicalRequests;
      root.quality.unknownRequestUpperBound = usage.unknownRequestUpperBound;
      root.quality.validPer100KnownRequests = usage.knownPhysicalRequests
        ? (root.quality.validNewUnique / usage.knownPhysicalRequests) * 100
        : null;
      root.collectionProgress.metrics.validNewUnique =
        root.quality.validNewUnique;
      return root;
    });
    const boundaries = collections
      .map((root) => root.quality.nextTemporalChangeAt)
      .filter(
        (value) =>
          typeof value === "string" && Date.parse(value) > Date.parse(at),
      )
      .sort();
    return {
      cursor,
      changed: true,
      collections,
      asOf: at,
      validUntil: boundaries[0] || null,
    };
  }
  function queryRunHeads({
    scope,
    allTargets = false,
    status,
    limit = 200,
    offset = 0,
    excludedOwnerPackageIds = [],
  } = {}) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      (!allTargets && (!scope?.packageId || !scope?.targetRevisionId))
    )
      throw invalid();
    const where = `r.collection='runs' AND coalesce(r.kind,'')<>'collection_root' AND k.kind='target' AND k.state='active'
      AND json_extract(r.value,'$.deletedAt') IS NULL ${allTargets ? "" : "AND r.owner_id=? AND r.target_revision_id=?"}
      ${status ? "AND r.status=?" : ""} AND NOT EXISTS(SELECT 1 FROM json_each(?) excluded WHERE excluded.value=r.owner_id)`;
    const bindings = [
      ...(allTargets ? [] : [scope.packageId, scope.targetRevisionId]),
      ...(status ? [status] : []),
      JSON.stringify(excludedOwnerPackageIds),
    ];
    const from =
      "FROM rows r JOIN package_keys k ON k.id=r.owner_id JOIN rows p ON p.collection='packages' AND p.id=k.id";
    const total = statement(`SELECT count(*) AS n ${from} WHERE ${where}`).get(
      ...bindings,
    ).n;
    const rows = statement(
      `SELECT r.value,r.owner_id,r.target_revision_id,json_extract(p.value,'$.versionName') AS version_name ${from} WHERE ${where} ORDER BY r.sort_at DESC,r.id ASC LIMIT ? OFFSET ?`,
    ).all(...bindings, limit, offset);
    countRows(rows.length + 1);
    return {
      runs: rows.map((row) => ({
        ...decode(row.value),
        scope: {
          packageId: row.owner_id,
          targetRevisionId: row.target_revision_id,
        },
        versionName: row.version_name,
      })),
      total,
      hasMore: offset + rows.length < total,
    };
  }
  return Object.freeze({ queryCollectionSnapshot, queryRunHeads, queryCollectionSlicePage });
}
