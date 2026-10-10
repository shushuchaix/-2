import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../src/infrastructure/storage/repository.mjs";
import { createApplicationContext } from "../src/application/context.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { createCollectionService } from "../src/application/collection-service.mjs";
import { createCollectionLedger } from "../src/application/collection-ledger.mjs";
import { createAttachmentService } from "../src/attachments/service.mjs";
import { createLocalOcr } from "../src/attachments/ocr.mjs";
import { createConditionalCache } from "../src/infrastructure/http/conditional-cache.mjs";
import { createRequestClient } from "../src/infrastructure/http/client.mjs";
import { createDefaultSourceRegistry } from "../src/sources/registry.mjs";
import { loadSiteCatalog } from "../src/sources/catalog.mjs";
import {
  assessRecruitmentEvidence,
  isVerifiedRecommendation,
} from "../src/domain/recruitment-evidence.mjs";
import {
  selectVersionJobFact,
  selectMatchingEvaluation,
} from "../src/domain/job-facts.mjs";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const officialWechat = "https://mp.weixin.qq.com/s/VDLrenAyqOeoLFL4BVfK6g";
const pilotSites = [
  {
    siteId: "ncss",
    providerId: "ncss",
    name: "国家大学生就业服务平台",
    origin: "https://main.ncss.cn/student/jobs/index.html",
  },
  {
    ...loadSiteCatalog().find(
      (site) => site.siteId === "official-guizhou-airport",
    ),
  },
  {
    siteId: "pilot-shanghai-airport",
    providerId: "official-announcements",
    name: "上海机场",
    origin: "https://www.shanghaiairport.com",
    template: {
      listUrl: "https://www.shanghaiairport.com/shzp/index.html",
      linkRule: "a[href]",
      bodyRule: "article,.news-content,.content_detail",
      pathPrefix: "/shzp/",
    },
  },
  {
    siteId: "pilot-fire-company",
    providerId: "official-announcements",
    name: "广东文华消防工程",
    origin: "https://www.gdwhjs.cn",
    template: {
      listUrl: "https://www.gdwhjs.cn/h-col-137.html",
      linkRule: "a[href]",
      bodyRule: "article,.newsDetailContent,.richContent",
      pathPrefix: "/",
    },
  },
  {
    siteId: "pilot-wechat",
    providerId: "wechat",
    name: "湖南机场官网链接的公众号文章",
    origin: "https://mp.weixin.qq.com",
    officialEntry:
      "https://www.hunanairport.cn/content/646049/56/15910336.html",
  },
  {
    siteId: "pilot-weibo",
    providerId: "weibo",
    name: "国家消防救援局官方微博",
    origin: "https://www.weibo.com/smtdtyhd",
  },
];
const limits = {
  maxRequests: 180,
  maxDetails: 20,
  maxSites: 10,
  maxPagesPerQuery: 2,
  maxQueryGroups: 6,
  maxAttachments: 10,
  maxTotalAttachmentBytes: 100 * 1048576,
  maxCostCny: 10,
};

