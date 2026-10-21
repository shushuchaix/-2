import { randomUUID } from "node:crypto";
import { packageError } from "./packages.mjs";

export const COLLECTION_STATUSES = [
  "collecting",
  "paused",
  "waiting_for_auth",
  "budget_exhausted",
  "completed",
  "cancelled",
];
const terminal = new Set(["completed", "cancelled"]);
const plain = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const credentialKey =
  /^(?:cookie|cookies|authorization|password|access_token|refresh_token|client_secret|oauth_token|apiKey|api_key)$/i;
const invalid = () =>
  packageError(
    "collection_progress",
    "collection_progress: 采集进度格式无效。",
    400,
  );
const scopeError = () =>
  packageError("collection_scope", "collection_scope: 采集活动归属不一致。");
export function assertCollectionWrite(workspace, { ref, token }) {
  const root = workspace.runs?.[ref?.activityId],
    p = root?.collectionProgress;
  if (
    !root ||
    root.ownerPackageId !== ref?.scope?.packageId ||
    root.targetSnapshot?.revisionId !== ref.scope.targetRevisionId ||
    !token ||
    p?.epoch !== token.epoch ||
    p.activeSliceRunId !== token.sliceRunId ||
    p.status !== "collecting"
  )
    throw packageError(
      "collection_stale_epoch",
      "活动已停止，不能写入迟到结果。",
    );
}

/** @typedef {{packageId:string,targetRevisionId:string}} Scope */
/** @typedef {{scope:Scope,activityId:string}} ActivityRef */
/** @typedef {{epoch:number,expectedRevision:number,sliceRunId:string}} CommitToken */
/** @typedef {{status:string,epoch:number,revision:number,activeSliceRunId:string|null,units:Object,limits:Object,ledger:Object,metrics:Object,planHash:string,catalogHash:string,queryHash:string,parserVersion:string}} CollectionProgress */
/** @typedef {{unitId:string,sourceId:string,siteId:string,queryIndex:number,cursor:Object|null,nextDueAt:string|null,committedPages:number,committedPageKeys:string[],status:string,lastErrorCode:string|null}} CollectionUnit */

