import { collectionLimitsFor } from "../../../public/js/validation-rules.js";
import type { CollectionActivity } from "./types";

export type BudgetInput = {
  coverageMode?: "standard" | "broad";
  overrides?: Record<string, number>;
  modelBudget?: { maxCostCny?: number | null; maxModelRequests?: number };
  activity?: CollectionActivity | null;
};
export type BudgetView = {
  source: "default" | "saved" | "activity";
  limits: Record<string, number>;
  costMode: "cny" | "request_count" | "unknown";
  modelRequestLimit: number | null;
  usedCostCny: number | null;
  remainingCostCny: number | null;
};
const amount = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export function budgetView(input: BudgetInput = {}): BudgetView {
  const activity = input.activity;
  const limits = activity
    ? { ...activity.collectionProgress.limits }
    : (collectionLimitsFor(
        input.coverageMode ?? "standard",
        input.overrides ?? {},
      ) as Record<string, number>);
  const source = activity
    ? "activity"
    : Object.keys(input.overrides ?? {}).length || input.modelBudget
      ? "saved"
      : "default";
  let costMode: BudgetView["costMode"] =
    amount(limits.maxCostCny) !== null ? "cny" : "unknown";
  if (
    !activity &&
    !Object.hasOwn(input.overrides ?? {}, "maxCostCny") &&
    input.modelBudget
  ) {
    if (amount(input.modelBudget.maxCostCny) !== null)
      limits.maxCostCny = input.modelBudget.maxCostCny!;
    else if (typeof input.modelBudget.maxCostCny === "number") {
      costMode = "unknown";
      delete limits.maxCostCny;
    } else if (
      input.modelBudget.maxCostCny === null ||
      input.modelBudget.maxModelRequests !== undefined
    ) {
      costMode = "request_count";
      delete limits.maxCostCny;
    }
  }
  const usedCostCny =
    activity && costMode === "cny"
      ? amount(activity.collectionUsage?.costUpperBoundCny)
      : null;
  return {
    source,
    limits,
    costMode,
    modelRequestLimit: amount(
      input.overrides?.maxModelRequests ?? input.modelBudget?.maxModelRequests,
    ),
    usedCostCny,
    remainingCostCny:
      costMode === "cny" && usedCostCny !== null
        ? Math.max(0, limits.maxCostCny - usedCostCny)
        : null,
  };
}