/** Read an existing activity. Resume always uses this same persisted root and ledger. */
export async function pilotRecruitmentCoverage({
  scope,
  activityId,
  sourceIds,
  since,
  limits: requestedLimits,
  readOnlyServices,
}) {
  const { collectionService, repository } = readOnlyServices,
    ref = { scope, activityId };
  await collectionService.wait(ref);
  const root = await collectionService.get(ref),
    w = await repository.read(),
    p = root.collectionProgress;
  if (
    requestedLimits &&
    JSON.stringify(requestedLimits) !==
      JSON.stringify(root.collectionProgress.limits)
  )
    throw Error("Pilot limits must match the existing activity");
  const facts = (p.newJobIds || [])
    .map((id) => {
      const job = w.jobs[id],
        fact =
          job &&
          selectVersionJobFact(w, {
            jobId: id,
            targetRevisionId: scope.targetRevisionId,
          });
      if (!fact?.record) return null;
      const evaluation = selectMatchingEvaluation(w, {
          jobId: id,
          targetRevisionId: scope.targetRevisionId,
          profileRevisionId: root.profileSnapshot?.revisionId,
          factContentHash: fact.factContentHash,
        }),
        evidence = assessRecruitmentEvidence({
          record: fact.record,
          now: Date.now(),
        });
      return {
        jobId: id,
        record: fact.record,
        evaluation,
        evidence,
        valid: isVerifiedRecommendation({
          qualification: evaluation?.qualification,
          evidence,
        }),
      };
    })
    .filter(Boolean);
  const counts = {
    newUnique: facts.length,
    validNewUnique: facts.filter((f) => f.valid).length,
    bodyComplete: facts.filter((f) => f.evidence.bodyVerified).length,
    applicationAvailable: facts.filter(
      (f) => f.evidence.applicationStatus === "available",
    ).length,
    expired: facts.filter((f) =>
      ["closed", "historical"].includes(f.evidence.openingStatus),
    ).length,
    pending: facts.filter((f) => !f.valid).length,
    duplicateCandidates: Math.max(
      0,
      Object.values(w.runs)
        .filter((r) => r.collectionActivityId === activityId)
        .reduce((n, r) => n + (r.counts?.normalized || 0), 0) - facts.length,
    ),
  };
  const social = facts.filter((f) =>
      ["wechat", "weibo"].includes(f.record.sourceId),
    ),
    recent = social.filter(
      (f) =>
        f.record.publishedAt &&
        Date.parse(f.record.publishedAt) >= Date.parse(since),
    );
  const sources = (
    sourceIds || [...new Set(Object.values(p.units).map((u) => u.sourceId))]
  ).map((sourceId) => ({
    sourceId,
    units: Object.values(p.units)
      .filter((u) => u.sourceId === sourceId)
      .map((u) => ({
        siteId: u.siteId,
        status: u.status,
        committedPages: u.committedPages,
        reason: u.stopReason || u.truncationReason || u.lastErrorCode || null,
        nextDueAt: u.nextDueAt || null,
      })),
    newUnique: facts.filter((f) => f.record.sourceId === sourceId).length,
    bodyComplete: facts.filter(
      (f) => f.record.sourceId === sourceId && f.evidence.bodyVerified,
    ).length,
  }));
  const usage = root.collectionUsage;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    activityId,
    since,
    scope,
    model: "deepseek-flash",
    modelLabel: "DeepSeek v4.1",
    modelCallsEnabled: false,
    qualificationReference:
      "synthetic generic fire-engineering profile; no personal resume or credentials read",
    counts,
    usage,
    requestsDenominator:
      "knownPhysicalRequests includes verified automatic HTTP and DNS attempts; unknown upper bounds reported separately",
    accountingLimitations: [
      "The first 43 reserved attempts predate ordinary-text byte settlement; usedBytes is a partial measurement, not total pilot traffic.",
      "DNS responses before the Task 15 settlement fix remain conservatively reserved; knownPhysicalRequests is not the total number of attempted transports.",
    ],
    validNewPer100KnownRequests: usage.knownPhysicalRequests
      ? (100 * counts.validNewUnique) / usage.knownPhysicalRequests
      : null,
    sources,
    social: {
      verifiedAccountLimit: 20,
      targetSample: 100,
      since,
      reachableRecentRecruitmentRecords: recent.length,
      nonRecruitmentCandidates: p.metrics?.raw || 0,
      coverage:
        "reachable public pages only; seven-day full recall and intent error rates are not established",
    },
    manualReference: {
      method:
        "visible evidence audit, at most ten records in each category; no platform-wide recall estimate",
      newUnique: facts.slice(0, 10).map(publicEvidence),
      pending: facts
        .filter((f) => !f.valid)
        .slice(0, 10)
        .map(publicEvidence),
      expired: facts
        .filter((f) =>
          ["closed", "historical"].includes(f.evidence.openingStatus),
        )
        .slice(0, 10)
        .map(publicEvidence),
    },
    issues: Object.values(w.runs)
      .filter((r) => r.collectionActivityId === activityId)
      .flatMap((r) =>
        (r.issues || []).map((i) => ({
          code: i.code,
          sourceId: i.sourceId,
          siteId: i.siteId,
        })),
      ),
    status: p.status,
  };
}
function publicEvidence(f) {
  return {
    jobId: f.jobId,
    title: f.record.title,
    url: f.record.url,
    publishedAt: f.record.publishedAt,
    deadlineAt: f.record.deadlineAt,
    bodyVerified: f.evidence.bodyVerified,
    openingStatus: f.evidence.openingStatus,
    applicationStatus: f.evidence.applicationStatus,
    qualification: f.evaluation?.qualification?.status || "unknown",
    conflicts: f.evidence.conflicts?.map((c) => c.field) || [],
  };
}

