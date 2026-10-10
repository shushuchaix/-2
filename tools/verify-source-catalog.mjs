import { loadSiteCatalog } from "../src/sources/catalog.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
export function catalogCounts(sites) {
  const universities = sites.filter((s) => s.category === "university"),
    employers = sites.filter((s) => s.category === "employer"),
    publicNotices = sites.filter((s) => s.category === "public");
  return {
    universities: universities.length,
    universitySystems: new Set(universities.map((s) => s.providerId)).size,
    employers: employers.length,
    nonInternetEmployers: employers.filter(
      (s) => s.industry && s.industry !== "internet",
    ).length,
    publicNotices: publicNotices.length,
    ready: sites.filter((s) => s.status === "ready").length,
    candidate: sites.filter((s) => s.status === "candidate").length,
  };
}
export function assertCatalogGate(sites) {
  const counts = catalogCounts(sites);
  if (
    counts.universities < 20 ||
    counts.universitySystems < 4 ||
    counts.employers < 10 ||
    counts.nonInternetEmployers < 3 ||
    counts.publicNotices < 6
  )
    throw Error("Catalog gate not satisfied: " + JSON.stringify(counts));
  for (const s of sites)
    if (
      !s.allowedDomains?.length ||
      !s.identityEvidence?.url ||
      !Array.isArray(s.jobFamilies) ||
      !Array.isArray(s.regions) ||
      !s.adapter
    )
      throw Error("Catalog metadata missing: " + s.siteId);
  return {
    ...counts,
    total: sites.length,
    scope: "directory_candidates_not_collected_jobs",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const sites = loadSiteCatalog();
  console.log(JSON.stringify(assertCatalogGate(sites), null, 2));
  if (process.argv.includes("--live")) {
    const { probeCatalog, readinessSummary } = await import(
      "./probe-sources-v2.mjs"
    );
    let results;
    try {
      const report = JSON.parse(
        await fs.readFile(
          "docs/reports/2026-10-05-source-readiness.json",
          "utf8",
        ),
      );
      if (Date.now() - Date.parse(report.checkedAt) < 15 * 60 * 1000)
        results = report.results;
    } catch {}
    results ||= await probeCatalog(sites);
    const summary = readinessSummary(results);
    console.log(JSON.stringify(summary));
    if (summary.newProviders < 6 || summary.categories < 4)
      throw Error("Live direct-provider gate not satisfied");
  }
}
