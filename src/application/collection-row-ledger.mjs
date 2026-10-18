import { packageError } from "../domain/packages.mjs";
import { contentHash } from "../infrastructure/storage/content-hash.mjs";
import { rowKey } from "../infrastructure/storage/sqlite-records.mjs";
import { validateCollectionLimits } from "../../public/js/validation-rules.js";
import {
  quoteVerifiedModelUsage,
  isOfficialDeepSeekFlash,
} from "../llm/budget.mjs";
import {
  amountMicros,
  changeCollectionUsage,
  collectionUsageSnapshot,
} from "../domain/collection-projections.mjs";
import {
  collectionPartId,
  rowSelector,
  collectionRoot,
  collectionLease,
  collectionToken,
  leaseSelector,
  putCollectionPart,
  readCollectionHead,
} from "./collection-row-access.mjs";

const kinds = new Set([
  "request",
  "list",
  "detail",
  "search",
  "dns",
  "redirect",
  "retry",
  "resource",
  "attachment",
  "browser",
  "worker",
  "model",
  "detail_credit",
  "attachment_credit",
]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const invalid = () =>
  packageError("collection_reservation_invalid", "采集额度预约参数无效。", 400);
const modelError = () =>
  packageError("model_budget_exhausted", "model_budget_exhausted", 409);
const exhausted = (budgetKind) =>
  Object.assign(
    packageError("source_budget_exhausted", "source_budget_exhausted", 409),
    { budgetKind },
  );
const identity = (value) => ({
  model: value.model,
  baseUrl:
    new URL(value.baseUrl).origin +
    new URL(value.baseUrl).pathname.replace(/\/$/, ""),
});
const path = "collectionProgress.ledger.reservations";
const same = (a, b) => contentHash(a) === contentHash(b);
function assertBatch(items) {
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > 64 ||
    items.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    ) ||
    new Set(items.map((item) => item.reservationId)).size !== items.length
  )
    throw invalid();
}
function validateReservation(input) {
  const r = {
    requestUpperBound: 0,
    costUpperBoundCny: 0,
    bytesUpperBound: 0,
    resourceKey: null,
    maxOutputTokens: 4000,
    modelRequestLimit: 1000,
    ...input,
  };
  if (
    typeof r.reservationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(r.reservationId) ||
    !kinds.has(r.kind) ||
    !integer(r.requestUpperBound) ||
    !integer(r.bytesUpperBound) ||
    !Number.isFinite(r.costUpperBoundCny) ||
    r.costUpperBoundCny < 0 ||
    r.costUpperBoundCny > 10 ||
    Math.abs(r.costUpperBoundCny * 1e6 - amountMicros(r.costUpperBoundCny)) >
      1e-6 ||
    !integer(r.maxOutputTokens) ||
    !integer(r.modelRequestLimit) ||
    r.modelRequestLimit > 1000
  )
    throw invalid();
  if (r.kind !== "model" && r.costUpperBoundCny) throw invalid();
  r.resourceKey =
    r.resourceKey === null ? null : contentHash(String(r.resourceKey));
  return r;
}
export function createRowCollectionLedger({
  repository,
  clock = repository.clock,
}) {
  const snapshotOf = (p, u) => collectionUsageSnapshot(p, u);
  function select(input, items, { resources = false, rotation = false } = {}) {
    const select = [
      rowSelector("runs", input.ref.scope, [
        input.ref.activityId,
        ...(input.token?.sliceRunId ? [input.token.sliceRunId] : []),
      ]),
      rowSelector("budgetUsage", input.ref.scope, [input.ref.activityId]),
      leaseSelector(input.operationLease),
      rowSelector(
        "reservations",
        input.ref.scope,
        items.map((item) =>
          collectionPartId(input.ref.activityId, path, item.reservationId),
        ),
      ),
    ];
    if (rotation)
      select.push(
        rowSelector("sourceRotation", input.ref.scope, [
          rowKey(input.ref.scope.packageId, "collection-source-rotation"),
        ]),
      );
    if (resources)
      for (const r of items)
        if (
          ["detail_credit", "attachment_credit"].includes(r.kind) &&
          r.resourceKey
        )
          select.push({
            collection: "reservations",
            ownerPackageId: input.ref.scope.packageId,
            where: {
              runId: input.ref.activityId,
              kind: r.kind,
              resourceKey: r.resourceKey,
            },
            limit: 1,
          });
    if (input.settlements)
      select.push({
        collection: "reservations",
        ownerPackageId: input.ref.scope.packageId,
        where: {
          runId: input.ref.activityId,
          kind: "browser",
          status: "reserved",
        },
        limit: 1,
        total: true,
      });
    return { select };
  }
  async function transaction(input, items, action, options) {
    return (
      await repository.transaction(
        select(input, items, options),
        (tx) => {
          collectionLease(tx.view, input.ref.scope, input.operationLease);
          const root = collectionRoot(tx.view, input.ref),
            p = root.collectionProgress,
            usage = tx.getRow({
              collection: "budgetUsage",
              id: input.ref.activityId,
            });
          snapshotOf(p, usage); // A ready root may never observe an absent/old aggregate.
          const beforeRoot = contentHash(root),
            beforeUsage = contentHash(usage);
          const result = action({ tx, root, p, usage });
          if (beforeRoot !== contentHash(root))
            tx.putRow({ collection: "runs", id: root.runId, value: root });
          if (beforeUsage !== contentHash(usage))
            tx.putRow({
              collection: "budgetUsage",
              id: root.runId,
              value: usage,
            });
          return result;
        },
        { scope: input.ref.scope, operationLease: input.operationLease },
      )
    ).result;
  }
  function reserveOne(state, input, browser = false) {
    const { tx, p, usage } = state;
    collectionToken(p, input.token);
    const {
      reservationId,
      kind,
      requestUpperBound,
      costUpperBoundCny,
      bytesUpperBound,
      resourceKey,
      maxOutputTokens,
      modelRequestLimit,
    } = input;
    const previous = tx.getRow({
      collection: "reservations",
      id: collectionPartId(input.ref.activityId, path, reservationId),
    });
    if (previous) {
      const original = [
        "kind",
        "requestUpperBound",
        "costUpperBoundCny",
        "bytesUpperBound",
        "resourceKey",
        "maxOutputTokens",
      ].every((key) => previous[key] === input[key]);
      if (
        !original ||
        (kind === "model" &&
          (!same(
            previous.modelIdentity || null,
            input.modelIdentity ? identity(input.modelIdentity) : null,
          ) ||
            (previous.pricingVersion || null) !==
              (input.pricingVersion || null)))
      )
        throw packageError(
          "collection_reservation_conflict",
          "预约身份已用于不同请求。",
        );
      if (browser && previous.operationId !== input.operationLease.operationId)
        throw packageError(
          "invalid_operation_lease",
          "窗口预约不属于原采集租约。",
        );
      return { ...previous, duplicate: true, snapshot: snapshotOf(p, usage) };
    }
    if (["detail_credit", "attachment_credit"].includes(kind) && resourceKey) {
      const existing = Object.values(tx.view.rows.reservations || {}).find(
        (r) => r.kind === kind && r.resourceKey === resourceKey,
      );
      if (existing)
        return { ...existing, duplicate: true, snapshot: snapshotOf(p, usage) };
    }
    const used = snapshotOf(p, usage),
      limits = p.limits;
    if (used.usedRequests + requestUpperBound > (limits.maxRequests ?? 400))
      throw exhausted("requests");
    if (
      kind === "detail_credit" &&
      used.usedDetails + 1 > (limits.maxDetails ?? 100)
    )
      throw exhausted("details");
    if (
      (kind === "attachment_credit" &&
        used.usedAttachments + 1 > (limits.maxAttachments ?? 40)) ||
      (bytesUpperBound &&
        (bytesUpperBound > (limits.maxAttachmentBytes ?? 20971520) ||
          used.usedBytes + bytesUpperBound >
            (limits.maxTotalAttachmentBytes ?? 209715200)))
    )
      throw exhausted("attachments");
    if (
      kind === "model" &&
      (amountMicros(used.costUpperBoundCny) + amountMicros(costUpperBoundCny) >
        amountMicros(limits.maxCostCny ?? 10) ||
        used.usedModelRequests >=
          Math.min(
            limits.maxModelRequests ?? 1000,
            p.ledger.modelRequestLimit ?? 1000,
            modelRequestLimit,
          ))
    )
      throw modelError();
    if (input.modelIdentity) {
      if (kind !== "model" || !isOfficialDeepSeekFlash(input.modelIdentity))
        throw packageError("model_pricing_unsupported", "模型价格尚未核实。");
      const modelIdentity = identity(input.modelIdentity);
      if (
        p.ledger.modelIdentity &&
        (!same(modelIdentity, p.ledger.modelIdentity) ||
          p.ledger.pricingVersion !== input.pricingVersion)
      )
        throw packageError(
          "model_pricing_unsupported",
          "活动的模型及价格已固定，请新建活动后更改。",
        );
      p.ledger.modelIdentity = modelIdentity;
      p.ledger.pricingVersion = input.pricingVersion;
    }
    if (kind === "model")
      p.ledger.modelRequestLimit = Math.min(
        p.ledger.modelRequestLimit ?? 1000,
        modelRequestLimit,
      );
    const r = {
      reservationId,
      kind,
      requestUpperBound,
      costUpperBoundCny,
      bytesUpperBound,
      resourceKey,
      maxOutputTokens,
      status: "reserved",
      epoch: input.token.epoch,
      sliceRunId: input.token.sliceRunId,
      operationId: input.operationLease.operationId,
      createdAt: new Date(clock.now()).toISOString(),
      ...(input.sourceId || p.activeSourceId
        ? { sourceId: input.sourceId || p.activeSourceId }
        : {}),
      ...(input.siteId || p.activeSiteId
        ? { siteId: input.siteId || p.activeSiteId }
        : {}),
      ...(kind === "model"
        ? {
            modelIdentity: p.ledger.modelIdentity || null,
            pricingVersion: input.pricingVersion || null,
          }
        : {}),
      ...(browser
        ? { browserWindowLeaseId: input.operationLease.operationId }
        : {}),
    };
    putCollectionPart(tx, {
      collection: "reservations",
      ref: input.ref,
      path,
      key: reservationId,
      value: r,
    });
    changeCollectionUsage(usage, null, r);
    if (
      requestUpperBound > 0 &&
      !["model", "worker"].includes(kind) &&
      r.sourceId
    )
      tx.putRow({
        collection: "sourceRotation",
        id: rowKey(input.ref.scope.packageId, "collection-source-rotation"),
        ownerPackageId: input.ref.scope.packageId,
        targetRevisionId: input.ref.scope.targetRevisionId,
        value: {
          lastSourceId: r.sourceId,
          lastSiteId: r.siteId || null,
          updatedAt: r.createdAt,
        },
      });
    p.ledger.revision++;
    return { ...r, duplicate: false, snapshot: snapshotOf(p, usage) };
  }
  function settleOne(state, input, { browser = false } = {}) {
    const { tx, p, usage } = state,
      id = collectionPartId(input.ref.activityId, path, input.reservationId),
      r = tx.getRow({ collection: "reservations", id });
    if (!r) throw invalid();
    const originalLease = r.operationId || r.browserWindowLeaseId;
    if (originalLease && originalLease !== input.operationLease.operationId)
      throw packageError("invalid_operation_lease", "结算不属于原采集租约。");
    const draining =
      !!p.draining &&
      p.stopIntent &&
      p.epoch === r.epoch + 1 &&
      p.activeSliceRunId === r.sliceRunId &&
      p.drainingLeaseId === input.operationLease.operationId &&
      p.drainingToken?.epoch === r.epoch &&
      p.drainingToken?.sliceRunId === r.sliceRunId;
    if (!draining)
      collectionToken(p, { epoch: r.epoch, sliceRunId: r.sliceRunId });
    if (browser) {
      if (
        r.browserWindowLeaseId !== input.operationLease.operationId ||
        r.epoch !== input.token?.epoch ||
        r.sliceRunId !== input.token?.sliceRunId ||
        !["browser", "resource", "dns"].includes(r.kind) ||
        r.costUpperBoundCny ||
        r.resourceKey ||
        r.requestUpperBound > 1
      )
        throw invalid();
      if (
        input.kind &&
        (!["browser", "resource", "dns"].includes(input.kind) ||
          r.requestUpperBound !== 1)
      )
        throw invalid();
    }
    if (r.status !== "reserved")
      return { settled: false, snapshot: snapshotOf(p, usage) };
    const before = structuredClone(r);
    // Reservation kind is immutable. Physical browser subtype is evidence only.
    if (browser && input.kind) r.physicalKind = input.kind;
    let verifiedUsage =
      r.kind === "model"
        ? quoteVerifiedModelUsage(input.modelUsage, {
            maxOutputTokens: r.maxOutputTokens ?? 4000,
          })
        : input.verifiedUsage;
    let verified = null;
    if (verifiedUsage && typeof verifiedUsage === "object") {
      const requests = verifiedUsage.requests ?? r.requestUpperBound,
        bytes = verifiedUsage.bytes ?? r.bytesUpperBound,
        costCny = verifiedUsage.costCny ?? r.costUpperBoundCny;
      if (
        integer(requests) &&
        requests <= r.requestUpperBound &&
        integer(bytes) &&
        bytes <= r.bytesUpperBound &&
        Number.isFinite(costCny) &&
        costCny >= 0 &&
        amountMicros(costCny) <= amountMicros(r.costUpperBoundCny)
      )
        verified = { requests, bytes, costCny };
    }
    r.status = verified ? "settled" : "uncertain";
    if (verified) r.verifiedUsage = verified;
    r.settledAt = new Date(clock.now()).toISOString();
    tx.putRow({ collection: "reservations", id, value: r });
    changeCollectionUsage(usage, before, r);
    p.ledger.revision++;
    return { settled: true, snapshot: snapshotOf(p, usage) };
  }
  return {
    async snapshot(ref) {
      const { root, usage } = await readCollectionHead(repository, ref);
      return snapshotOf(root.collectionProgress, usage);
    },
    async reserve(input) {
      const r = validateReservation(input);
      return transaction(input, [r], (state) => reserveOne(state, r), {
        resources: true,
        rotation: true,
      });
    },
    async settle(input) {
      return transaction(input, [input], (state) => settleOne(state, input));
    },
    async reserveBatch(input) {
      assertBatch(input.reservations);
      let requests = 0,
        bytes = 0;
      const items = input.reservations.map((r) => {
        if (
          Object.keys(r).some(
            (k) =>
              ![
                "reservationId",
                "kind",
                "requestUpperBound",
                "bytesUpperBound",
                "sourceId",
                "siteId",
              ].includes(k),
          ) ||
          r.kind !== "browser" ||
          !integer(r.requestUpperBound) ||
          r.requestUpperBound > 1
        )
          throw invalid();
        requests += r.requestUpperBound;
        bytes += r.bytesUpperBound || 0;
        return validateReservation({
          ...r,
          ref: input.ref,
          token: input.token,
          operationLease: input.operationLease,
        });
      });
      if (requests > 60 || bytes > 20971520) throw invalid();
      return transaction(
        input,
        items,
        (state) => {
          const reservations = items.map((r) => reserveOne(state, r, true));
          return { reservations, snapshot: snapshotOf(state.p, state.usage) };
        },
        { rotation: true },
      );
    },
    async settleBatch(input) {
      assertBatch(input.settlements);
      if (input.draining !== undefined && typeof input.draining !== "boolean")
        throw invalid();
      return transaction(input, input.settlements, (state) => {
        const { p, tx } = state,
          draining =
            input.draining &&
            p.draining &&
            p.epoch === input.token?.epoch + 1 &&
            p.activeSliceRunId === input.token?.sliceRunId &&
            p.drainingLeaseId === input.operationLease.operationId &&
            p.drainingToken?.epoch === input.token?.epoch &&
            p.drainingToken?.sliceRunId === input.token?.sliceRunId;
        if (
          input.draining &&
          p.draining &&
          p.drainingLeaseId !== input.operationLease.operationId
        )
          throw packageError(
            "invalid_operation_lease",
            "窗口预约不属于原采集租约。",
          );
        if (!draining) collectionToken(p, input.token);
        const pending = tx.view.pageInfo.at(-1).total;
        const settlements = input.settlements.map((r) => {
          if (
            Object.keys(r).some(
              (k) => !["reservationId", "kind", "verifiedUsage"].includes(k),
            )
          )
            throw invalid();
          return settleOne(
            state,
            {
              ...r,
              ref: input.ref,
              token: input.token,
              operationLease: input.operationLease,
            },
            { browser: true },
          );
        });
        if (
          draining &&
          p.externallyManagedDrain &&
          pending - settlements.filter((result) => result.settled).length === 0
        ) {
          p.status = p.stopIntent === "cancel" ? "cancelled" : "paused";
          p.draining = false;
          p.stopIntent = null;
          p.activeSliceRunId = null;
          p.revision++;
          delete p.externallyManagedDrain;
          delete p.drainingToken;
          delete p.drainingLeaseId;
          const child = tx.getRow({
            collection: "runs",
            id: input.token.sliceRunId,
          });
          if (child) {
            child.status = "cancelled";
            child.stage = "finished";
            child.finishedAt = new Date(clock.now()).toISOString();
            tx.putRow({ collection: "runs", id: child.runId, value: child });
          }
        }
        return { settlements, snapshot: snapshotOf(state.p, state.usage) };
      });
    },
    async adjustLimits(input) {
      const validated = validateCollectionLimits(input.limits);
      return transaction(input, [], (state) => {
        const { p, usage } = state;
        if (
          !["paused", "budget_exhausted", "waiting_for_auth"].includes(
            p.status,
          ) ||
          p.draining
        )
          throw packageError(
            "collection_pause_required",
            "请先暂停活动再调整采集额度。",
          );
        if (
          p.activeSliceRunId !== null ||
          p.revision !== input.expectedRevision
        )
          throw packageError(
            "collection_progress_conflict",
            "活动进度已变化，请刷新后重试。",
          );
        if (
          Object.hasOwn(validated, "maxCostCny") &&
          validated.maxCostCny > p.limits.maxCostCny
        )
          throw modelError();
        Object.assign(p.limits, validated);
        p.revision++;
        return snapshotOf(p, usage);
      });
    },
  };
}