async function main() {
  const reportOnly = process.argv.includes("--report-only");
  if (!process.argv.includes("--live") && !reportOnly) {
    console.log(
      "Use --live for the approved public pilot; --report-only reads existing results without collection. Resume always retains the same root budget.",
    );
    return;
  }
  const dataDir = path.join(project, ".cache/source-expansion-pilot-20261009"),
    statePath = path.join(dataDir, "pilot-root.json"),
    reportPath = path.join(dataDir, "public-pilot-report.json");
  let previousReport = {};
  try {
    previousReport = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.search.provider = "none";
  cfg.deepseek.apiKey = "";
  cfg.limits = { ...cfg.limits, globalConcurrency: 1 };
  const context = await createApplicationContext({
      cfg,
      dataDir,
      dependencies: {
        collectionRuntime: { verified: false, code: "pilot_static_only" },
      },
    }),
    ledger = createCollectionLedger({ repository: context.repository }),
    ocr = createLocalOcr({ resourceDir: path.join(project, "resources/ocr") });
  const proofs = previousReport.protocolProofs || {},
    base = context.registry,
    requestLog = previousReport.publicRequests || [],
    units = pilotSites.flatMap((site) =>
      (site.providerId === "ncss" ? ["消防", "机场"] : ["消防"]).map(
        (keyword, index) => ({
          unitId: "u-" + contentHash([site.siteId, keyword]).slice(0, 24),
          sourceId: site.providerId,
          siteId: site.siteId,
          site,
          queryIndex: index,
          query: { keyword, pageLimit: 2 },
        }),
      ),
    );
  const registry = {
    list: () => base.list(),
    get(id) {
      const provider = base.get(id);
      if (!provider) return null;
      return {
        ...provider,
        async collectPage(input) {
          const config = structuredClone(input.config || {});
          if (id === "ncss" && !proofs.ncss) {
            const page = await input.request(
              "https://main.ncss.cn/student/jobs/index.html",
              { maxRetries: 0 },
            );
            const script = page.text.match(
              /https:\/\/t2\.chei\.com\.cn\/ncss\/student\/js\/jobindex-[\w.-]+\.js/,
            );
            if (page.status !== 200 || !script)
              throw Object.assign(Error("NCSS current page protocol missing"), {
                code: "pilot_protocol_unverified",
              });
            const code = await input.request(script[0], { maxRetries: 0 });
            if (!code.text.includes("/student/jobs/jobslist/ajax/"))
              throw Object.assign(Error("NCSS current list protocol missing"), {
                code: "pilot_protocol_unverified",
              });
            proofs.ncss = {
              entry: "https://main.ncss.cn/student/jobs/index.html",
              script: script[0],
              endpoint: "/student/jobs/jobslist/ajax/",
              checkedAt: new Date().toISOString(),
            };
          }
          if (id === "wechat") {
            if (!proofs.wechat) {
              const page = await input.request(
                pilotSites.find((s) => s.providerId === "wechat").officialEntry,
                { maxRetries: 0 },
              );
              if (page.status !== 200 || !page.text.includes(officialWechat))
                throw Object.assign(
                  Error("Official article reference unavailable"),
                  { code: "pilot_account_unverified" },
                );
              proofs.wechat = {
                officialEntry: pilotSites.find((s) => s.providerId === "wechat")
                  .officialEntry,
                articleUrl: officialWechat,
                checkedAt: new Date().toISOString(),
              };
            }
            config.wechat = { articleUrls: [officialWechat], accountIds: [] };
          }
          if (id === "weibo") {
            if (!proofs.weibo) {
              const response = await input.request(
                  "https://www.weibo.com/smtdtyhd",
                  { maxRetries: 0 },
                ),
                uid = response.text.match(
                  /\$CONFIG\[['"](?:oid|uid)['"]\]\s*=\s*['"](\d+)['"]/,
                )?.[1];
              if (
                response.status !== 200 ||
                !uid ||
                !/国家消防救援局|中国消防/.test(response.text)
              )
                throw Object.assign(
                  Error("Official anonymous account unavailable"),
                  { code: "pilot_account_unverified" },
                );
              proofs.weibo = {
                profile: "https://www.weibo.com/smtdtyhd",
                uid,
                checkedAt: new Date().toISOString(),
              };
            }
            config.weibo = { articleUrls: [], accountIds: [proofs.weibo.uid] };
          }
          return provider.collectPage({ ...input, config });
        },
      };
    },
  };
  const service = createCollectionService({
    repository: context.repository,
    operationGate: context.operationGate,
    registry,
    ledger,
    readService: context.contentReadService,
    attachmentService: createAttachmentService({
      ledger,
      cleanup: context.attachmentCleanup,
      cache: createConditionalCache({ repository: context.repository }),
      ocr,
    }),
    evaluationService: context.evaluationService,
    modelConfig: cfg.deepseek,
    diagnostics: context.diagnostics,
    officialSites: pilotSites,
    planner: async () => ({ units, limits }),
    requestFactory: ({ budget, signal, ...other }) => {
      const client = createRequestClient({
        budget,
        signal,
        ...other,
        dnsMode: "auto",
        diagnostics: context.diagnostics,
      });
      return async (url, options = {}) => {
        try {
          const r = await client(url, {
            ...options,
            maxRetries: 0,
            timeoutMs: 12000,
          });
          if (
            r.status === 200 &&
            new URL(url).pathname.endsWith("/detail.html") &&
            !proofs.publicDetailCaptured
          ) {
            await fs.writeFile(
              path.join(dataDir, "public-ncss-detail.html"),
              r.text,
            );
            proofs.publicDetailCaptured = true;
          }
          requestLog.push({
            origin: new URL(url).origin,
            pathname: new URL(url).pathname,
            status: r.status,
            bytes: r.bytes?.length ?? r.byteLength ?? null,
          });
          return r;
        } catch (e) {
          console.error(
            "Public-only pilot transport failure:",
            e.name,
            e.code || "unavailable",
          );
          requestLog.push({
            origin: new URL(url).origin,
            pathname: new URL(url).pathname,
            code: e.code || "unavailable",
          });
          throw e;
        }
      };
    },
  });
  try {
    await service.recover();
    let state;
    try {
      state = JSON.parse(await fs.readFile(statePath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!state) {
      if (reportOnly) throw Error("Existing pilot root required");
      const profile = await context.workspaceService.saveProfile({
          text: "合成公开来源验收档案：本科消防工程专业，用于公开岗位来源解析与证据完整性验收，不代表任何真实个人简历。",
          profile: { education: "本科", major: "消防工程", cities: [] },
          versionName: "公开来源试点合成档案",
          submissionId: "pilot-generic-profile",
        }),
        target = await context.workspaceService.saveTarget({
          profileRevisionId: profile.revisionId,
          roles: ["消防", "机场"],
          cityMode: "any",
          cities: [],
          jobTypes: ["campus", "social"],
          sourceIds: ["ncss", "official-announcements", "wechat", "weibo"],
          siteIds: [],
          versionName: "2026-10-09公开试点",
          submissionId: "pilot-public-target",
          budgets: {},
          coverageMode: "standard",
        }),
        scope = {
          packageId: target.packageId,
          targetRevisionId: target.revisionId,
        };
      const started = await service.start({
        scope,
        options: { mode: "rules" },
      });
      state = {
        scope,
        activityId: started.activityId,
        since: "2026-10-02T00:00:00+08:00",
      };
      await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
    } else if (!reportOnly) {
      const root = await service.get(state);
      if (process.argv.includes("--extend-coverage")) {
        await service.adjustLimits({
          ref: state,
          limits: { maxDetails: 80, maxPagesPerQuery: 1 },
          expectedRevision: root.collectionProgress.revision,
        });
        await context.repository.mutateWorkspace((w) => {
          for (const unit of Object.values(
            w.runs[state.activityId].collectionProgress.units,
          ))
            if (
              unit.committedPages === 0 &&
              unit.lastErrorCode === "source_unavailable"
            )
              unit.nextDueAt = null;
        });
      }
      // Retry a local Fake-IP configuration failure before any HTTP attempt;
      // retain the original root, ledger, and remote-server retry timestamps.
      if (
        process.argv.includes("--retry-local-dns") &&
        root.collectionUsage.usedRequests === 0 &&
        Object.values(root.collectionProgress.units).every(
          (u) =>
            u.status === "pending" && u.lastErrorCode === "source_unavailable",
        )
      )
        await context.repository.mutateWorkspace((w) => {
          for (const unit of Object.values(
            w.runs[state.activityId].collectionProgress.units,
          ))
            unit.nextDueAt = null;
        });
      if (!["completed", "cancelled"].includes(root.collectionProgress.status))
        await service.resume({
          ref: state,
          requestId: "public-pilot-resume-" + Date.now(),
        });
    }
    const timer =
      !reportOnly &&
      setTimeout(() => service.pause(state).catch(() => {}), 300000);
    let report;
    try {
      report = await pilotRecruitmentCoverage({
        ...state,
        readOnlyServices: {
          collectionService: service,
          repository: context.repository,
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    report.protocolProofs = proofs;
    report.publicRequests = requestLog;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify(
        {
          activityId: state.activityId,
          status: report.status,
          counts: report.counts,
          usage: report.usage,
          sources: report.sources,
          protocolProofs: proofs,
        },
        null,
        2,
      ),
    );
  } finally {
    await service.stop();
    await ocr.close();
    await context.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
