// Compatibility entry points over the shared v2 application services.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import {
  resumeText as validateResume,
  identifier,
} from "./server/validation.mjs";
import { STATUS_LABELS } from "./store.mjs";
import {resolveLegacyScope} from './application/legacy-scope.mjs';
import {packageWorkspace} from './application/package-job-service.mjs';
import {packageError} from './domain/packages.mjs';
import {
  projectJobApplication,
  resolveJobId,
} from "./domain/job-resolution.mjs";
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
  operationLease,
}) {
  const text = validateResume(resumeText);
  context ||= await getDefaultApplicationContext(cfg);
  const modern=(await context.repository.read()).schemaVersion===3;
  if(!modern)operationLease ||= await context.operationGate.acquire("legacy", { signal });
  try {
    const budget =
      credentials.modelBudget || (await context.createModelBudget());
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
      onEvent({
        type: "log",
        message: "画像已按配置钉死：" + pinned.join("、"),
      });
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
    const sourceIds = options.sourceIds || [
      ...oldSelected.filter((id) => context.registry.get(id)),
      ...extra,
    ];
    const saved = await context.workspaceService.saveProfile({
      versionName:'兼容简历 · '+randomUUID().slice(0,8),
      submissionId: "legacy-profile-" + randomUUID(),
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
      versionName: "兼容检索 · " + saved.revisionId,
      submissionId: "legacy-target-" + randomUUID(),
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
    const scope=modern?{packageId:target.packageId,targetRevisionId:target.revisionId}:undefined;
    if(modern)operationLease ||= await context.operationGate.acquire('legacy',{scope,signal});
    return {
      targetRevisionId: target.revisionId,
      ...(scope?{scope}:{}),
      operationLease,
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
  } catch (error) {
    await operationLease?.release();
    throw error;
  }
}
export function snapshotToLegacy(snapshot, { cfg, workspace, registry }) {
  const run = snapshot.run,
    profile = snapshot.profileRevision?.profile || snapshot.profile?.profile || {};
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
      application = projectJobApplication(workspace, job.jobId);
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
    ...(workspace.schemaVersion===3?{scope:{packageId:run.ownerPackageId,targetRevisionId:run.targetSnapshot.revisionId}}:{}),
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
      webQueries: buildWebQueries(normalizeProfile(profile), { max: 6 }),
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
      calls: run.usage?.model?.requests || 0,
      promptTokens: run.usage?.model?.promptTokens || 0,
      completionTokens: run.usage?.model?.completionTokens || 0,
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
  let stop, abort, runId, input;
  try {
    input =
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
      abort = () => void context.runService.cancelRun(runId,input.scope);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
    stop = await context.eventHub.subscribe(runId, {
      scope:input.scope,
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
    const snapshot = await context.runService.waitForRun(runId,input.scope),
      full = await context.repository.read(),
      workspace = full.schemaVersion===3?packageWorkspace(full,input.scope.packageId):full,
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
    if (runId) await context.runService.waitForRun(runId,input?.scope).catch(() => {});
    await input?.operationLease?.release();
  }
}
export async function saveRun(result, { context } = {}) {
  context ||= resultContexts.get(result);
  if (!context)
    throw Error("Result does not belong to a shared application run");
  const selected=resolveLegacyScope({scope:result.scope,runId:result.runId},await context.repository.read(),context.repository.clock.now());
  const run = await context.runService.getRun(identifier(result.runId),selected);
  if (!run.snapshotRef) throw Error("Run snapshot not saved");
  return path.join(context.repository.dataDir, run.snapshotRef.path);
}
export async function loadRun(runId, { context, cfg,scope } = {}) {
  identifier(runId);
  context ||= await getDefaultApplicationContext(
    cfg || (await import("./config.mjs")).loadConfig({ quiet: true }),
  );
  const initial=await context.repository.read();
  const run = initial.runs[runId];
  if (!run || run.deletedAt) return null;
  const selected=resolveLegacyScope({scope,runId},initial,context.repository.clock.now());
  if(initial.schemaVersion===3){
    if(!run.snapshotRef)throw packageError('version_scope_required','此旧运行没有经过验证的自有快照。');
    const snapshot=await context.runService.waitForRun(runId,selected);
    return snapshotToLegacy(snapshot,{cfg:context.cfg,workspace:packageWorkspace(await context.repository.read(),selected.packageId),registry:context.registry});
  }
  const projectLegacy = async (result) => {
    const w = await context.repository.read(),
      copy = structuredClone(result);
    copy.jobs = (copy.jobs || copy.results || []).map((job) => {
      let application;
      try {
        const id = resolveJobId(w, job.jobId || job.id, { allowMissing: true });
        if (id) application = projectJobApplication(w, id);
      } catch (error) {
        if (error.code !== "job_identity_ambiguous") throw error;
      }
      application ||= w.applications["legacy:" + (job.jobId || job.id)];
      return application
        ? {
            ...job,
            status: application.status,
            note: application.note,
            tracking: {
              ...job.tracking,
              status: application.status,
              statusLabel: STATUS_LABELS[application.status],
              note: application.note,
            },
          }
        : job;
    });
    return copy;
  };
  if (run.legacy) {
    if (run.snapshotRef)
      return projectLegacy(
        (await context.repository.readRunSnapshot(runId)).legacyResult,
      );
    try {
      return projectLegacy(
        JSON.parse(
          await fs.readFile(
            path.join(context.repository.dataDir, "runs", runId + ".json"),
            "utf8",
          ),
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
export async function listRuns(limit = 50, { context, cfg,scope,targetRevisionId,targetId } = {}) {
  context ||= await getDefaultApplicationContext(
    cfg || (await import("./config.mjs")).loadConfig({ quiet: true }),
  );
  const selected=resolveLegacyScope({scope,targetRevisionId,targetId},await context.repository.read(),context.repository.clock.now());
  return (await context.runService.listRuns(selected)).slice(0, limit).map((run) => ({
    runId: run.runId,
    createdAt: run.createdAt || run.startedAt,
    returned: run.counts.returned ?? run.counts.deduplicated ?? 0,
    targetRoles: run.targetSnapshot?.roles || [],
    cities: run.targetSnapshot?.cities || [],
    size: 0,
  }));
}
