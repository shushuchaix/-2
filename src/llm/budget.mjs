// Official peak prices verified 2026-10-07: CNY 2 / million input tokens
// (cache miss), CNY 8 / million generated tokens. Reserving the entire
// documented 1,048,576-token context avoids relying on a prompt estimate.
const PRICING_VERSION = "deepseek-v4.1-flash-cny-2026-10-07";
const CONTEXT_TOKENS = 1048576;
const INPUT_MICRO_CNY = 2;
const OUTPUT_MICRO_CNY = 8;
const MICRO_CNY = 1000000;

function pricingError() {
  return Object.assign(Error("model_pricing_unsupported"), {
    code: "model_pricing_unsupported",
  });
}
function exhausted() {
  return Object.assign(Error("model_budget_exhausted"), {
    code: "model_budget_exhausted",
  });
}
export function isOfficialDeepSeekFlash({ baseUrl, model } = {}) {
  try {
    const url = new URL(baseUrl);
    return (
      model === "deepseek-flash" &&
      url.protocol === "https:" &&
      url.hostname === "api.deepseek.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["/", "/v1", "/v1/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0;
function trustworthyUsage(usage, maxOutputTokens) {
  if (
    !usage ||
    typeof usage !== "object" ||
    Array.isArray(usage) ||
    !tokenCount(usage.prompt_tokens) ||
    usage.prompt_tokens > CONTEXT_TOKENS ||
    !tokenCount(usage.completion_tokens) ||
    usage.completion_tokens > maxOutputTokens
  )
    return false;
  if (
    Object.hasOwn(usage, "total_tokens") &&
    (!tokenCount(usage.total_tokens) ||
      usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens)
  )
    return false;
  for (const key of ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"])
    if (
      Object.hasOwn(usage, key) &&
      (!tokenCount(usage[key]) || usage[key] > usage.prompt_tokens)
    )
      return false;
  if (
    Object.hasOwn(usage, "prompt_cache_hit_tokens") &&
    Object.hasOwn(usage, "prompt_cache_miss_tokens") &&
    usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens !==
      usage.prompt_tokens
  )
    return false;
  for (const [details, key, maximum] of [
    [usage.prompt_tokens_details, "cached_tokens", usage.prompt_tokens],
    [
      usage.completion_tokens_details,
      "reasoning_tokens",
      usage.completion_tokens,
    ],
  ])
    if (
      details &&
      Object.hasOwn(details, key) &&
      (!tokenCount(details[key]) || details[key] > maximum)
    )
      return false;
  return true;
}
// Shared by the persistent activity adapter; integer micro-CNY accounting stays
// identical to the original in-memory budget and verified pricing identity.
export function quoteModelReservation({
  modelConfig,
  maxOutputTokens = 4000,
} = {}) {
  if (!isOfficialDeepSeekFlash(modelConfig)) throw pricingError();
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 4000
  )
    throw Error("Invalid model output allowance");
  return {
    costUpperBoundCny:
      (CONTEXT_TOKENS * INPUT_MICRO_CNY + maxOutputTokens * OUTPUT_MICRO_CNY) /
      MICRO_CNY,
    maxOutputTokens,
    pricingVersion: PRICING_VERSION,
  };
}
export function quoteVerifiedModelUsage(
  usage,
  { maxOutputTokens = 4000 } = {},
) {
  return trustworthyUsage(usage, maxOutputTokens)
    ? {
        costCny:
          (usage.prompt_tokens * INPUT_MICRO_CNY +
            usage.completion_tokens * OUTPUT_MICRO_CNY) /
          MICRO_CNY,
      }
    : null;
}

/**
 * A per-operation budget shared by every physical attempt and model stage.
 * Money mode binds to the official Flash identity. claimRequest synchronously
 * reserves before transport; settleRequest releases only verified usage.
 * Missing usage retains the entire possible charge, including failed requests.
 */
export function createModelBudget(options = {}) {
  const moneyMode = Object.hasOwn(options, "maxCostCny"),
    maxRequests = options.maxRequests ?? (moneyMode ? 1000 : 20),
    maxOutputTokens = options.maxOutputTokens ?? 4000,
    maxCostCny = options.maxCostCny;
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 0 ||
    maxRequests > (moneyMode ? 1000 : 20) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 4000
  )
    throw Error("Invalid model budget");
  let ceiling = 0;
  if (moneyMode) {
    if (
      typeof maxCostCny !== "number" ||
      !Number.isFinite(maxCostCny) ||
      maxCostCny < 0 ||
      maxCostCny > 10 ||
      Math.abs(maxCostCny * 100 - Math.round(maxCostCny * 100)) > 1e-8
    )
      throw Error("Invalid model cost budget (CNY 0–10, maximum 2 decimals)");
    if (!isOfficialDeepSeekFlash(options.modelConfig)) throw pricingError();
    ceiling = Math.round(maxCostCny * 100) * 10000;
  }
  // Copy only fixed public identity fields; callers cannot change this binding.
  const identity = moneyMode
    ? Object.freeze({
        model: options.modelConfig.model,
        baseUrl: options.modelConfig.baseUrl,
      })
    : null;
  let requests = 0;
  let spent = 0,
    reserved = 0,
    uncertain = 0,
    pricedRequests = 0,
    uncertainRequests = 0;
  const pending = new Map();
  function outputLimit(value = maxOutputTokens) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maxOutputTokens)
      throw Error("Invalid model output allowance");
    return value;
  }
  function reservation(value) {
    return CONTEXT_TOKENS * INPUT_MICRO_CNY + value * OUTPUT_MICRO_CNY;
  }
  function assertModel(value = identity) {
    if (moneyMode && !isOfficialDeepSeekFlash(value)) throw pricingError();
  }
  return Object.freeze({
    assertModel,
    isExhausted({ maxOutputTokens: output = maxOutputTokens } = {}) {
      return (
        requests >= maxRequests ||
        (moneyMode &&
          spent + uncertain + reserved + reservation(outputLimit(output)) >
            ceiling)
      );
    },
    claimRequest({
      baseUrl = identity?.baseUrl,
      model = identity?.model,
      maxOutputTokens: output = maxOutputTokens,
    } = {}) {
      assertModel({ baseUrl, model });
      const cap = outputLimit(output),
        charge = moneyMode ? reservation(cap) : 0;
      if (
        requests >= maxRequests ||
        (moneyMode && spent + uncertain + reserved + charge > ceiling)
      )
        throw exhausted();
      ++requests;
      if (moneyMode) {
        reserved += charge;
        pending.set(requests, { charge, maxOutputTokens: cap });
      }
      return requests;
    },
    settleRequest(requestNumber, usage) {
      if (!moneyMode || !pending.has(requestNumber)) return false;
      const claim = pending.get(requestNumber);
      pending.delete(requestNumber);
      reserved -= claim.charge;
      if (trustworthyUsage(usage, claim.maxOutputTokens)) {
        spent +=
          usage.prompt_tokens * INPUT_MICRO_CNY +
          usage.completion_tokens * OUTPUT_MICRO_CNY;
        ++pricedRequests;
      } else {
        uncertain += claim.charge;
        ++uncertainRequests;
      }
      return true;
    },
    snapshot() {
      return {
        requests,
        maxRequests,
        maxOutputTokens,
        ...(moneyMode
          ? {
              maxCostCny: ceiling / MICRO_CNY,
              costUpperBoundCny: (spent + uncertain + reserved) / MICRO_CNY,
              reservedCostCny: reserved / MICRO_CNY,
              uncertainCostCny: uncertain / MICRO_CNY,
              pricedRequests,
              uncertainRequests,
              costMode: "cny_upper_bound",
              pricingVersion: PRICING_VERSION,
            }
          : {}),
      };
    },
  });
}

