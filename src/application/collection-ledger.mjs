import { randomUUID } from "node:crypto";
import { assertScope, packageError } from "../domain/packages.mjs";
import { assertOperationWriteAllowed } from "./workspace-operations.mjs";
import { validateCollectionLimits } from "../../public/js/validation-rules.js";
import {
  quoteModelReservation,
  quoteVerifiedModelUsage,
  isOfficialDeepSeekFlash,
} from "../llm/budget.mjs";
import { contentHash } from "../infrastructure/storage/repository.mjs";

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
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const micro = (v) => Math.round((v || 0) * 1000000);
const modelError = () =>
  packageError("model_budget_exhausted", "model_budget_exhausted", 409);
const exhausted = (kind) =>
  Object.assign(
    packageError("source_budget_exhausted", "source_budget_exhausted", 409),
    { budgetKind: kind },
  );
const invalid = () =>
  packageError("collection_reservation_invalid", "采集额度预约参数无效。", 400);
const publicIdentity = (value) => ({
  model: value.model,
  baseUrl:
    new URL(value.baseUrl).origin +
    new URL(value.baseUrl).pathname.replace(/\/$/, ""),
});
function activity(w, ref, clock) {
  assertScope(w, ref?.scope, clock.now());
  const root = w.runs[ref.activityId];
  if (
    !root ||
    root.collectionRole !== "collection_root" ||
    root.ownerPackageId !== ref.scope.packageId ||
    root.targetSnapshot.revisionId !== ref.scope.targetRevisionId
  )
    throw packageError("collection_scope", "采集活动不属于此目标版本。");
  return root.collectionProgress;
}
function checkLease(w, ref, operationLease) {
  assertOperationWriteAllowed(w, { operationLease });
  const lease = w.operationLeases?.[operationLease?.operationId];
  if (
    !lease ||
    lease.token !== operationLease.token ||
    lease.kind !== "collect" ||
    lease.scope?.packageId !== ref.scope.packageId ||
    lease.scope?.targetRevisionId !== ref.scope.targetRevisionId
  )
    throw packageError("invalid_operation_lease", "采集操作授权已失效。");
}
function currentToken(p, token) {
  if (
    !token ||
    p.epoch !== token.epoch ||
    p.activeSliceRunId !== token.sliceRunId ||
    p.status !== "collecting"
  )
    throw packageError(
      "collection_stale_epoch",
      "活动已暂停、取消或变更，请刷新进度。",
    );
}
function usageOf(p) {
  let usedRequests = 0,
    usedDetails = 0,
    usedAttachments = 0,
    usedBytes = 0,
    spent = 0,
    reserved = 0,
    unresolved = 0,
    usedModelRequests = 0,
    pricedRequests = 0,
    uncertainRequests = 0,
    reservedRequests = 0;
  const byKind = {};
  for (const r of Object.values(p.ledger.reservations)) {
    const pending = r.status !== "settled";
    const requests = pending
      ? r.requestUpperBound || 0
      : (r.verifiedUsage?.requests ?? r.requestUpperBound ?? 0);
    usedRequests += requests;
    byKind[r.kind] = (byKind[r.kind] || 0) + requests;
    if (pending) reservedRequests += requests;
    if (r.kind === "detail_credit") usedDetails++;
    if (r.kind === "attachment_credit") {
      usedAttachments++;
    }
    if (r.bytesUpperBound) {
      usedBytes += pending
        ? r.bytesUpperBound || 0
        : (r.verifiedUsage?.bytes ?? r.bytesUpperBound ?? 0);
    }
    if (r.kind === "model") {
      usedModelRequests++;
      if (r.status === "settled") {
        spent += micro(r.verifiedUsage.costCny);
        pricedRequests++;
      } else {
        reserved += micro(r.costUpperBoundCny);
        if (r.status === "uncertain") {
          unresolved += micro(r.costUpperBoundCny);
          uncertainRequests++;
        }
      }
    }
  }
  return {
    usedRequests,
    usedDetails,
    usedAttachments,
    usedBytes,
    byKind,
    modelSpendCny: spent / 1000000,
    reservedCostCny: reserved / 1000000,
    unresolvedCostCny: unresolved / 1000000,
    costUpperBoundCny: (spent + reserved) / 1000000,
    usedModelRequests,
    pricedRequests,
    uncertainRequests,
    reservedRequests,
    ...p.limits,
    ledgerRevision: p.ledger.revision,
    modelRequestLimit: p.ledger.modelRequestLimit ?? 1000,
    modelIdentity: p.ledger.modelIdentity || null,
    pricingVersion: p.ledger.pricingVersion || null,
  };
}
export function createCollectionLedger({
  repository,
  clock = repository.clock,
}) {
  const mutate = (action, operationLease) =>
    repository
      .mutateWorkspace(action, { operationLease })
      .then((r) => r.result);
  return {
    async snapshot(ref) {
      return usageOf(activity(await repository.read(), ref, clock));
    },
    async reserve({
      ref,
      token,
      reservationId,
      kind,
      requestUpperBound = 0,
      costUpperBoundCny = 0,
      bytesUpperBound = 0,
      resourceKey = null,
      operationLease,
      modelIdentity,
      pricingVersion,
      maxOutputTokens = 4000,
      modelRequestLimit = 1000,
    }) {
      if (
        typeof reservationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(reservationId) ||
        !kinds.has(kind) ||
        !integer(requestUpperBound) ||
        !integer(bytesUpperBound) ||
        typeof costUpperBoundCny !== "number" ||
        !Number.isFinite(costUpperBoundCny) ||
        costUpperBoundCny < 0 ||
        costUpperBoundCny > 10 ||
        Math.abs(costUpperBoundCny * 1000000 - micro(costUpperBoundCny)) >
          1e-6 ||
        !integer(maxOutputTokens)
      )
        throw invalid();
      if (!integer(modelRequestLimit) || modelRequestLimit > 1000)
        throw invalid();
      const key =
        resourceKey === null ? null : contentHash(String(resourceKey));
      return mutate((w) => {
        checkLease(w, ref, operationLease);
        const p = activity(w, ref, clock);
        currentToken(p, token);
        const previous = p.ledger.reservations[reservationId];
        if (previous) {
          if (
            previous.kind !== kind ||
            previous.requestUpperBound !== requestUpperBound ||
            previous.costUpperBoundCny !== costUpperBoundCny ||
            previous.bytesUpperBound !== bytesUpperBound ||
            previous.resourceKey !== key
          )
            throw packageError(
              "collection_reservation_conflict",
              "预约身份已用于不同请求。",
            );
          return { ...previous, duplicate: true, snapshot: usageOf(p) };
        }
        if (["detail_credit", "attachment_credit"].includes(kind) && key) {
          const existing = Object.values(p.ledger.reservations).find(
            (r) => r.kind === kind && r.resourceKey === key,
          );
          if (existing)
            return { ...existing, duplicate: true, snapshot: usageOf(p) };
        }
        const used = usageOf(p),
          limits = p.limits;
        if (used.usedRequests + requestUpperBound > (limits.maxRequests ?? 400))
          throw exhausted("requests");
        if (
          kind === "detail_credit" &&
          used.usedDetails + 1 > (limits.maxDetails ?? 100)
        )
          throw exhausted("details");
        if (
          kind === "attachment_credit" &&
          (used.usedAttachments + 1 > (limits.maxAttachments ?? 40) ||
            bytesUpperBound > (limits.maxAttachmentBytes ?? 20971520) ||
            used.usedBytes + bytesUpperBound >
              (limits.maxTotalAttachmentBytes ?? 209715200))
        )
          throw exhausted("attachments");
        if (
          kind !== "model" &&
          bytesUpperBound &&
          (bytesUpperBound > (limits.maxAttachmentBytes ?? 20971520) ||
            used.usedBytes + bytesUpperBound >
              (limits.maxTotalAttachmentBytes ?? 209715200))
        )
          throw exhausted("attachments");
        if (
          kind === "model" &&
          (micro(used.costUpperBoundCny) + micro(costUpperBoundCny) >
            micro(limits.maxCostCny ?? 10) ||
            used.usedModelRequests >=
              Math.min(
                limits.maxModelRequests ?? 1000,
                p.ledger.modelRequestLimit ?? 1000,
                modelRequestLimit,
              ))
        )
          throw modelError();
        if (kind !== "model" && costUpperBoundCny) throw invalid();
        if (modelIdentity) {
          if (kind !== "model" || !isOfficialDeepSeekFlash(modelIdentity))
            throw packageError(
              "model_pricing_unsupported",
              "模型价格尚未核实。",
            );
          const identity = publicIdentity(modelIdentity);
          if (
            p.ledger.modelIdentity &&
            (contentHash(identity) !== contentHash(p.ledger.modelIdentity) ||
              p.ledger.pricingVersion !== pricingVersion)
          )
            throw packageError(
              "model_pricing_unsupported",
              "活动的模型及价格已固定，请新建活动后更改。",
            );
          p.ledger.modelIdentity = identity;
          p.ledger.pricingVersion = pricingVersion;
        }
        if (kind === "model")
          p.ledger.modelRequestLimit = Math.min(
            p.ledger.modelRequestLimit ?? 1000,
            modelRequestLimit,
          );
        const reservation = {
          reservationId,
          kind,
          requestUpperBound,
          costUpperBoundCny,
          bytesUpperBound,
          resourceKey: key,
          maxOutputTokens,
          status: "reserved",
          epoch: token.epoch,
          sliceRunId: token.sliceRunId,
          createdAt: new Date(clock.now()).toISOString(),
        };
        p.ledger.reservations[reservationId] = reservation;
        p.ledger.revision++;
        return { ...reservation, duplicate: false, snapshot: usageOf(p) };
      }, operationLease);
    },
    async settle({
      ref,
      reservationId,
      verifiedUsage,
      modelUsage,
      operationLease,
    }) {
      return mutate((w) => {
        checkLease(w, ref, operationLease);
        const p = activity(w, ref, clock),
          r = p.ledger.reservations[reservationId];
        if (!r) throw invalid();
        currentToken(p, { epoch: r.epoch, sliceRunId: r.sliceRunId });
        if (r.status !== "reserved")
          return { settled: false, snapshot: usageOf(p) };
        if (r.kind === "model")
          verifiedUsage = quoteVerifiedModelUsage(modelUsage, {
            maxOutputTokens: r.maxOutputTokens ?? 4000,
          });
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
            micro(costCny) <= micro(r.costUpperBoundCny)
          )
            verified = { requests, bytes, costCny };
        }
        r.status = verified ? "settled" : "uncertain";
        if (verified) r.verifiedUsage = verified;
        r.settledAt = new Date(clock.now()).toISOString();
        p.ledger.revision++;
        return { settled: true, snapshot: usageOf(p) };
      }, operationLease);
    },
    async adjustLimits({ ref, limits, expectedRevision, operationLease }) {
      const validated = validateCollectionLimits(limits);
      return mutate((w) => {
        checkLease(w, ref, operationLease);
        const p = activity(w, ref, clock);
        if (
          !["paused", "budget_exhausted", "waiting_for_auth"].includes(p.status)
        )
          throw packageError(
            "collection_pause_required",
            "请先暂停活动再调整采集额度。",
          );
        if (p.activeSliceRunId !== null || p.revision !== expectedRevision)
          throw packageError(
            "collection_progress_conflict",
            "活动进度已变化，请刷新后重试。",
          );
        if (
          Object.hasOwn(validated, "maxCostCny") &&
          validated.maxCostCny > p.limits.maxCostCny
        )
          throw packageError(
            "model_budget_exhausted",
            "续采不能增加原活动的模型费用上限。",
          );
        Object.assign(p.limits, validated);
        p.revision++;
        return usageOf(p);
      }, operationLease);
    },
  };
}
/** Root-bound asynchronous adapters. Snapshot is a coherent confirmed view;
 * atomic reservation remains authoritative for concurrent callers. */
