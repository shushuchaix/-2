import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadDataset } from "../evals/dataset.mjs";
import { computeRankingMetrics } from "../evals/metrics.mjs";

/** Synthetic contracts or same-activity live measurement; never allocates a budget. */
export async function runGoldenValidation({
  mode = "offline-contract",
  fixtures,
  modelFactory,
  budget,
  signal,
} = {}) {
  const { renderPrompt, getPromptDefinition } = await import(
    "../src/llm/prompt-registry.mjs"
  );
  const { validateModelResults, validateArticleResponse } = await import(
    "../src/llm/validation.mjs"
  );
  const { expandArticles } = await import("../src/match/article.mjs");
  const { normalizeRecord } = await import("../src/domain/record.mjs");
  const { evaluateRules } = await import("../src/domain/ranking.mjs");
  const { gateRecommendation, assessRecruitmentEvidence } = await import(
    "../src/domain/recruitment-evidence.mjs"
  );
  if (!["offline-contract", "live"].includes(mode))
    throw Error("Invalid golden mode");
  const dataset = Array.isArray(fixtures) ? { fixtures } : fixtures;
  if (!Array.isArray(dataset?.fixtures) || dataset.fixtures.length !== 24)
    throw Error("24 golden fixtures required");
  if (mode === "live" && (!budget || !modelFactory))
    throw Error(
      "Live validation requires the same activity budget and model factory",
    );
  const report = {
    mode,
    status: "complete",
    modelQuality: "not_measured",
    measured: 0,
    passed: 0,
    positiveSamples: 0,
    extractedJobs: 0,
    dangerousFalseRecommendations: 0,
    results: [],
  };
  const now = Date.parse(dataset.now || "2026-10-10T00:00:00.000Z");
  const client =
    mode === "live" ? await modelFactory({ budget, signal }) : null;
  if (client && client.budget !== budget)
    throw Error("Live validation requires the same activity budget");
  let schemaPass = 0,
    fieldPass = 0,
    fieldCount = 0;
  for (const fixture of dataset.fixtures) {
    const expected =
      mode === "live"
        ? fixture.liveExpected || fixture.expected
        : fixture.expected;
    signal?.throwIfAborted();
    if (
      mode === "live" &&
      (client.available === false || (await budget.isExhausted?.()))
    ) {
      report.status = "incomplete";
      break;
    }
    let raw,
      jobs = [],
      qualification = null,
      recommended = false,
      validCount = 0,
      structureValid = false;
    try {
      const definition = getPromptDefinition(fixture.promptId),
        prompt = renderPrompt(fixture.promptId, fixture);
      raw =
        mode === "live"
          ? await client.chatJson(prompt.system, prompt.user, {
              ...definition.parameters,
              signal,
              repair: false,
            })
          : fixture.rawResponse;
      if (fixture.promptId === "matching") {
        const parsed = validateModelResults(raw, { records: fixture.records });
        validCount = parsed.valid.length;
        structureValid =
          validCount === fixture.records.length &&
          !parsed.issues.length &&
          !parsed.missingIds.length;
        const record = normalizeRecord(fixture.records[0]),
          draft = evaluateRules(record, fixture.profile, fixture.target, {
            now,
          });
        qualification = draft.qualification.status;
        const model = parsed.valid.find((r) => r.jobId === record.jobId);
        recommended = gateRecommendation(
          { ...draft, score: model?.score ?? draft.score },
          record,
          now,
        ).recommended;
      } else {
        structureValid = validateArticleResponse(raw).valid;
        const expanded = await expandArticles(
          { chatJson: async () => raw },
          {},
          [fixture.article],
          { signal, concurrency: 1 },
        );
        jobs = expanded.jobs.map(normalizeRecord);
      }
      const observed = {
        validCount,
        qualification,
        recommended,
        jobCount: jobs.length,
        titles: jobs.map((j) => j.title),
        cities:
          fixture.promptId === "matching"
            ? fixture.records[0].cities
            : jobs.map((j) => j.cities[0] || ""),
        deadlineAt: jobs[0]?.deadlineAt ?? null,
        bodyVerified: jobs[0]
          ? assessRecruitmentEvidence({ record: jobs[0], now }).bodyVerified
          : false,
      };
      const checks = Object.entries(expected).map(
        ([key, value]) =>
          JSON.stringify(observed[key]) === JSON.stringify(value),
      );
      const passed = checks.every(Boolean);
      fieldCount += checks.length;
      fieldPass += checks.filter(Boolean).length;
      schemaPass += Number(structureValid);
      report.measured++;
      report.passed += Number(passed);
      if (expected.recommended === false && recommended)
        report.dangerousFalseRecommendations++;
      if (fixture.group === "article-positive" && jobs.length)
        report.positiveSamples++;
      report.extractedJobs += jobs.length;
      // No raw response, profile, prompt or body enters the report.
      report.results.push({
        id: fixture.id,
        promptId: fixture.promptId,
        promptVersion: definition.promptVersion,
        schemaVersion: definition.schemaVersion,
        passed,
        structureValid,
        jobCount: jobs.length,
        validCount,
        failedFields: Object.keys(expected).filter((_, i) => !checks[i]),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error.code === "model_budget_exhausted") {
        report.status = "incomplete";
        break;
      }
      report.measured++;
      fieldCount += Object.keys(expected).length;
      report.results.push({
        id: fixture.id,
        passed: false,
        code: ["model_pricing_unsupported", "article_model_invalid"].includes(
          error.code,
        )
          ? error.code
          : "golden_call_failed",
      });
    }
  }
  if (mode === "live") {
    report.schemaSuccessRate = report.measured
      ? schemaPass / report.measured
      : null;
    report.criticalFieldAccuracy = fieldCount ? fieldPass / fieldCount : null;
    report.usage = budget.snapshot();
    report.modelQuality =
      report.status === "complete" &&
      report.measured === 24 &&
      report.schemaSuccessRate === 1 &&
      report.criticalFieldAccuracy >= 0.95 &&
      report.dangerousFalseRecommendations === 0 &&
      report.positiveSamples >= 4
        ? "verified"
        : "not_verified";
    if (report.status === "complete" && report.modelQuality !== "verified")
      report.status = "failed";
  }
  return report;
}
export async function captureLegacyBaseline(dataset, { ref = "3547885" } = {}) {
  if (!/^[a-f0-9]{7,40}$/.test(ref)) throw Error("Fixed git commit required");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rjr-v1-eval-"));
  try {
    const files = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", ref, "src"],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/);
    for (const file of files) {
      const dest = path.join(dir, file);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, execFileSync("git", ["show", ref + ":" + file]));
    }
    const datasetFile = path.join(dir, "dataset.json");
    await fs.writeFile(datasetFile, JSON.stringify(dataset));
    const code =
      "import fs from 'node:fs';import {preScore} from './src/match/score.mjs';const d=JSON.parse(fs.readFileSync('./dataset.json'));console.log(JSON.stringify(d.scenarios.map(s=>({profileId:s.profileId,ranked:d.jobs.map(j=>({jobId:j.jobId,score:preScore({...j,education:j.degree,city:j.cities.join(' ')},{...s.profile,degree:s.profile.education,preferredCities:s.profile.cities,keywords:s.profile.skills,targetRoles:s.target.roles,skills:s.profile.skills.map(name=>({name,level:'熟练'}))}).preScore,qualification:{status:'unknown'}})).map(r=>({...r,recommendation:r.score>=75?'high':'consider'})).sort((a,b)=>b.score-a.score)}))));";
    const guard = path.resolve("tests/helpers/network-guard.mjs");
    const rows = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(guard).href,
          "--input-type=module",
          "-e",
          code,
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, RJR_DATA_DIR: dir },
        },
      ),
    );
    return {
      ref,
      mode: "legacy-pure-rules",
      network: "blocked",
      scenarios: rows.map((r) => ({
        ...r,
        metrics: computeRankingMetrics(
          dataset.scenarios.find((s) => s.profileId === r.profileId).labels,
          r.ranked,
        ),
      })),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
export async function captureLiveModel(dataset) {
  const { loadConfig } = await import("../src/config.mjs"),
    { DeepSeek } = await import("../src/llm/deepseek.mjs"),
    { createEvaluationService } = await import(
      "../src/application/evaluation-service.mjs"
    ),
    { openWorkspaceRepository } = await import(
      "../src/infrastructure/storage/repository.mjs"
    ),
    { createWorkspaceService } = await import(
      "../src/application/workspace-service.mjs"
    ),
    { createJobService } = await import("../src/application/job-service.mjs"),
    { PROMPT_VERSION } = await import("../src/llm/prompts.mjs");
  const cfg = loadConfig();
  if (!cfg.deepseek.apiKey)
    throw Error(
      "Live model evaluation requires an explicitly configured model key",
    );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rjr-live-eval-"));
  try {
    const repository = await openWorkspaceRepository({ dataDir: dir }),
      workspace = createWorkspaceService({ repository }),
      jobs = createJobService({ repository }),
      evaluation = createEvaluationService({
        repository,
        modelFactory: (options) => new DeepSeek(cfg, options),
      });
    const ingested = await jobs.ingestRecords({
        runId: "synthetic-live",
        records: dataset.jobs,
      }),
      original = new Map(
        ingested.jobIds.map((id, i) => [id, dataset.jobs[i].jobId]),
      );
    const scenarios = [];
    for (const scenario of dataset.scenarios) {
      const p = await workspace.saveProfile({ profile: scenario.profile }),
        t = await workspace.saveTarget({
          ...scenario.target,
          profileRevisionId: p.revisionId,
          versionName: "合成评测 · " + p.revisionId,
          submissionId: "eval-" + p.profileId,
        });
      const result = await evaluation.evaluate({
        jobIds: ingested.jobIds,
        profileRevisionId: p.revisionId,
        targetRevisionId: t.revisionId,
        mode: "ai",
      });
      const ranked = result.evaluations
        .map((e) => ({ ...e, jobId: original.get(e.jobId) }))
        .sort((a, b) => b.score - a.score);
      scenarios.push({
        profileId: scenario.profileId,
        ranked,
        usage: result.usage,
        issues: result.issues,
        metrics: computeRankingMetrics(scenario.labels, ranked),
      });
    }
    return {
      mode: "live",
      model: cfg.deepseek.model,
      promptVersion: PROMPT_VERSION,
      sampleCount: dataset.jobs.length * dataset.scenarios.length,
      synthetic: true,
      limitations: dataset.limitations,
      scenarios,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
if (isMain) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? null : process.argv[i + 1];
  };
  const mode = arg("--mode") || "rules",
    dataset = loadDataset();
  let report;
  if (mode === "legacy") report = await captureLegacyBaseline(dataset);
  else if (mode === "live") report = await captureLiveModel(dataset);
  else if (mode === "rules") {
    const { evaluateRules, RULE_VERSION } = await import(
      "../src/domain/ranking.mjs"
    );
    report = {
      mode,
      ruleVersion: RULE_VERSION,
      sampleCount: dataset.jobs.length * dataset.scenarios.length,
      synthetic: true,
      labelMethod: dataset.labelMethod,
      limitations: dataset.limitations,
      scenarios: dataset.scenarios.map((s) => {
        const ranked = dataset.jobs
          .map((j) => ({
            jobId: j.jobId,
            ...evaluateRules(j, s.profile, s.target),
          }))
          .sort((a, b) => b.score - a.score);
        return {
          profileId: s.profileId,
          ranked,
          metrics: computeRankingMetrics(s.labels, ranked),
        };
      }),
    };
    if (process.argv.includes("--compare-legacy"))
      report.legacy = await captureLegacyBaseline(dataset);
  } else throw Error("Supported modes: rules, legacy, live.");
  const out = arg("--out");
  if (out) {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      {
        sampleCount: report.sampleCount || 30,
        mode,
        metrics: report.scenarios.map((s) => ({
          profileId: s.profileId,
          ...s.metrics,
        })),
      },
      null,
      2,
    ),
  );
}