function assertFiniteJson(value, { depth = 0 } = {}) {
  if (depth > 8) throw invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 4096) throw invalid();
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw invalid();
    for (const entry of value) assertFiniteJson(entry, { depth: depth + 1 });
    return;
  }
  if (!plain(value) || Object.keys(value).length > 128) throw invalid();
  for (const [key, entry] of Object.entries(value)) {
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      credentialKey.test(key)
    )
      throw invalid();
    assertFiniteJson(entry, { depth: depth + 1 });
  }
}
export function assertCollectionSettings(settings) {
  if (settings === undefined) return;
  if (
    !plain(settings) ||
    !plain(settings.sourceOverrides) ||
    !plain(settings.sessionRefs) ||
    typeof settings.refreshEnabled !== "boolean"
  )
    throw invalid();
  assertFiniteJson(settings);
  if (
    Object.values(settings.sessionRefs).some(
      (ref) => typeof ref !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/.test(ref),
    )
  )
    throw invalid();
}
export function createCollectionRoot({
  runId,
  scope,
  targetSnapshot,
  profileSnapshot,
  plan = {},
  limits = {},
  now = Date.now(),
}) {
  const createdAt = new Date(now).toISOString();
  const units = {};
  for (const unit of plan.units || []) {
    if (!unit.unitId || Object.hasOwn(units, unit.unitId)) throw invalid();
    units[unit.unitId] = {
      ...structuredClone(unit),
      cursor: unit.cursor ?? null,
      nextDueAt: unit.nextDueAt ?? null,
      committedPages: 0,
      committedPageKeys: [],
      status: "pending",
      lastErrorCode: null,
    };
  }
  return {
    runId,
    recordId: randomUUID(),
    ownerPackageId: scope.packageId,
    collectionRole: "collection_root",
    targetSnapshot: structuredClone(targetSnapshot),
    profileSnapshot: structuredClone(
      profileSnapshot || targetSnapshot?.profileSnapshot,
    ),
    status: "completed",
    stage: "planned",
    createdAt,
    startedAt: null,
    finishedAt: createdAt,
    events: [],
    lastSeq: 0,
    coverage: [],
    counts: {},
    usage: {},
    issues: [],
    snapshotRef: null,
    collectionProgress: {
      status: "paused",
      epoch: 0,
      revision: 0,
      activeSliceRunId: null,
      planHash: plan.hashes?.planHash || "initial",
      catalogHash: plan.hashes?.catalogHash || "initial",
      queryHash: plan.hashes?.queryHash || "initial",
      parserVersion: plan.hashes?.parserVersion || "v1",
      units,
      limits: structuredClone(limits),
      ledger: { revision: 0, reservations: {}, usage: {} },
      metrics: {},
      updatedAt: createdAt,
    },
  };
}
export function assertCollectionRun(run, workspace) {
  if (
    run.collectionRole === undefined &&
    run.collectionProgress === undefined &&
    run.collectionActivityId === undefined
  )
    return;
  if (!["collection_root", "collection_slice"].includes(run.collectionRole))
    throw invalid();
  const owner = workspace.packages?.[run.ownerPackageId];
  if (
    !owner ||
    owner.kind !== "target" ||
    owner.versionId !== run.targetSnapshot?.revisionId ||
    run.targetSnapshot?.ownerPackageId !== run.ownerPackageId
  )
    throw scopeError();
  if (
    run.profileSnapshot?.ownerPackageId &&
    run.profileSnapshot.ownerPackageId !== run.ownerPackageId
  )
    throw scopeError();
  if (run.collectionRole === "collection_slice") {
    const root = workspace.runs?.[run.collectionActivityId];
    if (
      !root ||
      root.collectionRole !== "collection_root" ||
      root.ownerPackageId !== run.ownerPackageId ||
      root.targetSnapshot?.revisionId !== run.targetSnapshot?.revisionId
    )
      throw scopeError();
    if (run.collectionProgress !== undefined) throw invalid();
    return;
  }
  const p = run.collectionProgress;
  if (
    run.status !== "completed" ||
    !plain(p) ||
    !COLLECTION_STATUSES.includes(p.status) ||
    !integer(p.epoch) ||
    !integer(p.revision) ||
    !plain(p.units) ||
    !plain(p.limits) ||
    !plain(p.ledger) ||
    !plain(p.ledger.reservations) ||
    !integer(p.ledger.revision)
  )
    throw invalid();
  for (const key of ["planHash", "catalogHash", "queryHash", "parserVersion"])
    if (typeof p[key] !== "string" || !p[key] || p[key].length > 160)
      throw invalid();
  for (const [key, value] of Object.entries(p.limits))
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (key !== "maxCostCny" && !integer(value))
    )
      throw invalid();
  for (const [id, unit] of Object.entries(p.units)) {
    if (
      !plain(unit) ||
      unit.unitId !== id ||
      !integer(unit.committedPages) ||
      !Array.isArray(unit.committedPageKeys) ||
      unit.committedPages !== unit.committedPageKeys.length ||
      new Set(unit.committedPageKeys).size !== unit.committedPageKeys.length ||
      unit.committedPageKeys.some(
        (k) => typeof k !== "string" || k.length > 160,
      )
    )
      throw invalid();
    if (unit.cursor !== null && !plain(unit.cursor)) throw invalid();
    assertFiniteJson(unit.cursor);
    if (JSON.stringify(unit.cursor).length > 16384) throw invalid();
  }
  if (p.activeSliceRunId !== null) {
    const child = workspace.runs?.[p.activeSliceRunId];
    if (
      !child ||
      child.collectionRole !== "collection_slice" ||
      child.collectionActivityId !== run.runId ||
      child.ownerPackageId !== run.ownerPackageId
    )
      throw scopeError();
    if (terminal.has(p.status)) throw invalid();
  }
}
/** Normalize a copy, never reset reservations or revive terminal activities. */
export function normalizeCollectionRun(run, { restored = false } = {}) {
  const result = structuredClone(run);
  if (
    restored &&
    result.collectionRole === "collection_root" &&
    !terminal.has(result.collectionProgress?.status)
  ) {
    const p = result.collectionProgress;
    p.status = "paused";
    p.epoch++;
    p.revision++;
    p.activeSliceRunId = null;
    p.pauseReason = "restored";
  }
  if (
    restored &&
    result.collectionRole === "collection_slice" &&
    ["queued", "running"].includes(result.status)
  )
    result.status = "interrupted";
  return result;
}
export function normalizeCollectionWorkspace(
  workspace,
  { restored = false, clearSessions = false } = {},
) {
  for (const [id, run] of Object.entries(workspace.runs || {}))
    if (run.collectionRole)
      workspace.runs[id] = normalizeCollectionRun(run, { restored });
  if (clearSessions)
    for (const pkg of Object.values(workspace.packages || {}))
      if (pkg.collectionSettings) {
        pkg.collectionSettings.sessionRefs = {};
        pkg.collectionSettings.refreshEnabled = false;
        pkg.collectionSettings.serviceCapabilities = {};
        for (const id of ["weibo-official", "wechat-authorized"])
          if (pkg.collectionSettings.sourceOverrides?.[id])
            pkg.collectionSettings.sourceOverrides[id].enabled = false;
      }
  return workspace;
}
