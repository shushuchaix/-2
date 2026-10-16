export function createSourceBudget({
  maxRequests = 120,
  maxDetails = 20,
} = {}) {
  for (const n of [maxRequests, maxDetails])
    if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid source budget");
  let requests = 0;
  const details = new Set(),
    byKind = {};
  const exhausted = (budgetKind) =>
    Object.assign(Error("budget_exhausted: " + budgetKind), {
      code: "source_budget_exhausted",
      budgetKind,
    });
  return {
    claimRequest(kind = "request") {
      if (requests >= maxRequests) throw exhausted("requests");
      requests++;
      byKind[kind] = (byKind[kind] || 0) + 1;
    },
    claimDetail(key) {
      if (details.has(key)) return;
      if (details.size >= maxDetails) throw exhausted("details");
      details.add(key);
    },
    snapshot() {
      return {
        requests,
        details: details.size,
        maxRequests,
        maxDetails,
        byKind: { ...byKind },
      };
    },
  };
}
