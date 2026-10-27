import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";

// Created only inside the formal utility backend, after its network guard.
export function createBackendSyntheticEnvironment({ dataDir }) {
  if (
    !/^rjr-self-test-[\w-]+$/.test(path.basename(dataDir)) ||
    !fs.existsSync(path.join(dataDir, ".rjr-self-test")) ||
    fs.lstatSync(dataDir).isSymbolicLink()
  )
    throw Error("unsafe_self_test_directory");
  let now = Date.parse("2026-10-09T00:00:00Z");
  const clock = {
    now: () => now,
    advance: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw Error("invalid_clock_advance");
      now += ms;
    },
  };
  const controls = {
    hold: false,
    failCleanup: false,
    failCleanupRunIds: new Set(),
  };
  const record = {
    sourceId: "synthetic-desktop",
    siteId: "synthetic-desktop-1",
    sourceRecordId: "offline-1",
    sourceRecordIdKind: "authority",
    urlKind: "job_detail",
    identityScope: "synthetic-desktop-1",
    kind: "job",
    title: "消防工程师与机场应急保障岗位合成长中文名称用于换行检查",
    company: "合成机场集团",
    cities: ["合成市"],
    jobType: "campus",
    graduationYear: 2027,
    degree: "本科",
    url: "https://jobs.example.invalid/offline-1",
    description:
      "合成公开岗位：消防工程专业，本科，2027届。负责机场消防、应急管理与安全检查。",
    requiredCertificates: [],
    publishedAt: new Date(now).toISOString(),
    parserVersion: "synthetic-desktop-1",
    evidence: [],
  };
  const provider = {
    id: "synthetic-desktop",
    name: "合成离线来源",
    capabilities: { category: "job_board", jobTypes: ["campus"], detail: true },
    configSchema: { enabled: "boolean" },
    async collect(ctx) {
      if (controls.hold && ctx.queries?.some((q) => q.keyword))
        await new Promise((resolve) =>
          ctx.signal.addEventListener("abort", resolve, { once: true }),
        );
      ctx.signal?.throwIfAborted();
      await ctx.onBatch?.([structuredClone(record)]);
      return {
        records: [structuredClone(record)],
        issues: [],
        coverage: [
          {
            sourceId: this.id,
            siteId: "synthetic-desktop-1",
            status: "complete",
            queries: ["消防"],
            cities: ["合成市"],
            pages: 1,
          },
        ],
        stats: { raw: 1, parsed: 1, accepted: 1 },
      };
    },
    async fetchDetail(job) {
      return job;
    },
    async probe() {
      return { status: "ready" };
    },
  };
  const cfg = {
    deepseek: {
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      concurrency: 1,
      timeoutMs: 10000,
      allowUserKey: true,
    },
    search: {
      provider: "none",
      tavilyApiKey: "",
      serperApiKey: "",
      bochaApiKey: "",
    },
    sources: {
      zhaopin: { enabled: false, maxPages: 0 },
      shixiseng: { enabled: false, maxPages: 0 },
      "synthetic-desktop": { enabled: true },
      coverageMode: "standard",
      v2Budgets: {
        maxSites: 1,
        maxRequests: 10,
        maxKeywords: 2,
        maxPagesPerQuery: 1,
        maxDetails: 2,
      },
    },
    match: { shortlistSize: 10, enrichTopN: 0, scoreBatchSize: 5, minScore: 0 },
    filters: {
      graduationYear: "2027",
      includeInternship: false,
      strict: true,
      yearQueryCount: 1,
      cities: [],
    },
    profile: {},
    auth: {
      mode: "none",
      passwordHash: "",
      sessionTtlHours: 1,
      maxLoginFails: 5,
      lockMinutes: 1,
    },
    limits: {
      maxConcurrent: 2,
      maxQueue: 4,
      dailyGlobal: 100,
      dailyPerIp: 100,
      perIpCooldownMs: 0,
    },
    server: { host: "127.0.0.1", port: 0, trustProxy: false, publicUrl: "" },
    network: { dnsMode: "system" },
    __searchKeys: {},
    __activeSearchProvider: "",
    __deepseekKeySource: "synthetic",
  };
  const dependencies = {
    clock,
    startScheduler: false,
    fsAdapter: {
      ...fsAsync,
      async unlink(filename) {
        if (
          controls.failCleanup &&
          /[\\/]runs-v2[\\/]/.test(filename) &&
          controls.failCleanupRunIds.has(path.basename(filename, ".json"))
        )
          throw Object.assign(Error("synthetic_cleanup_failure"), {
            code: "EIO",
          });
        return fsAsync.unlink(filename);
      },
    },
    registry: {
      get: (id) => (id === provider.id ? provider : undefined),
      list: () => [provider],
    },
    catalog: [
      {
        siteId: "synthetic-desktop-1",
        providerId: provider.id,
        category: "job_board",
        name: "合成离线来源",
        origin: "https://jobs.example.invalid",
        status: "ready",
        verifiedAt: new Date(now).toISOString(),
        probeEvidence: [{ hasRequirements: true }],
      },
    ],
    requestFactory: () => async () => {
      throw Error("offline_network_forbidden");
    },
    modelFactory: () => ({
      synthetic: true,
      available: true,
      async chatJson() {
        return [];
      },
    }),
  };
  return { dataDir, cfg, dependencies, clock, controls };
}
