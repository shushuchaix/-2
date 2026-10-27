import fs from "node:fs";
import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
export function loadSiteCatalog({ customSites = [] } = {}) {
  const builtins = [
    "universities",
    "employers",
    "public-notices",
    "platforms",
  ].flatMap((name) =>
    JSON.parse(
      fs.readFileSync(
        new URL("./catalog/" + name + ".json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const ids = new Set();
  return [...builtins, ...customSites].map((site) => {
    if (
      !site.siteId ||
      !site.providerId ||
      !site.category ||
      !site.name ||
      !site.evidenceUrl ||
      !["candidate", "ready", "restricted", "unavailable"].includes(site.status)
    )
      throw Error("Invalid catalog site");
    if (ids.has(site.siteId))
      throw Error("Duplicate catalog site " + site.siteId);
    ids.add(site.siteId);
    validatePublicUrl(site.origin);
    validatePublicUrl(site.evidenceUrl);
    const normalized = structuredClone(site);
    normalized.allowedDomains ||= [
      ...new Set([
        new URL(site.origin).hostname,
        ...(site.institutionUrl ? [new URL(site.institutionUrl).hostname] : []),
      ]),
    ];
    if (
      !Array.isArray(normalized.allowedDomains) ||
      normalized.allowedDomains.some(
        (host) =>
          typeof host !== "string" ||
          host.includes("/") ||
          validatePublicUrl("https://" + host).hostname !== host,
      )
    )
      throw Error("Invalid catalog allowed domains");
    normalized.jobFamilies ||= normalized.majorFamilies || [];
    normalized.regions ||= [];
    if (
      [normalized.jobFamilies, normalized.regions].some(
        (values) =>
          !Array.isArray(values) ||
          values.some((v) => typeof v !== "string" || v.length > 200),
      )
    )
      throw Error("Invalid catalog recruiting metadata");
    normalized.adapter ||= site.providerId;
    normalized.identityEvidence ||= {
      url: site.evidenceUrl,
      kind: "official_entry",
      checkedAt: site.verifiedAt || null,
    };
    if (normalized.identityEvidence.url)
      validatePublicUrl(normalized.identityEvidence.url);
    return normalized;
  });
}
