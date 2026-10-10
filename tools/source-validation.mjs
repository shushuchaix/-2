import { createHash, randomUUID } from "node:crypto";
import { loadSiteCatalog } from "../src/sources/catalog.mjs";
import { readProviderPage } from "../src/sources/collection-page.mjs";
import { canonicalSocialUrl } from "../src/sources/social-content.mjs";
import { assertSourceRecord } from "../src/domain/contracts.mjs";
import { assertCollectionWrite } from "../src/domain/collection.mjs";
import { evaluateRules } from "../src/domain/ranking.mjs";
import {
  selectVersionJobFact,
  selectMatchingEvaluation,
} from "../src/domain/job-facts.mjs";
import {
  assessRecruitmentEvidence,
  isVerifiedRecommendation,
} from "../src/domain/recruitment-evidence.mjs";
import {
  recordDiagnostic,
  diagnosticError,
} from "../src/infrastructure/diagnostics/log.mjs";

const publicQueries = new Set(["消防", "机场"]);
const rawProviders = new Set([
  "ncss",
  "university-91job",
  "greenhouse",
  "boss",
  "nowcoder",
]);
const mappedProviders = new Set(["tencent", "smartrecruiters"]);
const bossStopCodes = new Set([
  "boss_account_risk",
  "boss_environment_risk",
  "boss_risk_blocked",
  "boss_auth_expired",
  "boss_login_required",
]);
const bossRiskCodes = new Set([
  "boss_account_risk",
  "boss_environment_risk",
  "boss_risk_blocked",
]);
const codes = new Set([
  "source_budget_exhausted",
  "model_budget_exhausted",
  "collection_stale_epoch",
  "workspace_write_failed",
  "workspace_operation_busy",
  "invalid_operation_lease",
  "collection_probe_unavailable",
  "collection_terminal",
  "collection_page_invalid",
  "collection_cursor_invalid",
  "collection_diagnostic_replayed",
  "collection_route_forbidden",
  "parse_error",
  "captcha",
  "rate_limited",
  "restricted",
  "login_required",
  "http_forbidden",
  "unavailable",
  "budget_exhausted",
  "invalid_record",
  "detail_insufficient",
  "boss_login_required",
  "boss_auth_expired",
  "boss_account_risk",
  "boss_environment_risk",
  "boss_risk_blocked",
  "boss_record_invalid",
  "public_seeds_required",
  "collection_account_invalid",
  "source_origin_invalid",
  "version_fact_unavailable",
  "account_history_limited",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "request_timeout",
  "http_error",
]);
const httpStatus = (value) =>
  Number.isInteger(value?.status ?? value?.httpStatus) &&
  (value.status ?? value.httpStatus) >= 100 &&
  (value.status ?? value.httpStatus) <= 599
    ? (value.status ?? value.httpStatus)
    : null;
const safeCode = (error) => {
  const classified = diagnosticError(error);
  for (const candidate of [classified?.code, classified?.cause?.code])
    if (codes.has(candidate)) return candidate;
  if (classified?.name === "TimeoutError") return "request_timeout";
  return httpStatus(error) !== null ? "http_error" : "source_validation_failed";
};
const fail = (code) => Object.assign(Error(code), { code });
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const nowFor = (context) => context.repository.clock?.now?.() ?? Date.now();
const blocked = (row, reason) =>
  Object.assign(row, { status: "blocked", blockReason: reason });

function usage(root) {
  const u = root.collectionUsage || {};
  return {
    usedRequests: count(u.usedRequests) || 0,
    usedDetails: count(u.usedDetails) || 0,
    usedModelRequests: count(u.usedModelRequests) || 0,
    knownPhysicalRequests: count(u.knownPhysicalRequests) || 0,
    unknownRequestUpperBound: count(u.unknownRequestUpperBound) || 0,
    costUpperBoundCny: Number.isFinite(u.costUpperBoundCny)
      ? u.costUpperBoundCny
      : 0,
  };
}

