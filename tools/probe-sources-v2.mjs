import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDefaultSourceRegistry } from "../src/sources/registry.mjs";
import { loadSiteCatalog } from "../src/sources/catalog.mjs";
import { createRequestClient } from "../src/infrastructure/http/client.mjs";
import { createSourceBudget } from "../src/infrastructure/http/budget.mjs";
import { assessSourceProbe } from "../src/sources/source-quality.mjs";
export async function probeCapabilities(
  provider,
  site,
  { budget, request, clock = { now: Date.now } },
) {
  const context = {
      sites: [site],
      queries: [{ keyword: "", pageLimit: 1 }],
      targetSnapshot: { cities: [] },
      budget,
      request,
      clock,
    },
    list = await provider.collect(context),
    details = [],
    issues = [...(list.issues || [])];
  for (const r of list.records.slice(0, 2))
    try {
      details.push(await provider.fetchDetail(r, context));
    } catch (e) {
      issues.push({ code: e.code || "detail_unavailable" });
    }
  const q = assessSourceProbe({
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
  return {
    sourceId: provider.id,
    siteId: site.siteId,
    status:
      q.verification === "ready"
        ? "ready"
        : q.verification === "restricted"
          ? "restricted"
          : list.records.length
            ? "parse_error"
            : "empty",
    capabilities: q.capabilities,
    capabilityEvidence: q.evidence,
    checkedAt: q.checkedAt,
    sampleCount: list.records.length,
    issues: [...issues, ...q.issues],
    evidence: details.map((r) => ({
      sourceRecordId: r.sourceRecordId,
      title: r.title,
      url: r.url,
      hasRequirements:
        typeof r.description === "string" &&
        r.description.trim().length >= 30 &&
        !["discovery_only", "incomplete", "restricted"].includes(
          r.detailStatus,
        ),
    })),
    budget: budget.snapshot(),
  };
}
export const NEW_DIRECT_PROVIDERS = new Set([
  "ncss",
  "university-91job",
  "official-announcements",
  "yingjiesheng",
  "tencent",
  "smartrecruiters",
  "greenhouse",
]);
export function isReadyEvidence(result) {
  return (
    result.status === "ready" &&
    NEW_DIRECT_PROVIDERS.has(result.sourceId) &&
    result.evidence?.some(
      (e) => e.sourceRecordId && e.title && e.url && e.hasRequirements === true,
    )
  );
}
export function countReadyProviders(results) {
  return new Set(results.filter(isReadyEvidence).map((r) => r.sourceId)).size;
}
export async function probeCatalog(
  sites = loadSiteCatalog(),
  {
    sourceId,
    siteId,
    registry = createDefaultSourceRegistry(),
    requestFactory = createRequestClient,
  } = {},
) {
  const selected = sites.filter(
    (s) =>
      (!sourceId || s.providerId === sourceId) &&
      (!siteId || s.siteId === siteId),
  );
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < selected.length) {
        const site = selected[next++],
          provider = registry.get(site.providerId);
        if (
          !provider ||
          !NEW_DIRECT_PROVIDERS.has(site.providerId) ||
          (site.providerId === "official-announcements" && !site.template)
        ) {
          results.push({
            sourceId: site.providerId,
            siteId: site.siteId,
            category: site.category,
            status: "unavailable",
            checkedAt: new Date().toISOString(),
            sampleCount: 0,
            evidence: [],
            issues: [
              {
                code: "candidate_not_verified",
                message:
                  "Directory candidate; no verified public collection contract in this probe.",
              },
            ],
          });
          continue;
        }
        const budget = createSourceBudget({ maxRequests: 6, maxDetails: 2 });
        let result;
        try {
          result = await probeCapabilities(provider, site, {
            budget,
            request: requestFactory({ budget }),
          });
        } catch (e) {
          result = {
            sourceId: site.providerId,
            siteId: site.siteId,
            status: "unavailable",
            sampleCount: 0,
            checkedAt: new Date().toISOString(),
            evidence: [],
            issues: [
              {
                code: e.code || "unavailable",
                message: "Public source probe failed.",
              },
            ],
            budget: budget.snapshot(),
          };
        }
        results.push({ ...result, category: site.category });
        process.stdout.write(
          site.siteId +
            ": " +
            result.status +
            " (" +
            result.sampleCount +
            ")\n",
        );
      }
    }),
  );
  return results.sort((a, b) => a.siteId.localeCompare(b.siteId));
}
export function readinessSummary(results) {
  const ready = results.filter(isReadyEvidence);
  return {
    newProviders: countReadyProviders(results),
    categories: new Set(ready.map((r) => r.category)).size,
    readySites: ready.length,
    candidateSites: results.length - ready.length,
  };
}
export function readinessMarkdown(results) {
  const summary = readinessSummary(results);
  return (
    "# Job Radar v2 来源接入验证\n\n检查时间：" +
    new Date().toISOString() +
    "。独立普通公网 GET/POST；每站最多 6 请求/2 详情（DNS、重试、重定向计入）。\n\n新增有效直连 provider " +
    summary.newProviders +
    " 个，渠道类别 " +
    summary.categories +
    " 类。ready 仅指本次可读取稳定 ID、标题、URL 与正文；不保证未来持续可用。目录数量包括有官方归属证据的 candidate，不表示全部已接通。搜索、主页、人工导入、社交元数据不计直连。\n\n|站点|Provider|类别|状态|样本|请求/详情|时间|问题|\n|---|---|---|---|---:|---|---|---|\n" +
    results
      .map(
        (r) =>
          "|" +
          [
            r.siteId,
            r.sourceId,
            r.category,
            r.status,
            r.sampleCount,
            (r.budget?.requests || 0) + "/" + (r.budget?.details || 0),
            r.checkedAt,
            (r.issues || []).map((i) => i.code).join(","),
          ].join("|") +
          "|",
      )
      .join("\n") +
    "\n\n## 有效正文证据\n\n" +
    results
      .filter(isReadyEvidence)
      .map(
        (r) =>
          "- " +
          r.siteId +
          ": " +
          r.evidence
            .filter((e) => e.hasRequirements)
            .map(
              (e) =>
                "[" +
                e.title.replace(/[\[\]]/g, "") +
                "](" +
                e.url +
                ")，ID `" +
                e.sourceRecordId +
                "`",
            )
            .join("；"),
      )
      .join("\n") +
    "\n"
  );
}
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const results = await probeCatalog(loadSiteCatalog(), {
    sourceId: arg("--source"),
    siteId: arg("--site"),
  });
  const report = arg("--report");
  if (report) {
    await fs.mkdir(path.dirname(report), { recursive: true });
    await fs.writeFile(report, readinessMarkdown(results));
    await fs.writeFile(
      report.replace(/\.md$/i, "") + ".json",
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          summary: readinessSummary(results),
          results,
        },
        null,
        2,
      ) + "\n",
    );
  }
  console.log(JSON.stringify(readinessSummary(results)));
  if (
    !arg("--source") &&
    !arg("--site") &&
    (countReadyProviders(results) < 6 ||
      readinessSummary(results).categories < 4)
  )
    process.exitCode = 1;
}
