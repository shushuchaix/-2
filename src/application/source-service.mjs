import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import { createSourceBudget } from "../infrastructure/http/budget.mjs";
import { redactBusiness } from "../domain/redact.mjs";
import { loadSiteCatalog } from "../sources/catalog.mjs";
import { recordSourceHealth } from "./source-health.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
import { assertScope, packageError } from "../domain/packages.mjs";
import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import { assessSourceProbe } from "../sources/source-quality.mjs";
const privateKeys = new Set([
  "accountIds",
  "articleUrls",
  "sessionRef",
  "sessionRefs",
  "queries",
  "keywords",
]);
function validateConfig(provider, config) {
  assertInput("sourceConfig", config);
  for (const [key, value] of Object.entries(config)) {
    if (/cookie|authorization|password|api.?key|token|secret/i.test(key))
      throw inputError({ [key]: "来源配置不能保存凭据，请使用专用会话。" });
    const type = provider.configSchema[key];
    if (!type) throw inputError({ [key]: "此来源不支持该设置项。" });
    if (type === "array") {
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        value.some((v) => typeof v !== "string" || !v.trim() || v.length > 4096)
      )
        throw inputError({ [key]: "请填写最多100个有效公开标识或链接。" });
      if (/Urls$/.test(key)) for (const url of value) validatePublicUrl(url);
    } else if (typeof value !== type)
      throw inputError({ [key]: "设置格式不正确。" });
  }
  return structuredClone(config);
}
export function createSourceService({
  registry,
  repository,
  requestFactory,
  diagnostics,
  catalog,
  clock = repository.clock,
  operationGate = createWorkspaceOperationGate({ repository }),
  activityContext,
}) {
  return {
    async listScopedSources({ scope }) {
      const w = await repository.read(),
        pkg = assertScope(w, scope, clock.now());
      return registry
        .list()
        .map((p) => ({
          sourceId: p.id,
          name: p.name,
          capabilities: p.capabilities,
          configSchema: p.configSchema,
          config: {
            ...(w.settings.sourceOverrides[p.id] || {}),
            ...(pkg.collectionSettings?.sourceOverrides[p.id] || {}),
          },
          health: Object.values({
            ...w.sourceHealth,
            ...pkg.collectionSettings?.sourceVerification,
          }).filter((h) => h.sourceId === p.id),
        }));
    },
    async saveScopedConfig({ scope, sourceId, config = {} }) {
      const provider = registry.get(sourceId);
      if (!provider) throw inputError({ sourceId: "招聘来源已不存在。" });
      const saved = validateConfig(provider, config);
      return (
        await repository.mutateWorkspace((w) => {
          const pkg = assertScope(w, scope, clock.now());
          pkg.collectionSettings ||= {
            sourceOverrides: {},
            sessionRefs: {},
            refreshEnabled: false,
          };
          pkg.collectionSettings.sourceOverrides[sourceId] = saved;
          return saved;
        })
      ).result;
    },
    async probeScopedSource({ scope, sourceId, siteId, ref }) {
      const w = await repository.read(),
        pkg = assertScope(w, scope, clock.now()),
        provider = registry.get(sourceId);
      if (!provider)
        throw packageError("source_not_found", "招聘来源不存在。", 404);
      const site = (
        catalog || loadSiteCatalog({ customSites: w.settings.customSites })
      ).find(
        (s) => s.providerId === sourceId && (!siteId || s.siteId === siteId),
      );
      if (!site)
        throw packageError("site_not_found", "未找到该来源的站点。", 404);
      const config = {
        ...w.settings.sourceOverrides[sourceId],
        ...pkg.collectionSettings?.sourceOverrides[sourceId],
      };
      const probe = async ({
        budget,
        request,
        signal,
        operationLease,
        collectionGuard,
      }) => {
        const context = {
          scope,
          sites: [site],
          queries: [{ keyword: "", pageLimit: 1 }],
          targetSnapshot: { cities: [] },
          clock,
          budget,
          request,
          signal,
          config,
        };
        const list = await provider.collect({ ...context, onBatch: undefined });
        const details = [],
          issues = [...(list.issues || [])];
        for (const record of list.records.slice(0, 2))
          try {
            details.push(await provider.fetchDetail(record, context));
          } catch (e) {
            signal?.throwIfAborted();
            issues.push({ code: e.code || "detail_unavailable" });
          }
        const quality = assessSourceProbe({
          site,
          listSample: {
            status: issues.some((i) =>
              ["restricted", "http_forbidden", "captcha"].includes(i.code),
            )
              ? 403
              : 200,
            records: list.records,
          },
          detailSample: details,
          now: clock.now(),
        });
        const result = {
          ...quality,
          status:
            quality.verification === "ready"
              ? "ready"
              : quality.verification === "restricted"
                ? "restricted"
                : list.records.length
                  ? "parse_error"
                  : "empty",
          sampleCount: list.records.length,
          issues: [...issues, ...quality.issues],
          budget: budget.snapshot(),
        };
        await repository.mutateWorkspace(
          (d) => {
            const owner = assertScope(d, scope, clock.now());
            if (collectionGuard) {
              const r = d.runs[collectionGuard.ref.activityId],
                p = r?.collectionProgress,
                t = collectionGuard.token;
              if (
                r?.ownerPackageId !== scope.packageId ||
                p?.epoch !== t.epoch ||
                p.activeSliceRunId !== t.sliceRunId ||
                p.status !== "collecting"
              )
                throw packageError(
                  "collection_stale_epoch",
                  "活动已停止，探针结果未保存。",
                );
            }
            if (
              ["social", "social_discovery"].includes(
                provider.capabilities.category,
              )
            ) {
              owner.collectionSettings ||= {
                sourceOverrides: {},
                sessionRefs: {},
                refreshEnabled: false,
              };
              owner.collectionSettings.sourceVerification ||= {};
              owner.collectionSettings.sourceVerification[
                sourceId + "/" + site.siteId
              ] = {
                sourceId,
                siteId: site.siteId,
                status: result.status,
                capabilities: quality.capabilities,
                checkedAt: result.checkedAt,
                lastSuccessAt:
                  result.status === "ready" ? result.checkedAt : null,
              };
            } else
              recordSourceHealth(
                d,
                {
                  sourceId,
                  siteId: site.siteId,
                  status: result.status,
                  sampleCount: result.sampleCount,
                  capabilities: quality.capabilities,
                },
                clock.now(),
              );
          },
          { operationLease },
        );
        return result;
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
    async listSources() {
      const w = await repository.read();
      return registry.list().map((p) => ({
        sourceId: p.id,
        name: p.name,
        capabilities: p.capabilities,
        configSchema: p.configSchema,
        config: w.settings.sourceOverrides[p.id] || {},
        health: Object.values(w.sourceHealth).filter(
          (h) => h.sourceId === p.id,
        ),
      }));
    },
    async probe(sourceId, siteId) {
      const provider = registry.get(sourceId);
      if (!provider) throw Error("Source not found");
      const w = await repository.read();
      const site = (
        catalog ||
        loadSiteCatalog({
          customSites: w.settings.customSites,
        })
      ).find((s) => s.siteId === siteId && s.providerId === sourceId);
      if (siteId && !site) throw Error("Site not found for provider");
      const budget = createSourceBudget({ maxRequests: 6, maxDetails: 2 });
      const started = clock.now();
      let result;
      try {
        result = await provider.probe({
          sites: site ? [site] : [],
          queries: [{ keyword: "", pageLimit: 1 }],
          targetSnapshot: { cities: [] },
          clock,
          budget,
          diagnostics,
          reportDiagnostic: (event, error) =>
            recordDiagnostic(
              diagnostics,
              { ...event, sourceId, siteId },
              error,
            ),
          request: requestFactory({
            budget,
            diagnosticContext: { sourceId, siteId },
          }),
          reportError: (error, context) =>
            recordDiagnostic(
              diagnostics,
              { operation: "source.probe", sourceId, siteId, ...context },
              error,
            ),
        });
      } catch (error) {
        const entry = await recordDiagnostic(
          diagnostics,
          {
            operation: "source.probe",
            sourceId,
            siteId,
            durationMs: clock.now() - started,
          },
          error,
        );
        if (entry) error.diagnosticId = entry.diagnosticId;
        throw error;
      }
      await recordDiagnostic(diagnostics, {
        operation: "source.probe",
        sourceId,
        siteId,
        code: result.status,
        level: result.status === "ready" ? "info" : "warn",
        durationMs: clock.now() - started,
        recordCount: result.sampleCount,
        issueCount: result.issues?.length || 0,
        usage: { sources: budget.snapshot() },
        outcome:
          result.status === "ready"
            ? "success"
            : result.status === "empty"
              ? "empty"
              : "failed",
      });
      for (const issue of result.issues || []) {
        if (issue.diagnosticId) continue;
        const entry = await recordDiagnostic(
          diagnostics,
          { operation: "source.probe", sourceId, siteId, code: issue.code },
          Object.assign(Error(issue.message || issue.code), {
            code: issue.code,
          }),
        );
        if (entry) issue.diagnosticId = entry.diagnosticId;
      }
      await repository.mutateWorkspace((d) => {
        const health = recordSourceHealth(
          d,
          { ...result, sourceId, siteId: siteId || sourceId },
          clock.now(),
        );
        const custom = d.settings.customSites.find((s) => s.siteId === siteId);
        if (custom) {
          custom.status = result.status === "ready" ? "ready" : "candidate";
          custom.verifiedAt = health.lastSuccessAt || custom.verifiedAt || null;
        }
      });
      return result;
    },
    async saveSourceConfig(input) {
      if (
        Object.keys(input.config || {}).some(
          (k) =>
            privateKeys.has(k) ||
            /cookie|authorization|password|api.?key|token|secret/i.test(k),
        )
      )
        throw inputError({
          config:
            "全局设置只能保存公开工具配置；账号与查询设置必须属于目标版本。",
        });
      if (!registry.get(input.sourceId))
        throw inputError({ sourceId: "招聘来源已不存在，请刷新后重新选择。" });
      assertInput("sourceConfig", input.config || {});
      const schema = registry.get(input.sourceId).configSchema;
      for (const [key, value] of Object.entries(input.config || {})) {
        if (!Object.hasOwn(schema, key))
          throw inputError({ [key]: "此来源不支持该设置项。" });
        if (typeof value !== schema[key])
          throw inputError({ [key]: "设置格式不正确，请按该来源的要求填写。" });
      }
      const config = redactBusiness(input.config || {});
      const saved = (
        await repository.mutateWorkspace((w) => {
          w.settings.sourceOverrides[input.sourceId] = config;
          return config;
        })
      ).result;
      await recordDiagnostic(diagnostics, {
        operation: "source.settings",
        sourceId: input.sourceId,
      });
      return saved;
    },
    async addSite(input) {
      assertInput("site", input, {
        sourceIds: registry.list().map((p) => p.id),
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
      const site = {
        ...redactBusiness(input),
        status: "candidate",
        verifiedAt: null,
      };
      await repository.mutateWorkspace((w) => {
        try {
          loadSiteCatalog({ customSites: [...w.settings.customSites, site] });
        } catch (error) {
          throw inputError({
            siteId: /Duplicate/.test(error.message)
              ? "站点编号已存在，请换一个编号。"
              : "站点资料检查未通过，请核对来源、名称和归属证据链接。",
          });
        }
        w.settings.customSites.push(site);
      });
      return site;
    },
    async removeSite(siteId) {
      return (
        await repository.mutateWorkspace((w) => {
          const before = w.settings.customSites.length;
          w.settings.customSites = w.settings.customSites.filter(
            (s) => s.siteId !== siteId,
          );
          return { removed: before !== w.settings.customSites.length };
        })
      ).result;
    },
  };
}