function newRow(site) {
  return {
    sourceId: site.providerId,
    siteId: site.siteId,
    status: "not_tested",
    blockReason: null,
    skipReason: null,
    errorCode: null,
    detailErrorCode: null,
    httpStatus: null,
    detailHttpStatus: null,
    listAttempted: false,
    listContractVerified: false,
    pageCommitted: false,
    committedPages: 0,
    rawCount: null,
    rawBasis: "unavailable",
    acceptedFallbackCount: null,
    parsedCount: null,
    filteredCount: null,
    invalidCount: null,
    duplicateCount: null,
    newUniqueCount: 0,
    evaluatedCount: 0,
    bodyVerifiedCount: 0,
    applicationAvailableCount: 0,
    qualificationPassCount: 0,
    qualificationUnknownCount: 0,
    qualificationFailCount: 0,
    validNewUniqueCount: 0,
    requestsUsed: 0,
    detailsUsed: 0,
    modelRequestsUsed: 0,
    costUpperBoundCnyUsed: 0,
  };
}

// Saved personal source seeds are deliberately excluded. Public seeds must be supplied explicitly.
function publicConfig(sourceId, supplied) {
  if (!["wechat", "weibo"].includes(sourceId)) return {};
  const cfg = supplied?.[sourceId] || {};
  if (
    !Array.isArray(cfg.articleUrls || []) ||
    !Array.isArray(cfg.accountIds || [])
  )
    throw fail("collection_account_invalid");
  const articleUrls = [
    ...new Set(
      (cfg.articleUrls || []).map((url) => canonicalSocialUrl(url, sourceId)),
    ),
  ];
  const accountIds = [...new Set(cfg.accountIds || [])];
  const pattern =
    sourceId === "weibo" ? /^\d{1,30}$/ : /^[A-Za-z0-9_=+-]{1,200}$/;
  if (
    articleUrls.length > 100 ||
    accountIds.length > 100 ||
    accountIds.some((id) => !pattern.test(id))
  )
    throw fail("collection_account_invalid");
  return { articleUrls, accountIds };
}

function prerequisite(site, cfg, scoped, context) {
  if (
    site.providerId === "official-announcements" &&
    ["listUrl", "linkRule", "bodyRule"].some((key) => !site.template?.[key])
  )
    return "template_missing";
  if (
    site.providerId === "university-91job" &&
    !/^\d{5}$/.test(String(site.tenantId || ""))
  )
    return "tenant_invalid";
  if (
    ["greenhouse", "smartrecruiters"].includes(site.providerId) &&
    (typeof site.tenantId !== "string" || !site.tenantId.trim())
  )
    return "tenant_invalid";
  if (site.providerId === "ncss") {
    try {
      const url = new URL(site.origin);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !(url.hostname === "ncss.cn" || url.hostname.endsWith(".ncss.cn"))
      )
        return "source_origin_invalid";
    } catch {
      return "source_origin_invalid";
    }
  }
  if (
    ["wechat", "weibo"].includes(site.providerId) &&
    !(cfg.articleUrls.length || cfg.accountIds.length)
  )
    return "public_seeds_required";
  if (site.providerId === "boss" && !scoped?.sessionRef)
    return "boss_login_required";
  if (site.providerId === "boss" && !context.contentReadService?.readBoss)
    return "collection_probe_unavailable";
  if (["searchapi", "douyin"].includes(site.providerId))
    return "external_cost_unverified";
  if (scoped?.config?.enabled === false) return "source_disabled";
  return null;
}

function* providerRounds(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const id = candidate.site.providerId;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(candidate);
  }
  for (let round = 0; ; round++) {
    let yielded = false;
    for (const group of groups.values()) {
      if (!group[round]) continue;
      yielded = true;
      yield group[round];
    }
    if (!yielded) return;
  }
}

