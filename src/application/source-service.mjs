import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import { createSourceBudget } from "../infrastructure/http/budget.mjs";
import { redactBusiness } from "../domain/redact.mjs";
import { loadSiteCatalog } from "../sources/catalog.mjs";
import { recordSourceHealth } from "./source-health.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
export function createSourceService({
  registry,
  repository,
  requestFactory,
  diagnostics,
  clock = repository.clock,
}) {
  return {
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
      const site = loadSiteCatalog({
        customSites: w.settings.customSites,
      }).find((s) => s.siteId === siteId && s.providerId === sourceId);
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