export function createConfiguredModelBudget({
  modelConfig,
  budgets = {},
} = {}) {
  if (Object.hasOwn(budgets, "maxCostCny"))
    return createModelBudget({
      modelConfig,
      maxCostCny: budgets.maxCostCny,
      // Old positive attempt limits become a secondary safety cap in money mode.
      // Zero keeps the user's explicit disabled state.
      maxRequests: budgets.maxModelRequests === 0 ? 0 : 1000,
    });
  return createModelBudget({ maxRequests: budgets.maxModelRequests ?? 20 });
}

export function effectiveModelBudgets(settings = {}, target = {}) {
  const budgets = { ...settings, ...target };
  if (settings.maxCostCny != null && target.maxCostCny != null)
    budgets.maxCostCny = Math.min(settings.maxCostCny, target.maxCostCny);
  return budgets;
}

// Keep the original accounting shared across retries and stages. A caller-supplied
// client cannot widen this operation's ceiling or start an unpriced money request.
export function capModelBudget(budget, { maxCostCny } = {}) {
  if (maxCostCny == null) return budget;
  const ceiling = Math.round(maxCostCny * 100) * 10000;
  function exceeds(output = budget.snapshot().maxOutputTokens) {
    const snapshot = budget.snapshot();
    return (
      snapshot.maxCostCny == null ||
      Math.round((snapshot.costUpperBoundCny || 0) * MICRO_CNY) +
        CONTEXT_TOKENS * INPUT_MICRO_CNY +
        output * OUTPUT_MICRO_CNY >
        ceiling
    );
  }
  return Object.freeze({
    ...budget,
    isExhausted(options = {}) {
      return exceeds(options.maxOutputTokens) || budget.isExhausted(options);
    },
    claimRequest(options = {}) {
      if (exceeds(options.maxOutputTokens)) throw exhausted();
      return budget.claimRequest(options);
    },
    snapshot() {
      const snapshot = budget.snapshot();
      return {
        ...snapshot,
        maxCostCny: Math.min(snapshot.maxCostCny ?? maxCostCny, maxCostCny),
      };
    },
  });
}
