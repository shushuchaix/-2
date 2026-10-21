import { isOwnSchool } from "./common.mjs";
import {
  collectionLimitsFor,
  COLLECTION_LIMIT_CAPS,
} from "../../public/js/validation-rules.js";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { hasRecentSourceProof } from "./source-quality.mjs";
export const STANDARD_BUDGETS = {
  maxSites: 12,
  maxRequests: 120,
  maxKeywords: 6,
  maxPagesPerQuery: 2,
  maxDetails: 20,
};
export const BROAD_BUDGETS = {
  ...STANDARD_BUDGETS,
  maxSites: 24,
  maxRequests: 240,
};
function buildLegacyCollectionPlan({
  targetSnapshot: target,
  profileRevision,
  catalog,
  health = {},
  sourceOverrides = {},
}) {
  const defaults =
    target.coverageMode === "broad" ? BROAD_BUDGETS : STANDARD_BUDGETS;
  const budgets = { ...defaults };
  for (const key of Object.keys(budgets))
    if (target.budgets?.[key] != null)
      budgets[key] = Math.max(0, Math.min(budgets[key], target.budgets[key]));
  const profile = profileRevision?.profile || {};
  const cities =
    target.cityMode === "any"
      ? []
      : target.cityMode === "from_profile"
        ? profile.cities || profile.preferredCities || []
        : target.cities || [];
  const keywords = [...new Set(target.roles || [])].slice(
    0,
    budgets.maxKeywords,
  );
  const requested = (target.sourceIds || []).map((id) =>
    id === "searchApi" ? "searchapi" : id,
  );
  const skipped = [],
    eligible = [];
  for (const site of catalog) {
    const h = health[site.providerId + "/" + site.siteId];
    let reason = null;
    if (requested.length && !requested.includes(site.providerId))
      reason = "source_not_selected";
    else if (sourceOverrides[site.providerId]?.enabled === false)
      reason = "disabled";
    else if (h?.backoffUntil && Date.parse(h.backoffUntil) > Date.now())
      reason = "backoff";
    else if (
      !(site.status === "ready" || h?.status === "ready" || h?.lastSuccessAt)
    )
      reason = h?.status || site.status;
    if (reason) {
      skipped.push({
        sourceId: site.providerId,
        siteId: site.siteId,
        reason,
        explicit: (target.siteIds || []).includes(site.siteId),
      });
      continue;
    }
    const explicit = (target.siteIds || []).includes(site.siteId);
    const score =
      (explicit ? 100 : 0) +
      (isOwnSchool(site, profile) ? 40 : 0) +
      (site.regions?.some((r) => cities.includes(r)) ? 20 : 0) +
      (site.majorFamilies?.some((f) => String(profile.major || "").includes(f))
        ? 10
        : 0);
    eligible.push({ site, score, explicit });
  }
  eligible.sort(
    (a, b) => b.score - a.score || a.site.siteId.localeCompare(b.site.siteId),
  );
  const chosen = eligible.filter((x) => x.explicit).slice(0, budgets.maxSites);
  const groups = new Map();
  for (const e of eligible.filter((x) => !x.explicit)) {
    if (!groups.has(e.site.category)) groups.set(e.site.category, []);
    groups.get(e.site.category).push(e);
  }
  while (
    chosen.length < budgets.maxSites &&
    [...groups.values()].some((g) => g.length)
  )
    for (const entries of groups.values()) {
      if (chosen.length >= budgets.maxSites) break;
      if (entries.length) chosen.push(entries.shift());
    }
  const ids = new Set(chosen.map((e) => e.site.siteId));
  for (const e of eligible)
    if (!ids.has(e.site.siteId))
      skipped.push({
        sourceId: e.site.providerId,
        siteId: e.site.siteId,
        reason: "site_budget_exhausted",
        explicit: e.explicit,
      });
  for (const id of target.siteIds || [])
    if (!catalog.some((s) => s.siteId === id))
      skipped.push({ siteId: id, reason: "unknown_site", explicit: true });
  const sites = chosen.map((e) => e.site),
    queries = sites.flatMap((site) =>
      keywords.flatMap((keyword) =>
        (cities.length ? cities : [""]).map((city) => ({
          sourceId: site.providerId,
          siteId: site.siteId,
          keyword,
          city,
          pageLimit: budgets.maxPagesPerQuery,
        })),
      ),
    );
  return { sites, queries, budgets, skipped };
}
export function collectionSourceState(workspace, packageId) {
  const sourceStates = {};
  for (const run of Object.values(workspace?.runs || {}))
    if (
      run.ownerPackageId === packageId &&
      run.collectionRole === "collection_root"
    )
      for (const unit of Object.values(run.collectionProgress.units)) {
        const key = unit.sourceId + "/" + unit.siteId,
          previous = sourceStates[key],
          time = unit.lastAttemptAt || unit.lastSuccessAt;
        if (
          time &&
          (!previous || Date.parse(time) > Date.parse(previous.lastAttemptAt))
        )
          sourceStates[key] = {
            lastAttemptAt: time,
            nextDueAt: unit.nextDueAt,
            lastErrorCode: unit.lastErrorCode,
          };
      }
  return sourceStates;
}
export function buildCollectionPlan(input) {
  if (!input.target) return buildLegacyCollectionPlan(input);
  const {
    target,
    catalog,
    sourceOverrides = {},
    health = {},
    mode = target.coverageMode || "standard",
    now = Date.now(),
    workspace,
    scope,
  } = input;
  const moment = Number(now),
    sourceStates = {
      ...collectionSourceState(workspace, scope?.packageId),
      ...input.ownedState?.sourceStates,
    };
  const explicit = {};
  for (const [key, value] of Object.entries(target.budgets || {}))
    if (Object.hasOwn(COLLECTION_LIMIT_CAPS, key) && value != null)
      explicit[key] = value;
  const limits = collectionLimitsFor(mode, explicit),
    profile =
      input.profileRevision?.profile || target.profileSnapshot?.profile || {};
  const cities =
    target.cityMode === "any"
      ? [""]
      : target.cityMode === "from_profile"
        ? profile.cities || profile.preferredCities || []
        : target.cities || [];
  const requested = (target.sourceIds || []).map((id) =>
      id === "searchApi" ? "searchapi" : id,
    ),
    eligible = [],
    uncovered = [];
  for (const site of catalog) {
    const h = health[site.providerId + "/" + site.siteId],
      state = sourceStates[site.providerId + "/" + site.siteId];
    let reason;
    if (requested.length && !requested.includes(site.providerId))
      reason = "source_not_selected";
    else if (sourceOverrides[site.providerId]?.enabled === false)
      reason = "disabled";
    else if (h?.backoffUntil && Date.parse(h.backoffUntil) > moment)
      reason = "backoff";
    else if (!hasRecentSourceProof(site, h, moment)) reason = "probe_required";
    if (reason) {
      uncovered.push({
        sourceId: site.providerId,
        siteId: site.siteId,
        reason,
      });
      continue;
    }
    const explicitSite = (target.siteIds || []).includes(site.siteId),
      relevant = (site.jobFamilies || []).some((f) =>
        (target.roles || []).some((r) => f.includes(r) || r.includes(f)),
      );
    eligible.push({
      site,
      last: Date.parse(state?.lastAttemptAt) || 0,
      score:
        (explicitSite ? 100 : 0) +
        (relevant ? 40 : 0) +
        (isOwnSchool(site, profile) ? 30 : 0) +
        (site.regions?.some((r) => cities.includes(r)) ? 20 : 0),
    });
  }
  eligible.sort(
    (a, b) =>
      a.last - b.last ||
      b.score - a.score ||
      a.site.siteId.localeCompare(b.site.siteId),
  );
  const selected = [];
  // Check the oldest group first; category round robin breaks ties within it.
  while (selected.length < limits.maxSites && eligible.length) {
    const oldest = eligible[0].last,
      group = eligible.filter((e) => e.last === oldest),
      categories = new Map();
    for (const item of group) {
      if (!categories.has(item.site.category))
        categories.set(item.site.category, []);
      categories.get(item.site.category).push(item);
    }
    while (
      selected.length < limits.maxSites &&
      [...categories.values()].some((v) => v.length)
    )
      for (const items of categories.values()) {
        if (selected.length >= limits.maxSites) break;
        if (items.length) selected.push(items.shift().site);
      }
    for (const item of group) eligible.splice(eligible.indexOf(item), 1);
  }
  const selectedIds = new Set(selected.map((s) => s.siteId));
  for (const site of catalog)
    if (
      !selectedIds.has(site.siteId) &&
      !uncovered.some((x) => x.siteId === site.siteId)
    )
      uncovered.push({
        sourceId: site.providerId,
        siteId: site.siteId,
        reason: "site_limit",
      });
  const roles = [...new Set(target.roles || [])];
  const expansions = roles.map((r) =>
    /消防/.test(r)
      ? [r, "消防工程", "消防维保", "消防安全", "消防检测"]
      : /机场|航空/.test(r)
        ? [r, "机场消防", "机场应急救援", "机场运行保障", "航空安全"]
        : [r],
  );
  const keywords = [];
  for (let depth = 0; depth < 5; depth++)
    for (const group of expansions)
      if (
        group[depth] &&
        !keywords.includes(group[depth]) &&
        keywords.length < limits.maxQueryGroups
      )
        keywords.push(group[depth]);
  const units = selected.flatMap((site) =>
    keywords.flatMap((keyword, queryIndex) =>
      (cities.length ? cities : [""]).map((city) => ({
        unitId:
          "u-" +
          contentHash([site.providerId, site.siteId, keyword, city]).slice(
            0,
            24,
          ),
        sourceId: site.providerId,
        siteId: site.siteId,
        queryIndex,
        site,
        query: {
          sourceId: site.providerId,
          siteId: site.siteId,
          keyword,
          city,
          pageLimit: limits.maxPagesPerQuery,
        },
        cursor: null,
      })),
    ),
  );
  const catalogHash = contentHash(
      [...catalog].sort((a, b) => a.siteId.localeCompare(b.siteId)),
    ),
    queryHash = contentHash([roles, cities, target.jobTypes, sourceOverrides]);
  const hashes = {
    catalogHash,
    queryHash,
    parserVersion: "collection-v2",
    planHash: contentHash([catalogHash, queryHash, "collection-v2"]),
  };
  return {
    units,
    hashes,
    limits,
    uncovered,
    sites: selected,
    queries: units.map((u) => u.query),
    budgets: { ...limits, maxKeywords: limits.maxQueryGroups },
    skipped: uncovered,
  };
}
