// Compatibility entry points over the shared v2 application services.
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT } from "./config.mjs";
import { getDefaultApplicationContext } from "./application/context.mjs";
import {
  analyzeResume,
  normalizeProfile,
  buildTitleKeywords,
  buildWebQueries,
  buildWechatQueries,
  rolesForMajor,
} from "./resume/profile.mjs";
import { analyzeResumeOffline } from "./resume/offline.mjs";
import { DeepSeek } from "./llm/deepseek.mjs";
import { createModelBudget } from "./llm/budget.mjs";
import {
  resumeText as validateResume,
  identifier,
} from "./server/validation.mjs";
import { STATUS_LABELS } from "./store.mjs";
export const RUNS_DIR = path.join(DATA_ROOT, "runs-v2");
const resultContexts = new WeakMap();
export async function createLegacyRunInput({
  resumeText,
  options = {},
  cfg,
  llm,
  context,
  credentials = {},
  onEvent = () => {},
  signal,
}) {
  const text = validateResume(resumeText);
  context ||= await getDefaultApplicationContext(cfg);
  const budget = credentials.modelBudget || createModelBudget();
  const client = new DeepSeek(
    {
      ...cfg,
      deepseek: {
        ...cfg.deepseek,
        apiKey: credentials.userApiKey || llm?.apiKey || cfg.deepseek.apiKey,
      },
    },
    { budget, signal },
  );
  let profile = normalizeProfile(analyzeResumeOffline(text));
  onEvent({ type: "stage", stage: "analyze", label: "解析简历画像" });
  if (options.useLlm !== false && client.available) {
    try {
      profile = await analyzeResume(client, text, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      onEvent({ type: "log", message: "模型画像提取失败，使用离线预览。" });
    }
  }
  const pin = cfg.profile || {},
    pinned = [];
  for (const [key, value] of Object.entries(pin)) {
    if (
      key.startsWith("_") ||
      value == null ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    )
      continue;
    profile[key] = value;
    pinned.push(key);
  }
  if (pinned.length) {
    if (pin.major && !pin.targetRoles) {
      profile.targetRoles = rolesForMajor(profile.major);
      profile.titleKeywords = [];
    }
    profile = normalizeProfile(profile);
    onEvent({ type: "log", message: "画像已按配置钉死：" + pinned.join("、") });
  }
  if (Array.isArray(options.cities)) profile.preferredCities = options.cities;
  else if (Array.isArray(cfg.filters?.cities))
    profile.preferredCities = cfg.filters.cities;
  const year =
    options.graduationYear ??
    cfg.filters?.graduationYear ??
    profile.graduationYear;
  if (year !== undefined) profile.graduationYear = String(year || "");
  if (Array.isArray(options.titleKeywords) && options.titleKeywords.length)
    profile.titleKeywords = options.titleKeywords;
  const titleKeywords = buildTitleKeywords(profile, {
      max: Math.min(6, options.maxTitleKeywords || 6),
    }),
    webQueries = buildWebQueries(profile, {
      cities: profile.preferredCities,
      max: cfg.sources.searchApi?.maxQueries || 6,
    }),
    wechatQueries =
      cfg.sources.wechat?.enabled === false
        ? []
        : buildWechatQueries(profile, { max: 6 });
  onEvent({ type: "profile", profile });
  onEvent({
    type: "queries",
    titleKeywords,
    webQueries,
    wechatQueries,
    targetYear: profile.graduationYear,
  });
  const oldIds = [
    "zhaopin",
    "shixiseng",
    "searchApi",
    "wechat",
    "nowcoder",
    "university",
    "chenyun",
    "jiuyeqiao",
  ];
  const oldSelected = oldIds
    .filter((id) => cfg.sources[id]?.enabled !== false)
    .map((id) => (id === "searchApi" ? "searchapi" : id));
  const extra = oldSelected.length
    ? Object.entries(cfg.sources)
        .filter(
          ([id, c]) =>
            !oldIds.includes(id) &&
            context.registry.get(id) &&
            c?.enabled === true,
        )
        .map(([id]) => id)
    : [];
  const sourceIds = options.sourceIds || [...oldSelected, ...extra];
  const saved = await context.workspaceService.saveProfile({
    text,
    profile: {
      ...profile,
      education: profile.degree,
      cities: profile.preferredCities,
      explicitFacts: {},
      inferred: true,
    },
    parserVersion: "legacy-inferred-2",
  });
  const target = await context.workspaceService.saveTarget({
    profileRevisionId: saved.revisionId,
    roles: titleKeywords.length ? titleKeywords : ["应届生"],
    cityMode: Array.isArray(options.cities)
      ? options.cities.length
        ? "selected"
        : "any"
      : profile.preferredCities.length
        ? "from_profile"
        : "any",
    cities: profile.preferredCities,
    graduationYear: profile.graduationYear || null,
    jobTypes:
      (options.includeInternship ?? cfg.filters?.includeInternship)
        ? ["campus", "internship"]
        : ["campus"],
    degreePolicy: cfg.filters?.minDegree
      ? "minimum_requirement"
      : "eligibility",
    minDegree: cfg.filters?.minDegree || null,
    sourceIds: sourceIds.length ? sourceIds : ["legacy-no-sources"],
    siteIds: options.siteIds || [],
    coverageMode: options.coverageMode || "standard",
  });
  return {
    targetRevisionId: target.revisionId,
    mode:
      options.useLlm === false ? "rules" : client.available ? "ai" : "rules",
    credentials: {
      ...credentials,
      modelBudget: budget,
      userApiKey: credentials.userApiKey || llm?.apiKey || undefined,
    },
    profile,
    titleKeywords,
    webQueries,
    wechatQueries,
  };
}
export function snapshotToLegacy(snapshot, { cfg, workspace, registry }) {
  const run = snapshot.run,
    profile = snapshot.profileRevision?.profile || {};
  const evaluations = new Map(snapshot.evaluations.map((e) => [e.jobId, e]));
  const recommendation = {
    high: "高度匹配",
    consider: "比较匹配",
    low: "弱匹配",
    insufficient: "信息不足",
    not_recommended: "不匹配",
  };
  const jobs = snapshot.jobs.map((job) => {
    const evaluation = evaluations.get(job.jobId),
      application = workspace.applications[job.jobId] || {
        status: "new",
        note: "",
      };
    return {
      ...job.canonical,
      id: job.jobId,
      jobId: job.jobId,
      city: job.canonical.cities.join(" / "),
      education: job.canonical.degree || "",
      salary:
        typeof job.canonical.salary === "object"
          ? job.canonical.salary?.raw || ""
          : job.canonical.salary || "",
      source: job.canonical.sourceId,
      sourceName:
        registry.get(job.canonical.sourceId)?.name || job.canonical.sourceId,
      score: evaluation?.score || 0,
      preScore: evaluation?.ruleScore || 0,
      verdict: recommendation[evaluation?.recommendation] || "未评级",
      matchedKeywords:
        evaluation?.evidence?.map((e) => e.skillId).filter(Boolean) || [],
      reasons: evaluation?.modelAdvice?.reasons || [],
      gaps: evaluation?.gaps || [],
      qualification: evaluation?.qualification || { status: "unknown" },
      completeness: evaluation?.completeness || {},
      tracking: {
        status: application.status,
        statusLabel: STATUS_LABELS[application.status],
        firstSeen: job.firstSeen,
        lastSeen: job.lastSeen,
        isNew:
          job.targetFirstSeen?.[run.targetSnapshot?.targetId] >= run.startedAt,
        note: application.note,
      },
    };
  });
  const bySource = {},
    byVerdict = {};
  for (const job of jobs) {
    bySource[job.sourceName] = (bySource[job.sourceName] || 0) + 1;
    byVerdict[job.verdict] = (byVerdict[job.verdict] || 0) + 1;
  }
  return {
    runId: run.runId,
    createdAt: run.createdAt || run.startedAt,
    durationMs: Math.max(
      0,
      Date.parse(run.finishedAt) - Date.parse(run.startedAt),
    ),
    resumeProfile: {
      ...profile,
      degree: profile.education || profile.degree,
      preferredCities: profile.cities || profile.preferredCities || [],
    },
    queries: {
      titleKeywords: run.targetSnapshot?.roles || [],
      webQueries: buildWebQueries(profile, { max: 6 }),
    },
    funnel: {
      raw: run.counts.raw || 0,
      deduped: run.counts.deduplicated || 0,
      afterYear: run.counts.eligible || 0,
      degreeCut: snapshot.evaluations.filter(
        (e) => e.qualification?.status === "fail",
      ).length,
      prescored: jobs.length,
      shortlisted: run.counts.shortlisted || 0,
      scored: jobs.length,
      returned: jobs.length,
    },
    stats: {
      rawCount: run.counts.raw || 0,
      afterDedupe: run.counts.deduplicated || 0,
      afterFilter: jobs.length,
      returned: jobs.length,
      bySource,
      byVerdict,
    },
    config: {
      searchProvider: cfg.__activeSearchProvider || "none",
      deepseekKeySource: cfg.__deepseekKeySource || "none",
    },
    errors: (run.issues || []).map((i) => i.message || i.code),
    llmUsage: {
      calls: run.usage.model?.requests || 0,
      promptTokens: run.usage.model?.promptTokens || 0,
      completionTokens: run.usage.model?.completionTokens || 0,
    },
    jobs,
    status: run.status,
  };
}
export async function runPipeline({
  resumeText,
  llm,
  cfg,
  options = {},
  onEvent = () => {},
  signal,
  context,
  credentials = {},
  legacyInput,
  startedRun,
} = {}) {
  context ||= await getDefaultApplicationContext(cfg);
  const permit =
    credentials.permit || context.gate.acquire(credentials.ip || "cli");
  if (!permit.ok) {
    const error = Error(permit.reason);
    error.status = permit.status;
    error.retryAfterMs = permit.retryAfterMs;
    throw error;
  }
  let stop, abort, runId;
  try {
    const input =
      legacyInput ||
      (await createLegacyRunInput({
        resumeText,
        llm,
        cfg,
        options,
        context,
        credentials: { ...credentials, permit },
        onEvent,
        signal,
      }));
    const started = startedRun || (await context.runService.startRun(input));
    runId = started.runId;
    if (signal) {
      abort = () => void context.runService.cancelRun(runId);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
    stop = await context.eventHub.subscribe(runId, {
      afterSeq: 0,
      onEvent: (event) => {
        if (event.type === "stage")
          onEvent({
            type: "stage",
            stage: event.payload.stage,
            label: event.payload.stage,
          });
        else if (event.type === "queued")
          onEvent({ type: "queued", position: event.payload.position });
        else if (event.type === "source")
          onEvent({
            type: "log",
            message: "来源完成：" + event.payload.sourceId,
          });
        else if (event.type === "batch")
          onEvent({
            type: "jobsFound",
            count: event.payload.counts.deduplicated,
          });
      },
    });
    const snapshot = await context.runService.waitForRun(runId),
      workspace = await context.repository.read(),
      result = snapshotToLegacy(snapshot, {
        cfg,
        workspace,
        registry: context.registry,
      });
    resultContexts.set(result, context);
    onEvent({ type: "result", result });
    return result;
  } finally {
    stop?.();
    if (abort) signal.removeEventListener("abort", abort);
    permit.release();
  }
}
export async function saveRun(result, { context } = {}) {
  context ||= resultContexts.get(result);
  if (!context)
    throw Error("Result does not belong to a shared application run");
  const run = await context.runService.getRun(identifier(result.runId));
  if (!run.snapshotRef) throw Error("Run snapshot not saved");
  return path.join(context.repository.dataDir, run.snapshotRef.path);
}
export async function loadRun(runId, { context, cfg } = {}) {
  identifier(runId);
  context ||= await getDefaultApplicationContext(
    cfg || (await import("./config.mjs")).loadConfig({ quiet: true }),
  );
  const run = (await context.repository.read()).runs[runId];
  if (!run || run.deletedAt) return null;
  if (run.legacy) {
    if (run.snapshotRef)
      return (await context.repository.readRunSnapshot(runId)).legacyResult;
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(context.repository.dataDir, "runs", runId + ".json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return {
        runId,
        jobs: [],
        stats: { returned: 0 },
        errors: ["旧运行原始文件缺失"],
      };
    }
  }
  const snapshot = await context.runService.waitForRun(runId);
  return snapshotToLegacy(snapshot, {
    cfg: context.cfg,
    workspace: await context.repository.read(),
    registry: context.registry,
  });
}
export async function listRuns(limit = 50, { context, cfg } = {}) {
  context ||= await getDefaultApplicationContext(
    cfg || (await import("./config.mjs")).loadConfig({ quiet: true }),
  );
  return (await context.runService.listRuns()).slice(0, limit).map((run) => ({
    runId: run.runId,
    createdAt: run.createdAt || run.startedAt,
    returned: run.counts.returned ?? run.counts.deduplicated ?? 0,
    targetRoles: run.targetSnapshot?.roles || [],
    cities: run.targetSnapshot?.cities || [],
    size: 0,
  }));
}