export async function createActivityBudgets({
  ledger,
  ref,
  token,
  operationLease,
  modelConfig,
  maxModelRequests = 1000,
  maxOutputTokens = 4000,
}) {
  let view = await ledger.snapshot(ref);
  const remember = (result) => {
    if (result.snapshot.ledgerRevision >= view.ledgerRevision)
      view = result.snapshot;
    return result;
  };
  const reserve = async (options) =>
    remember(
      await ledger.reserve({
        ref,
        token,
        operationLease,
        reservationId: "res-" + randomUUID(),
        ...options,
      }),
    );
  const sources = {
    async claimRequest(kind = "request", { bytesUpperBound = 0 } = {}) {
      return reserve({
        kind: kinds.has(kind) ? kind : "request",
        requestUpperBound: 1,
        bytesUpperBound,
      });
    },
    async settleRequest(reservation, { bytes }) {
      if (reservation?.bytesUpperBound)
        return remember(
          await ledger.settle({
            ref,
            reservationId: reservation.reservationId,
            operationLease,
            verifiedUsage: { requests: 1, bytes },
          }),
        );
    },
    async claimDetail(key) {
      return reserve({ kind: "detail_credit", resourceKey: key });
    },
    snapshot() {
      return {
        requests: view.usedRequests,
        details: view.usedDetails,
        maxRequests: view.maxRequests,
        maxDetails: view.maxDetails,
        byKind: { ...view.byKind },
      };
    },
  };
  const model = {
    assertModel(identity = modelConfig) {
      if (!isOfficialDeepSeekFlash(identity))
        throw packageError("model_pricing_unsupported", "模型价格尚未核实。");
      if (
        view.modelIdentity &&
        contentHash(publicIdentity(identity)) !==
          contentHash(view.modelIdentity)
      )
        throw packageError("model_pricing_unsupported", "活动模型已固定。");
    },
    isExhausted({ maxOutputTokens: output = maxOutputTokens } = {}) {
      const quote = quoteModelReservation({
        modelConfig,
        maxOutputTokens: output,
      });
      return (
        view.usedModelRequests >= maxModelRequests ||
        micro(view.costUpperBoundCny) + micro(quote.costUpperBoundCny) >
          micro(view.maxCostCny ?? 10)
      );
    },
    async claimRequest({
      baseUrl = modelConfig?.baseUrl,
      model: modelName = modelConfig?.model,
      maxOutputTokens: output = maxOutputTokens,
    } = {}) {
      const identity = { baseUrl, model: modelName };
      model.assertModel(identity);
      if (view.usedModelRequests >= maxModelRequests) throw modelError();
      const quote = quoteModelReservation({
        modelConfig: identity,
        maxOutputTokens: output,
      });
      return (
        await reserve({
          kind: "model",
          ...quote,
          modelIdentity: identity,
          modelRequestLimit: maxModelRequests,
        })
      ).reservationId;
    },
    async settleRequest(reservationId, usage) {
      if (!reservationId) return false;
      return remember(
        await ledger.settle({
          ref,
          reservationId,
          modelUsage: usage,
          operationLease,
        }),
      ).settled;
    },
    snapshot() {
      return {
        requests: view.usedModelRequests,
        maxRequests: maxModelRequests,
        maxOutputTokens,
        maxCostCny: view.maxCostCny ?? 10,
        costUpperBoundCny: view.costUpperBoundCny,
        reservedCostCny: view.reservedCostCny - view.unresolvedCostCny,
        uncertainCostCny: view.unresolvedCostCny,
        pricedRequests: view.pricedRequests,
        uncertainRequests: view.uncertainRequests,
        costMode: "cny_upper_bound",
        pricingVersion: view.pricingVersion,
      };
    },
  };
  return { sources, model };
}
