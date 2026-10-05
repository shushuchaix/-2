import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
import { createSourceBudget } from "../infrastructure/http/budget.mjs";
import { redactBusiness } from "../domain/redact.mjs";
import { loadSiteCatalog } from "../sources/catalog.mjs";
import { recordSourceHealth } from "./source-health.mjs";
export function createSourceService({
  registry,
  repository,
  requestFactory,
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
      const result = await provider.probe({
        sites: site ? [site] : [],
        queries: [{ keyword: "", pageLimit: 1 }],
        targetSnapshot: { cities: [] },
        clock,
        budget,
        request: requestFactory({ budget }),
      });
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
      if (!registry.get(input.sourceId)) throw Error("Source not found");
      const config = redactBusiness(input.config || {});
      return (
        await repository.mutateWorkspace((w) => {
          w.settings.sourceOverrides[input.sourceId] = config;
          return config;
        })
      ).result;
    },
    async addSite(input) {
      if (
        !registry.get(input.providerId) ||
        !input.siteId ||
        !input.evidenceUrl
      )
        throw Error("Site provider and ownership evidence required");
      validatePublicUrl(input.origin);
      validatePublicUrl(input.evidenceUrl);
      const site = {
        ...redactBusiness(input),
        status: "candidate",
        verifiedAt: null,
      };
      await repository.mutateWorkspace((w) => {
        try {
          loadSiteCatalog({ customSites: [...w.settings.customSites, site] });
        } catch (error) {
          error.status = 400;
          throw error;
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
