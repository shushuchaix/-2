import { randomUUID } from "node:crypto";
import { packageError } from "../domain/packages.mjs";
import { inputError, assertInput } from "../../public/js/validation-rules.js";
import { loadSiteCatalog } from "../sources/catalog.mjs";
import { createSourceBudget } from "../infrastructure/http/budget.mjs";
import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import { mergeSourceHealth } from "./source-health.mjs";
import {
  deriveCollectionSourceHealth,
  isUnattemptedSourceResult,
} from "./collection-source-health.mjs";
import {
  safeSourceIssues,
  safeSourceDiagnosticRefs,
  isVersionPrivateSource,
} from "../sources/source-status.mjs";
import {
  probeReadService,
  enableReadService,
  createWeiboCapabilityRunner,
} from "../infrastructure/collection/service-capabilities.mjs";
import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
import {
  collectionRoot,
  collectionToken,
  collectionLease,
  leaseSelector,
  rowSelector,
} from "./collection-row-access.mjs";
import { rowKey } from "../infrastructure/storage/sqlite-records.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
import { isOperationControlError, isOrdinarySourceBudgetError } from "../domain/operation-control.mjs";

const defaults = () => ({
  sourceOverrides: {},
  sessionRefs: {},
  refreshEnabled: false,
});
const blockedCodes = new Set([
  "boss_account_risk",
  "boss_environment_risk",
  "boss_risk_blocked",
  "boss_auth_expired",
  "boss_login_required",
]);
const fatal = isOperationControlError;
export function createRowSourceService({
  repository,
  registry,
  requestFactory,
  diagnostics,
  catalog,
  clock = repository.clock,
  operationGate = createWorkspaceOperationGate({ repository }),
  activityContext,
  officialCredentials,
  officialRunnerFactory,
  validateConfig,
  safeProbeResult,
}) {
  const settings = async () => {
    const view = await repository.readView({
      select: [
        { collection: "settings", ids: ["sourceOverrides", "customSites"] },
      ],
    });
    return {
      sourceOverrides: view.rows.settings?.sourceOverrides || {},
      customSites: view.rows.settings?.customSites || [],
    };
  };
  const owner = (scope) =>
    repository.getRow(
      { collection: "packages", id: scope.packageId },
      { scope },
    );
  async function health(scope) {
    const result = {};
    let afterId;
    do {
      const page = await repository.queryRows(
        {
          collection: "sourceHealth",
          limit: 200,
          ...(afterId ? { afterId } : {}),
        },
        scope ? { scope } : {},
      );
      for (const row of page.rows)
        if (
          !isVersionPrivateSource(
            registry.get(row.value.sourceId) || { id: row.value.sourceId },
          )
        )
          result[row.id] = row.value;
      afterId = page.hasMore ? page.nextCursor : null;
    } while (afterId);
    if (scope)
      Object.assign(
        result,
        (await owner(scope)).collectionSettings?.sourceVerification || {},
      );
    return result;
  }
  async function updateOwner(
    scope,
    action,
    { operationLease, collectionGuard, signal } = {},
  ) {
    return (
      await repository.transaction(
        {
          select: [
            { collection: "packages", ids: [scope.packageId] },
            ...(collectionGuard
              ? [rowSelector("runs", scope, [collectionGuard.ref.activityId])]
              : []),
            ...(collectionGuard ? [leaseSelector(operationLease)] : []),
          ],
        },
        (tx) => {
          signal?.throwIfAborted();
          if (collectionGuard) {
            const root = collectionRoot(tx.view, collectionGuard.ref);
            collectionToken(root.collectionProgress, collectionGuard.token);
            collectionLease(tx.view, scope, operationLease);
            if (
              root.collectionProgress.operationId !== operationLease.operationId
            )
              throw packageError(
                "invalid_operation_lease",
                "核验结果不属于原诊断租约。",
              );
          }
          const pkg = tx.getRow({
            collection: "packages",
            id: scope.packageId,
          });
          pkg.collectionSettings ||= defaults();
          const result = action(pkg.collectionSettings, pkg);
          tx.putRow({
            collection: "packages",
            id: scope.packageId,
            value: pkg,
          });
          return result;
        },
        { scope, operationLease },
      )
    ).result;
  }
  async function persist(
    result,
    { scope, provider, operationLease, collectionGuard, signal } = {},
  ) {
    if (isUnattemptedSourceResult({ issues: result.issues || [] })) return null;
    const key = result.sourceId + "/" + result.siteId;
    if (scope && isVersionPrivateSource(provider || { id: result.sourceId }))
      return updateOwner(
        scope,
        (config) => {
          config.sourceVerification ||= {};
          return (config.sourceVerification[key] = mergeSourceHealth(
            config.sourceVerification[key],
            result,
            clock.now(),
          ));
        },
        { operationLease, collectionGuard, signal },
      );
    return (
      await repository.transaction(
        {
          select: [
            { collection: "sourceHealth", ids: [key] },
            ...(collectionGuard
              ? [rowSelector("runs", scope, [collectionGuard.ref.activityId])]
              : []),
          ],
        },
        (tx) => {
          signal?.throwIfAborted();
          if (collectionGuard)
            collectionToken(
              collectionRoot(tx.view, collectionGuard.ref).collectionProgress,
              collectionGuard.token,
            );
          const value = mergeSourceHealth(
            tx.getRow({ collection: "sourceHealth", id: key }),
            result,
            clock.now(),
          );
          tx.putRow({ collection: "sourceHealth", id: key, value });
          return value;
        },
        { scope, operationLease },
      )
    ).result;
  }
  async function sources(scope) {
    const [cfg, projections, pkg] = await Promise.all([
      settings(),
      health(scope),
      scope ? owner(scope) : Promise.resolve(null),
    ]);
    return registry.list().map((provider) => ({
      sourceId: provider.id,
      name: provider.name,
      capabilities: provider.capabilities,
      configSchema: provider.configSchema,
      config: {
        ...provider.defaultConfig,
        ...cfg.sourceOverrides[provider.id],
        ...pkg?.collectionSettings?.sourceOverrides?.[provider.id],
      },
      health: Object.values(projections).filter(
        (item) => item.sourceId === provider.id,
      ),
      ...(scope
        ? {
            optionalService: provider.optionalService === true,
            serviceCapability:
              pkg.collectionSettings?.serviceCapabilities?.[provider.id] ||
              null,
            sessionRef:
              pkg.collectionSettings?.sessionRefs?.[provider.id] || null,
          }
        : {}),
    }));
  }
  const service = {
    listSources: () => sources(),
    listScopedSources: ({ scope }) => sources(scope),
    async saveScopedConfig({ scope, sourceId, config = {} }) {
      const provider = registry.get(sourceId);
      if (!provider) throw inputError({ sourceId: "招聘来源已不存在。" });
      const saved = validateConfig(provider, config);
      return updateOwner(scope, (settings) => {
        if (
          provider.optionalService &&
          saved.enabled &&
          settings.serviceCapabilities?.[sourceId]?.enabled !== true
        )
          throw inputError({
            enabled: "请先检查本版本官方读取权限、额度与独立费用，再开通。",
          });
        settings.sourceOverrides[sourceId] = saved;
        return saved;
      });
    },
    async recordScopedBossProbeFailure({
      scope,
      sessionRef,
      code,
      diagnosticId,
      requestId,
      signal,
      collectionGuard,
      operationLease,
    }) {
      signal?.throwIfAborted();
      if (!collectionGuard || !operationLease)
        throw packageError(
          "invalid_operation_lease",
          "核验结果必须由原活动租约提交。",
        );
      return updateOwner(
        scope,
        (settings) => {
          if (settings.sessionRefs?.boss !== sessionRef)
            throw packageError(
              "collection_session_scope",
              "Boss会话已更换，旧核验结果未保存。",
            );
          settings.sourceVerification ||= {};
          settings.sourceVerification["boss/boss"] = mergeSourceHealth(
            settings.sourceVerification["boss/boss"],
            {
              sourceId: "boss",
              siteId: "boss",
              sampleCount: 0,
              status: blockedCodes.has(code) ? "restricted" : "unavailable",
              issues: safeSourceIssues(
                [{ code, diagnosticId, requestId }],
                "boss",
                "boss",
              ),
            },
            clock.now(),
          );
        },
        { signal, collectionGuard, operationLease },
      );
    },
    async probeOptionalReadService({
      scope,
      serviceId,
      credentialRef,
      accountId,
      ref,
    }) {
      await owner(scope);
      const provider = registry.get(serviceId);
      if (!provider?.optionalService)
        throw packageError("source_not_found", "未找到官方可选读取通道。", 404);
      const run = async (ctx) => {
        const runner =
          officialRunnerFactory?.({ platform: provider.platform, ...ctx }) ||
          (provider.platform === "weibo"
            ? createWeiboCapabilityRunner({
                request: ctx?.request,
                credentialStore: officialCredentials,
              })
            : undefined);
        const result = await probeReadService({
            scope,
            platform: provider.platform,
            credentialRef,
            accountId,
            runner,
          }),
          proof = {
            ...result,
            proofId: randomUUID(),
            checkedAt: new Date(clock.now()).toISOString(),
          };
        await updateOwner(
          scope,
          (settings) => {
            settings.serviceCapabilities ||= {};
            settings.serviceCapabilities[serviceId] = proof;
          },
          {
            operationLease: ctx?.operationLease,
            collectionGuard: ctx?.collectionGuard,
            signal: ctx?.signal,
          },
        );
        return proof;
      };
      if (!credentialRef || (!officialCredentials && !officialRunnerFactory))
        return run({});
      if (!ref || !activityContext)
        throw packageError(
          "collection_activity_required",
          "请在本版本采集活动中检查官方读取能力。",
          409,
        );
      if (
        ref.scope?.packageId !== scope.packageId ||
        ref.scope?.targetRevisionId !== scope.targetRevisionId
      )
        throw packageError(
          "service_capability_scope",
          "官方通道与当前版本不一致。",
          409,
        );
      return activityContext(ref, run);
    },
    async enableOptionalReadService({
      scope,
      serviceId,
      proofId,
      paidServiceAcknowledged = false,
    }) {
      const pkg = await owner(scope),
        proof = pkg.collectionSettings?.serviceCapabilities?.[serviceId];
      if (
        !proof ||
        proof.proofId !== proofId ||
        Number(clock.now()) - Date.parse(proof.checkedAt) > 1800000
      )
        throw packageError(
          "service_capability_expired",
          "请重新检查本版本的官方读取能力。",
          409,
        );
      const result = await enableReadService({
        scope,
        serviceId,
        confirmedCapability: proof,
        paidServiceAcknowledged,
      });
      return updateOwner(scope, (settings) => {
        if (settings.serviceCapabilities?.[serviceId]?.proofId !== proofId)
          throw packageError(
            "service_capability_expired",
            "读取能力已变化。",
            409,
          );
        settings.serviceCapabilities[serviceId] = result;
        settings.sourceOverrides[serviceId] = { enabled: true };
        return result;
      });
    },
    async probeScopedSource({ scope, sourceId, siteId, ref }) {
      const [pkg, cfg] = await Promise.all([owner(scope), settings()]),
        provider = registry.get(sourceId);
      if (!provider)
        throw packageError("source_not_found", "招聘来源不存在。", 404);
      if (sourceId === "boss" && !ref)
        throw packageError(
          "collection_activity_required",
          "Boss核验需使用本版本已有活动的累计额度。",
        );
      if (provider.optionalService)
        return service.probeOptionalReadService({
          scope,
          serviceId: sourceId,
          ref,
        });
      const site = (
        catalog || loadSiteCatalog({ customSites: cfg.customSites })
      ).find(
        (site) =>
          site.providerId === sourceId && (!siteId || site.siteId === siteId),
      );
      if (!site)
        throw packageError("site_not_found", "未找到该来源的站点。", 404);
      let target, unit;
      if (ref) {
        const view = await repository.readView(
          {
            select: [
              rowSelector("runs", scope, [ref.activityId]),
              rowSelector("runSnapshots", scope, [
                rowKey(ref.activityId, "targetSnapshot", "value"),
              ]),
              {
                collection: "activityUnits",
                ownerPackageId: scope.packageId,
                where: { parentId: ref.activityId, sourceId },
                limit: 1,
              },
            ],
          },
          { scope },
        );
        collectionRoot(view, { ...ref, scope });
        target =
          view.rows.runSnapshots?.[
            rowKey(ref.activityId, "targetSnapshot", "value")
          ];
        unit = Object.values(view.rows.activityUnits || {})[0];
      }
      const probe = async (ctx) => {
        const context = {
          ...ctx,
          scope,
          sites: [site],
          queries: [
            sourceId === "boss"
              ? {
                  keyword: unit?.query?.keyword || target?.roles?.[0],
                  city: unit?.query?.city || target?.cities?.[0],
                  pageLimit: 1,
                }
              : { keyword: "", pageLimit: 1 },
          ],
          targetSnapshot: target || { cities: [] },
          clock,
          config: {
            ...cfg.sourceOverrides[sourceId],
            ...pkg.collectionSettings?.sourceOverrides[sourceId],
          },
          sessionRefs: pkg.collectionSettings?.sessionRefs || {},
          diagnostics,
        };
        let list, terminalError;
        const issues = [];
        context.reportError = (error, where = {}) =>
          recordDiagnostic(
            diagnostics,
            {
              ...where,
              phase: error.phase || where.phase,
              operation: "source.probe",
              sourceId,
              siteId: site.siteId,
              requestId: safeSourceDiagnosticRefs(error).requestId,
            },
            error,
          );
        try {
          list = await provider.collect({ ...context, onBatch: undefined });
        } catch (error) {
          ctx.signal?.throwIfAborted();
          if (fatal(error) && !isOrdinarySourceBudgetError(error, ctx.signal)) throw error;
          terminalError = /^boss_/.test(error.code || "") ? error : null;
          const entry = await context.reportError(error);
          if (entry) error.diagnosticId = entry.diagnosticId;
          list = {
            records: [],
            issues: [
              {
                code: error.code || "unavailable",
                ...safeSourceDiagnosticRefs(error),
                ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
              },
            ],
          };
        }
        const records = [];
        issues.push(...(list.issues || []));
        for (const record of (issues.some(issue => issue.code === "source_budget_exhausted") ? [] : list.records.slice(0, 2))) {
          try {
            records.push(await provider.fetchDetail(record, context));
          } catch (error) {
            ctx.signal?.throwIfAborted();
            if (fatal(error) && !isOrdinarySourceBudgetError(error, ctx.signal)) throw error;
            const entry = await context.reportError(error);
            if (entry) error.diagnosticId = entry.diagnosticId;
            issues.push({
              code: error.code || "detail_unavailable",
              ...safeSourceDiagnosticRefs(error),
            });
            if (isOrdinarySourceBudgetError(error, ctx.signal)) break;
            if (sourceId === "boss" && /^boss_/.test(error.code || "")) {
              terminalError = error;
              break;
            }
          }
        }
        const result = deriveCollectionSourceHealth({
          sourceId,
          siteId: site.siteId,
          records: records.length ? records : list.records,
          issues,
          now: clock.now(),
        });
        result.sampleCount = list.records.length;
        result.budget = ctx.budget.snapshot();
        if (terminalError)
          result.status = blockedCodes.has(terminalError.code)
            ? "restricted"
            : "unavailable";
        await persist(result, {
          scope,
          provider,
          operationLease: ctx.operationLease,
          collectionGuard: ctx.collectionGuard,
          signal: ctx.signal,
        });
        if (terminalError) throw terminalError;
        return safeProbeResult(result, sourceId, site.siteId);
      };
      if (ref) {
        if (!activityContext)
          throw packageError(
            "collection_probe_unavailable",
            "活动探针当前不可用。",
          );
        return activityContext({ ...ref, scope }, probe);
      }
      const lease = await operationGate.acquire("collect", { scope });
      try {
        const budget = createSourceBudget({ maxRequests: 6, maxDetails: 2 });
        return await probe({
          budget,
          request: requestFactory({
            budget,
            diagnosticContext: { sourceId, siteId: site.siteId },
          }),
          operationLease: lease,
        });
      } finally {
        await lease.release();
      }
    },
    async probe(sourceId, siteId) {
      const provider = registry.get(sourceId);
      if (!provider) throw Error("Source not found");
      if (isVersionPrivateSource(provider) || sourceId === "boss")
        throw packageError(
          "source_scope_required",
          "此来源需在目标版本中检查，账号和探针记录按版本隔离。",
          409,
        );
      const cfg = await settings(),
        site = (
          catalog || loadSiteCatalog({ customSites: cfg.customSites })
        ).find(
          (site) =>
            (!siteId || site.siteId === siteId) && site.providerId === sourceId,
        );
      if (siteId && !site) throw Error("Site not found for provider");
      const budget = createSourceBudget({ maxRequests: 6, maxDetails: 2 }),
        started = clock.now();
      let result;
      try {
        result = await provider.probe({
          sites: site ? [site] : [],
          queries: [{ keyword: "", pageLimit: 1 }],
          targetSnapshot: { cities: [] },
          clock,
          budget,
          config: {
            ...provider.defaultConfig,
            ...cfg.sourceOverrides[sourceId],
          },
          diagnostics,
          request: requestFactory({
            budget,
            diagnosticContext: { sourceId, siteId },
          }),
          reportDiagnostic: (event, error) =>
            recordDiagnostic(
              diagnostics,
              { ...event, sourceId, siteId },
              error,
            ),
          reportError: (error, where) =>
            recordDiagnostic(
              diagnostics,
              {
                ...where,
                operation: "source.probe",
                sourceId,
                siteId,
                requestId: safeSourceDiagnosticRefs(error).requestId,
              },
              error,
            ),
        });
      } catch (error) {
        if (!fatal(error) || isOrdinarySourceBudgetError(error))
          await persist(
            {
              sourceId,
              siteId: site?.siteId || sourceId,
              status: "unavailable",
              issues: [
                {
                  code: error.code || "unavailable",
                  ...safeSourceDiagnosticRefs(error),
                },
              ],
            },
            { provider },
          );
        throw error;
      }
      await persist(
        { ...result, sourceId, siteId: site?.siteId || sourceId },
        { provider },
      );
      await recordDiagnostic(diagnostics, {
        operation: "source.probe",
        sourceId,
        siteId,
        code: result.status,
        durationMs: clock.now() - started,
        recordCount: result.sampleCount,
        usage: { sources: budget.snapshot() },
        outcome:
          result.status === "ready"
            ? "success"
            : result.status === "empty"
              ? "empty"
              : "failed",
      });
      return safeProbeResult(result, sourceId, site?.siteId || sourceId);
    },
    async saveSourceConfig(input) {
      const provider = registry.get(input.sourceId);
      if (!provider)
        throw inputError({ sourceId: "招聘来源已不存在，请刷新后重新选择。" });
      if (
        Object.keys(input.config || {}).some(
          (key) =>
            [
              "accountIds",
              "articleUrls",
              "sessionRef",
              "sessionRefs",
              "queries",
              "keywords",
            ].includes(key) ||
            /cookie|authorization|password|api.?key|token|secret/i.test(key),
        )
      )
        throw inputError({
          config:
            "全局设置只能保存公开工具配置；账号与查询设置必须属于目标版本。",
        });
      const saved = validateConfig(provider, input.config || {});
      return (
        await repository.transaction(
          { select: [{ collection: "settings", ids: ["sourceOverrides"] }] },
          (tx) => {
            const value =
              tx.getRow({ collection: "settings", id: "sourceOverrides" }) ||
              {};
            value[input.sourceId] = saved;
            tx.putRow({ collection: "settings", id: "sourceOverrides", value });
            return saved;
          },
        )
      ).result;
    },
    async addSite(input) {
      assertInput("site", input, {
        sourceIds: registry.list().map((provider) => provider.id),
      });
      if (
        !registry.get(input.providerId) ||
        !input.siteId ||
        !input.evidenceUrl
      )
        throw Error("Site provider and ownership evidence required");
      for (const key of ["origin", "evidenceUrl"])
        try {
          validatePublicUrl(input[key]);
        } catch {
          throw inputError({
            [key]: "请使用不含凭据、可公开访问的 HTTP 或 HTTPS 网址。",
          });
        }
      const site = { ...input, status: "candidate", verifiedAt: null };
      await repository.transaction(
        { select: [{ collection: "settings", ids: ["customSites"] }] },
        (tx) => {
          const sites =
            tx.getRow({ collection: "settings", id: "customSites" }) || [];
          try {
            loadSiteCatalog({ customSites: [...sites, site] });
          } catch (error) {
            throw inputError({
              siteId: /Duplicate/.test(error.message)
                ? "站点编号已存在，请换一个编号。"
                : "站点资料检查未通过，请核对来源、名称和归属证据链接。",
            });
          }
          tx.putRow({
            collection: "settings",
            id: "customSites",
            value: [...sites, site],
          });
        },
      );
      return site;
    },
    async removeSite(siteId) {
      return (
        await repository.transaction(
          { select: [{ collection: "settings", ids: ["customSites"] }] },
          (tx) => {
            const sites =
                tx.getRow({ collection: "settings", id: "customSites" }) || [],
              next = sites.filter((site) => site.siteId !== siteId);
            tx.putRow({
              collection: "settings",
              id: "customSites",
              value: next,
            });
            return { removed: sites.length !== next.length };
          },
        )
      ).result;
    },
  };
  return service;
}