function rawLineage(site, cfg, captured, page) {
  const candidateCount = count(captured?.records?.length);
  const socialSeed =
    ["wechat", "weibo"].includes(site.providerId) &&
    cfg.articleUrls?.length > 0;
  const direct =
    rawProviders.has(site.providerId) ||
    (site.providerId === "weibo" && !socialSeed);
  const suppliedRaw = count(captured?.raw ?? captured?.stats?.raw);
  if (direct && suppliedRaw !== null)
    return {
      rawCount: suppliedRaw,
      rawBasis: "provider_raw",
      acceptedFallbackCount: null,
    };
  // These two adapters map a validated provider array without filtering it.
  if (mappedProviders.has(site.providerId) && candidateCount !== null)
    return {
      rawCount: candidateCount,
      rawBasis: "provider_array",
      acceptedFallbackCount: null,
    };
  return {
    rawCount: null,
    rawBasis: "accepted_fallback",
    acceptedFallbackCount: candidateCount ?? page.records.length,
  };
}

function detailSampleIndex(records, root, now) {
  // Use the owned copy only. Saved overrides are normally already folded into profile.
  const profile = {
    ...root.profileSnapshot.profile,
    ...root.profileSnapshot.overrides,
  };
  const candidates = records.map((record, index) => {
    const draft = evaluateRules(record, profile, root.targetSnapshot, { now });
    return {
      index,
      failed: draft.qualification.status === "fail",
      roleScore: draft.components.role.score,
      score: draft.score,
    };
  });
  candidates.sort(
    (a, b) =>
      Number(a.failed) - Number(b.failed) ||
      b.roleScore - a.roleScore ||
      b.score - a.score ||
      a.index - b.index,
  );
  return candidates[0]?.index ?? -1;
}

function projectQuality(workspace, root, committed, row, now, seen) {
  const newIds = new Set(committed.newForTarget || []);
  for (const jobId of new Set(committed.jobIds || [])) {
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    if (workspace.jobs[jobId]?.ownerPackageId !== root.ownerPackageId) continue;
    const fact = selectVersionJobFact(workspace, {
      jobId,
      targetRevisionId: root.targetSnapshot.revisionId,
    });
    if (fact.status !== "verified") continue;
    const evidence = assessRecruitmentEvidence({ record: fact.record, now });
    const evaluation = selectMatchingEvaluation(workspace, {
      jobId,
      targetRevisionId: root.targetSnapshot.revisionId,
      profileRevisionId: root.profileSnapshot.revisionId,
      factContentHash: fact.factContentHash,
    });
    if (evidence.bodyVerified) row.bodyVerifiedCount++;
    if (evidence.applicationStatus === "available")
      row.applicationAvailableCount++;
    const status = evaluation?.qualification?.status;
    if (evaluation?.status === "rules") row.evaluatedCount++;
    row[
      status === "pass"
        ? "qualificationPassCount"
        : status === "fail"
          ? "qualificationFailCount"
          : "qualificationUnknownCount"
    ]++;
    if (
      newIds.has(jobId) &&
      evaluation?.status === "rules" &&
      isVerifiedRecommendation({
        qualification: evaluation.qualification,
        evidence,
      })
    )
      row.validNewUniqueCount++;
  }
}

