import { legacyProviders } from "./adapters/legacy.mjs";
import ncss from "./adapters/ncss.mjs";
import job91 from "./adapters/university-91job.mjs";
import announcements from "./adapters/official-announcements.mjs";
import yingjiesheng from "./adapters/yingjiesheng.mjs";
import tencent from "./adapters/tencent.mjs";
import smartrecruiters from "./adapters/smartrecruiters.mjs";
import greenhouse from "./adapters/greenhouse.mjs";
import { socialProviders } from "./adapters/social-discovery.mjs";
export function createSourceRegistry(providers) {
  const entries = new Map();
  for (const provider of providers) {
    if (
      !provider.id ||
      !provider.name ||
      !provider.capabilities ||
      !provider.configSchema ||
      ["collect", "fetchDetail", "probe"].some(
        (key) => typeof provider[key] !== "function",
      )
    )
      throw Error("Invalid source contract");
    if (entries.has(provider.id))
      throw Error("Duplicate provider " + provider.id);
    entries.set(provider.id, provider);
  }
  return {
    get: (id) => entries.get(id) || null,
    list: () => [...entries.values()],
  };
}
export function createDefaultSourceRegistry() {
  return createSourceRegistry([
    ...legacyProviders,
    ncss,
    job91,
    announcements,
    yingjiesheng,
    tencent,
    smartrecruiters,
    greenhouse,
    ...socialProviders,
  ]);
}
