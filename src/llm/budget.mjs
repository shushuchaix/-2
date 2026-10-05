export function createModelBudget({
  maxRequests = 20,
  maxOutputTokens = 4000,
} = {}) {
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 0 ||
    maxRequests > 20 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 4000
  )
    throw Error(
      "Invalid model budget (maximum 20 requests / 4000 output tokens)",
    );
  let requests = 0;
  return {
    claimRequest() {
      if (requests >= maxRequests) {
        const e = Error("model_budget_exhausted");
        e.code = "model_budget_exhausted";
        throw e;
      }
      requests++;
      return requests;
    },
    snapshot() {
      return { requests, maxRequests, maxOutputTokens };
    },
  };
}