/** Probe an already prepared, paused root. This module never prepares/resumes roots or creates budgets. */
export async function validateSources({
  context,
  ref,
  catalog = loadSiteCatalog(),
  sourceConfig = {},
  requestIdPrefix = "source-validation-" + randomUUID(),
  detailsPerSite = 1,
  pagesPerSite = 1,
} = {}) {
  if (
    !context?.collectionService ||
    !context?.repository ||
    !context?.registry ||
    !context?.evaluationService ||
    ![0, 1].includes(detailsPerSite) ||
    ![1, 2].includes(pagesPerSite) ||
    !/^[A-Za-z0-9_.-]{1,80}$/.test(requestIdPrefix) ||
    !Array.isArray(catalog) ||
    catalog.length > 1000 ||
    catalog.some(
      (s) =>
        !/^[A-Za-z0-9_.-]{1,160}$/.test(s?.siteId) ||
        !/^[A-Za-z0-9_.-]{1,160}$/.test(s?.providerId),
    ) ||
    new Set(catalog.map((s) => s.siteId)).size !== catalog.length
  )
    throw fail("source_validation_input_invalid");
  const service = context.collectionService;
  const initial = await service.get(ref);
  if (
    initial.collectionProgress.status !== "paused" ||
    initial.collectionProgress.activeSliceRunId
  )
    throw fail("collection_pause_required");
  const scopedSources = context.sourceService
    ? await context.sourceService.listScopedSources({ scope: ref.scope })
    : [];
  const scoped = new Map(scopedSources.map((s) => [s.sourceId, s]));
  const rows = catalog.map(newRow);
  const candidates = [];
  for (const [index, site] of catalog.entries()) {
    const row = rows[index];
    let cfg;
    try {
      cfg = publicConfig(site.providerId, sourceConfig);
    } catch {
      blocked(row, "public_seed_invalid");
      continue;
    }
    const reason = prerequisite(
      site,
      cfg,
      scoped.get(site.providerId),
      context,
    );
    if (reason) {
      blocked(row, reason);
      continue;
    }
    candidates.push({ site, cfg, row });
  }
  // Static blocks do not consume a provider turn; reports retain catalog order.
  for (const { site, cfg, row } of providerRounds(candidates)) {
    const root = await service.get(ref);
    if (
      root.collectionProgress.status !== "paused" ||
      root.collectionProgress.activeSliceRunId
    ) {
      blocked(row, "collection_pause_required");
      continue;
    }
    const units = Object.values(root.collectionProgress.units);
    const unit = units.find(
      (u) => u.sourceId === site.providerId && u.siteId === site.siteId,
    );
    if (!unit) {
      blocked(row, "collection_unit_missing");
      continue;
    }
    const pageLimit = unit.query?.pageLimit ?? 1;
    if (
      !publicQueries.has(unit.query?.keyword) ||
      (unit.query?.city || "") !== "" ||
      ![1, 2].includes(pageLimit)
    ) {
      blocked(row, "public_query_required");
      continue;
    }
    if (
      unit.riskBlocked ||
      (Date.parse(unit.nextDueAt) || 0) > nowFor(context)
    ) {
      blocked(
        row,
        unit.riskBlocked ? "source_risk_blocked" : "source_cooldown",
      );
      continue;
    }
    const maxPages = Math.min(pageLimit, pagesPerSite);
    if (unit.committedPages >= maxPages || unit.status === "completed") {
      row.status = "skipped";
      row.skipReason = "already_committed";
      continue;
    }
    if (
      root.targetSnapshot.sourceIds?.length &&
      !root.targetSnapshot.sourceIds.includes(site.providerId)
    ) {
      blocked(row, "source_not_selected");
      continue;
    }
    const provider = context.registry.get(site.providerId);
    if (!provider) {
      blocked(row, "provider_missing");
      continue;
    }
    const before = usage(root);
    if (
      before.usedRequests >= (root.collectionProgress.limits.maxRequests ?? 400)
    ) {
      blocked(row, "source_budget_exhausted");
      continue;
    }
    try {
      await service.withDiagnosticContext(
        {
          ref,
          requestId: requestIdPrefix + "-" + digest(site.siteId).slice(0, 20),
        },
        async (ctx) => {
          let captured;
          const capture =
            (method) =>
            async (...args) => {
              const result = await provider[method](...args);
              captured = result;
              return result;
            };
          const observedProvider = {
            ...provider,
            collect: capture("collect"),
            ...(typeof provider.collectPage === "function"
              ? { collectPage: capture("collectPage") }
              : {}),
          };
          const query = {
            keyword: unit.query.keyword,
            city: "",
            pageLimit: maxPages,
          };
          let activeEndpoint = "list";
          const providerContext = {
            ...ctx,
            scope: ref.scope,
            runId: ctx.token.sliceRunId,
            sites: [site],
            query,
            queries: [query],
            queryIndex: unit.queryIndex,
            targetSnapshot: {
              cities: [],
              cityMode: "any",
              roles: [],
              jobTypes: [],
              graduationYear: "",
            },
            config: cfg,
            clock: context.repository.clock,
            readService: ctx.readService || context.contentReadService,
            sessionRefs:
              site.providerId === "boss"
                ? { boss: scoped.get("boss").sessionRef }
                : {},
            request: async (url, options = {}) => {
              const statusField =
                activeEndpoint === "detail" ? "detailHttpStatus" : "httpStatus";
              try {
                const response = await ctx.request(url, {
                  ...options,
                  maxRetries: 0,
                  signal: ctx.signal,
                  diagnosticContext: {
                    runId: ctx.token.sliceRunId,
                    sourceId: site.providerId,
                    siteId: site.siteId,
                    endpointKind: activeEndpoint,
                  },
                });
                row[statusField] = httpStatus(response) ?? row[statusField];
                return response;
              } catch (error) {
                row[statusField] = httpStatus(error) ?? row[statusField];
                throw error;
              }
            },
          };
          let cursor = unit.cursor ?? null;
          let detailAttempts = 0;
          let enrichmentBudgetBlocked = false;
          const canReadBody =
            provider.capabilities.body === true ||
            (provider.capabilities.body === undefined &&
              provider.capabilities.detail === true);
          const seenCursorHashes = [...(unit.seenCursorHashes || [])];
          const qualitySeen = new Set();
          const substantiveIssues = [];
          for (
            let pageIndex = unit.committedPages || 0;
            pageIndex < maxPages;
            pageIndex++
          ) {
            row.listAttempted = true;
            let page;
            try {
              page = await readProviderPage(observedProvider, {
                unitId: unit.unitId,
                site,
                scope: ref.scope,
                query,
                signal: ctx.signal,
                request: providerContext.request,
                context: providerContext,
                cursor,
                seenCursorHashes,
              });
            } catch (error) {
              if (bossRiskCodes.has(error.code))
                await context.repository.mutateWorkspace(
                  (w) => {
                    assertCollectionWrite(w, ctx.collectionGuard);
                    const current =
                      w.runs[ref.activityId].collectionProgress.units[
                        unit.unitId
                      ];
                    current.riskBlocked = true;
                    current.lastErrorCode = error.code;
                  },
                  { operationLease: ctx.operationLease },
                );
              throw error;
            }
            const lineage = rawLineage(site, cfg, captured, page);
            row.rawBasis = lineage.rawBasis;
            if (lineage.rawCount !== null)
              row.rawCount = (row.rawCount ?? 0) + lineage.rawCount;
            if (lineage.acceptedFallbackCount !== null)
              row.acceptedFallbackCount =
                (row.acceptedFallbackCount ?? 0) +
                lineage.acceptedFallbackCount;
            row.parsedCount = (row.parsedCount ?? 0) + page.records.length;
            const invalid = page.issues.filter(
              (issue) =>
                issue.code === "invalid_record" ||
                issue.code === "boss_record_invalid",
            ).length;
            row.invalidCount = (row.invalidCount ?? 0) + invalid;
            row.filteredCount =
              row.rawCount === null
                ? null
                : Math.max(
                    0,
                    row.rawCount - row.parsedCount - row.invalidCount,
                  );
            substantiveIssues.push(
              ...page.issues.filter(
                (issue) =>
                  ![
                    "account_history_limited",
                    "city_filter_unsupported",
                  ].includes(issue.code),
              ),
            );
            row.listContractVerified =
              row.rawCount !== null && substantiveIssues.length === 0;
            if (page.records.length === 0 && substantiveIssues.length) break;
            const records = page.records.map((record) =>
              canReadBody &&
              record.retryEligible !== false &&
              !["restricted", "challenge_required", "login_required"].includes(
                record.bodyStatus,
              ) &&
              !assessRecruitmentEvidence({
                record,
                now: nowFor(context),
              }).bodyVerified
                ? { ...record, bodyStatus: "incomplete", retryEligible: true }
                : record,
            );
            if (
              detailAttempts < detailsPerSite &&
              records.length &&
              canReadBody
            ) {
              const currentUsage = ctx.budget.snapshot();
              if (
                currentUsage.details >= currentUsage.maxDetails ||
                currentUsage.requests >= currentUsage.maxRequests
              )
                row.detailErrorCode = "source_budget_exhausted";
              else {
                const selectedIndex = detailSampleIndex(
                  records,
                  root,
                  nowFor(context),
                );
                const selectedRecord = records[selectedIndex];
                detailAttempts++;
                activeEndpoint = "detail";
                let fetched = false;
                try {
                  const detailed = await provider.fetchDetail(
                    selectedRecord,
                    providerContext,
                  );
                  assertSourceRecord(detailed);
                  if (
                    detailed.sourceId !== selectedRecord.sourceId ||
                    detailed.siteId !== selectedRecord.siteId ||
                    detailed.sourceRecordId !== selectedRecord.sourceRecordId
                  )
                    throw fail("collection_page_invalid");
                  records[selectedIndex] = detailed;
                  fetched = true;
                  const enriched = await ctx.enrichRecord(detailed);
                  assertSourceRecord(enriched);
                  if (
                    enriched.sourceId !== selectedRecord.sourceId ||
                    enriched.siteId !== selectedRecord.siteId ||
                    enriched.sourceRecordId !== selectedRecord.sourceRecordId
                  )
                    throw fail("collection_page_invalid");
                  records[selectedIndex] = enriched;
                  if (enriched.attachmentBudgetExhausted) {
                    enrichmentBudgetBlocked = true;
                    row.detailErrorCode = "source_budget_exhausted";
                  }
                } catch (error) {
                  ctx.signal.throwIfAborted();
                  row.detailHttpStatus =
                    httpStatus(error) ?? row.detailHttpStatus;
                  if (bossStopCodes.has(error.code)) {
                    if (bossRiskCodes.has(error.code))
                      await context.repository.mutateWorkspace(
                        (w) => {
                          assertCollectionWrite(w, ctx.collectionGuard);
                          const current =
                            w.runs[ref.activityId].collectionProgress.units[
                              unit.unitId
                            ];
                          current.riskBlocked = true;
                          current.lastErrorCode = error.code;
                        },
                        { operationLease: ctx.operationLease },
                      );
                    throw error;
                  }
                  if (
                    error.name === "AbortError" ||
                    error.code === "request_cancelled" ||
                    [
                      "collection_stale_epoch",
                      "workspace_write_failed",
                      "invalid_operation_lease",
                    ].includes(error.code)
                  )
                    throw error;
                  row.detailErrorCode = safeCode(error);
                  if (fetched && error.code === "source_budget_exhausted") {
                    enrichmentBudgetBlocked = true;
                    records[selectedIndex] = {
                      ...records[selectedIndex],
                      applicationVerification: {
                        status: "unknown",
                        checkedAt: new Date(nowFor(context)).toISOString(),
                        formVerified: false,
                      },
                    };
                  } else if (!fetched && error.retryable === false) {
                    records[selectedIndex] = {
                      ...records[selectedIndex],
                      retryEligible: false,
                    };
                  }
                } finally {
                  activeEndpoint = "list";
                }
              }
            }
            const committed = await service.commitCollectionPage({
              ref,
              token: ctx.token,
              unitId: unit.unitId,
              page: { ...page, records },
              operationLease: ctx.operationLease,
            });
            ctx.token.expectedRevision = committed.revision;
            row.pageCommitted = true;
            row.committedPages++;
            row.newUniqueCount += new Set(committed.newForTarget || []).size;
            row.duplicateCount = Math.max(
              0,
              row.parsedCount - row.newUniqueCount,
            );
            if (committed.jobIds.length) {
              const evaluated = await context.evaluationService.evaluate({
                scope: ref.scope,
                jobIds: committed.jobIds,
                mode: "rules",
                runId: ctx.token.sliceRunId,
                signal: ctx.signal,
                operationLease: ctx.operationLease,
                collectionGuard: ctx.collectionGuard,
                modelClient: { available: false, budget: ctx.modelBudget },
              });
              await context.repository.mutateWorkspace(
                (w) => {
                  assertCollectionWrite(w, ctx.collectionGuard);
                  const child = w.runs[ctx.token.sliceRunId];
                  child.evaluationIds = [
                    ...new Set([
                      ...(child.evaluationIds || []),
                      ...evaluated.evaluations.map((e) => e.evaluationId),
                    ]),
                  ];
                },
                { operationLease: ctx.operationLease },
              );
            }
            projectQuality(
              await context.repository.read(),
              root,
              committed,
              row,
              nowFor(context),
              qualitySeen,
            );
            if (
              page.done ||
              substantiveIssues.length ||
              enrichmentBudgetBlocked
            )
              break;
            seenCursorHashes.push(page.cursorHash);
            cursor = page.nextCursor;
          }
          if (substantiveIssues.length) {
            const code = safeCode(substantiveIssues[0]);
            if (
              [
                "public_seeds_required",
                "login_required",
                "boss_login_required",
                "source_budget_exhausted",
                "budget_exhausted",
                "restricted",
                "http_forbidden",
              ].includes(code)
            )
              blocked(
                row,
                code === "budget_exhausted" ? "source_budget_exhausted" : code,
              );
            else {
              row.status = "failed";
              row.errorCode = code;
            }
          } else if (row.parsedCount > 0) row.status = "parsed";
          else if (row.rawCount > 0) row.status = "filtered";
          else if (row.listContractVerified) row.status = "empty";
          else blocked(row, "empty_evidence_unverified");
          if (enrichmentBudgetBlocked) blocked(row, "source_budget_exhausted");
        },
      );
    } catch (error) {
      const code = safeCode(error);
      row.httpStatus = httpStatus(error) ?? row.httpStatus;
      if (
        bossStopCodes.has(code) ||
        [
          "source_budget_exhausted",
          "model_budget_exhausted",
          "restricted",
          "login_required",
          "collection_probe_unavailable",
        ].includes(code)
      )
        blocked(row, code);
      else {
        row.status = "failed";
        row.errorCode = code;
      }
    }
    const after = usage(await service.get(ref));
    row.requestsUsed = Math.max(0, after.usedRequests - before.usedRequests);
    row.detailsUsed = Math.max(0, after.usedDetails - before.usedDetails);
    row.modelRequestsUsed = Math.max(
      0,
      after.usedModelRequests - before.usedModelRequests,
    );
    row.costUpperBoundCnyUsed = Math.max(
      0,
      after.costUpperBoundCny - before.costUpperBoundCny,
    );
  }
  for (const row of rows)
    await recordDiagnostic(context.diagnostics, {
      event: "source.probe",
      operation: "source.validation",
      sourceId: row.sourceId,
      siteId: row.siteId,
      outcome: {
        parsed: "completed",
        empty: "empty",
        filtered: "partial",
        blocked: "insufficient",
        failed: "failed",
        skipped: "skipped",
      }[row.status],
      counts: {
        normalized: row.parsedCount ?? 0,
        invalid: row.invalidCount ?? 0,
        committedPages: row.committedPages,
        validNewUnique: row.validNewUniqueCount,
      },
      code: row.errorCode || row.blockReason,
      ...(row.httpStatus === null ? {} : { httpStatus: row.httpStatus }),
    });
  const final = await service.get(ref);
  return {
    schemaVersion: 1,
    activityId: ref.activityId,
    mode: "rules",
    rows,
    statuses: Object.fromEntries(
      ["parsed", "empty", "filtered", "blocked", "failed", "skipped"].map(
        (status) => [
          status,
          rows.filter((row) => row.status === status).length,
        ],
      ),
    ),
    usage: usage(final),
    totals: Object.fromEntries(
      [
        "newUniqueCount",
        "evaluatedCount",
        "bodyVerifiedCount",
        "applicationAvailableCount",
        "qualificationPassCount",
        "qualificationUnknownCount",
        "qualificationFailCount",
        "validNewUniqueCount",
      ].map((key) => [key, rows.reduce((sum, row) => sum + row[key], 0)]),
    ),
  };
}
