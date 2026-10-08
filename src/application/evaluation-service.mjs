import { randomUUID } from "node:crypto";
import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { evaluateRules, RULE_VERSION } from "../domain/ranking.mjs";
import { createModelBudget } from "../llm/budget.mjs";
import {
  validateModelResults,
  evaluationCacheKey,
} from "../llm/validation.mjs";
import { evaluationPrompt, PROMPT_VERSION } from "../llm/prompts.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
import { resolveJobId, resolveJobIds } from "../domain/job-resolution.mjs";
import {
  backfillTargetMembers,
  selectVersionJobFact,
  selectRunJobFact,
  selectMatchingEvaluation,
  resolveEvaluationFactBasis,
} from "../domain/job-facts.mjs";
export function createEvaluationService({
  repository,
  cache = new Map(),
  modelFactory,
  budgetFactory,
  diagnostics,
  clock = repository.clock,
  operationGate = createWorkspaceOperationGate({ repository }),
}) {
  return {
    async evaluate({
      jobIds,
      profileRevisionId,
      targetRevisionId,
      mode = "rules",
      signal,
      runId = null,
      modelClient,
      diagnosticContext = {},
      operationLease: parentLease,
    }) {
      return operationGate.withOperation(
        "evaluate",
        { targetRevisionId, profileRevisionId, parentLease, signal },
        async (operationLease) => {
          const trace = { ...diagnosticContext, ...(runId ? { runId } : {}) },
            started = clock.now();
          signal?.throwIfAborted();
          const workspace = await repository.read();
          backfillTargetMembers(workspace);
          const p = Object.values(workspace.profiles)
              .flat()
              .find((p) => p.revisionId === profileRevisionId),
            target = Object.values(workspace.targets)
              .flat()
              .find((t) => t.revisionId === targetRevisionId);
          if (!p || !target) throw Error("Profile/target revision not found");
          if (target.profileRevisionId !== p.revisionId)
            throw Error("Target profile revision mismatch");
          if (!Array.isArray(jobIds) || jobIds.length > 5000)
            throw Error("Invalid job selection");
          const ids = resolveJobIds(workspace, jobIds);
          if (!["rules", "ai", "auto"].includes(mode))
            throw Error("Invalid evaluation mode");
          const newBudget =
            modelClient?.budget ||
            (await budgetFactory?.()) ||
            createModelBudget();
          const client =
              modelClient ||
              ((mode === "ai" || mode === "auto") && modelFactory
                ? modelFactory({
                    signal,
                    budget: newBudget,
                    diagnosticContext: trace,
                  })
                : null),
            budget = client?.budget || newBudget;
          const ai = mode === "ai" || (mode === "auto" && client?.available);
          const fingerprint = ai
            ? contentHash({
                endpoint: client?.baseUrl || "none",
                model: client?.model || "none",
                temperature: 0.2,
                maxOutputTokens: budget.snapshot().maxOutputTokens,
              })
            : "rules";
          const evaluations = [],
            issues = [];
          const pending = [];
          for (const id of ids) {
            const memberFact = selectVersionJobFact(workspace, {
              targetRevisionId,
              jobId: id,
            });
            const fact =
              runId && memberFact.status === "verified"
                ? selectRunJobFact(workspace, { runId, jobId: id })
                : memberFact;
            if (fact.status !== "verified")
              throw Object.assign(
                Error("该岗位不属于此目标版本，或缺少可验证的版本事实。"),
                { status: 409, code: "version_fact_unavailable" },
              );
            const record = { ...fact.record, jobId: id };
            const jdHash = contentHash({ ...record, retrievedAt: undefined });
            const cacheKey = evaluationCacheKey({
              jdHash: fact.factContentHash,
              profileRevisionId,
              targetRevisionId,
              promptVersion: PROMPT_VERSION,
              ruleVersion: RULE_VERSION,
              modelFingerprint: fingerprint,
            });
            const candidate =
              cache.get(cacheKey) ||
              Object.values(workspace.evaluations).find(
                (e) =>
                  e.cacheKey === cacheKey && ["rules", "ai"].includes(e.status),
              ) ||
              Object.values(workspace.evaluations).find(
                (e) =>
                  ["rules", "ai"].includes(e.status) &&
                  e.profileRevisionId === profileRevisionId &&
                  e.targetRevisionId === targetRevisionId &&
                  e.promptVersion === PROMPT_VERSION &&
                  e.ruleVersion === RULE_VERSION &&
                  e.modelFingerprint === fingerprint &&
                  e.cacheKey ===
                    evaluationCacheKey({
                      jdHash: e.jdHash,
                      profileRevisionId,
                      targetRevisionId,
                      promptVersion: PROMPT_VERSION,
                      ruleVersion: RULE_VERSION,
                      modelFingerprint: fingerprint,
                    }) &&
                  resolveEvaluationFactBasis(workspace, e).factContentHash ===
                    fact.factContentHash,
              );
            const existing =
              candidate &&
              resolveEvaluationFactBasis(workspace, candidate)
                .factContentHash === fact.factContentHash
                ? candidate
                : null;
            if (existing) {
              evaluations.push({ ...structuredClone(existing), jobId: id });
              continue;
            }
            pending.push({
              record,
              jdHash,
              cacheKey,
              fact,
              draft: evaluateRules(record, p.profile, target),
            });
          }
          const cachedCount = evaluations.length;
          let budgetFallbackCount = 0;
          await recordDiagnostic(diagnostics, {
            operation: "model.result",
            ...trace,
            mode,
            phase: "cache",
            outcome: cachedCount ? "cached" : "success",
            cacheHit: cachedCount > 0,
            counts: {
              input: ids.length,
              cached: cachedCount,
              accepted: pending.length,
            },
          });
          for (let offset = 0; offset < pending.length; offset += 5) {
            signal?.throwIfAborted();
            const batch = pending.slice(offset, offset + 5);
            let valid = new Map();
            if (ai && client?.available !== false && client) {
              const allowance = budget.snapshot();
              if (
                budgetFallbackCount ||
                budget.isExhausted?.() ||
                allowance.requests >= allowance.maxRequests
              )
                budgetFallbackCount += batch.length;
              else
                try {
                  let responseMetadata;
                  const records = batch.map((b) => ({
                      ...b.record,
                      description: String(b.record.description || "").slice(
                        0,
                        12000,
                      ),
                    })),
                    prompt = evaluationPrompt(p.profile, records);
                  const raw = await client.chatJson(
                    prompt.system,
                    prompt.user,
                    {
                      signal,
                      maxTokens: 4000,
                      diagnosticContext: trace,
                      onResponse: (metadata) => {
                        responseMetadata = metadata;
                      },
                    },
                  );
                  const parsed = validateModelResults(raw, { records });
                  valid = new Map(parsed.valid.map((r) => [r.jobId, r]));
                  const validation = await recordDiagnostic(diagnostics, {
                    operation: "model.validation",
                    ...trace,
                    ...(responseMetadata?.requestId
                      ? { requestId: responseMetadata.requestId }
                      : {}),
                    ...(responseMetadata?.parentRequestId
                      ? { parentRequestId: responseMetadata.parentRequestId }
                      : {}),
                    phase: "validation",
                    outcome:
                      parsed.issues.length || parsed.missingIds.length
                        ? "partial"
                        : "success",
                    counts: {
                      input: records.length,
                      valid: parsed.valid.length,
                      invalid: parsed.invalidIds.length,
                      missing: parsed.missingIds.length,
                    },
                    issueCount: parsed.issues.length + parsed.missingIds.length,
                    parser: {
                      format: "json",
                      version: PROMPT_VERSION,
                      expectedCount: records.length,
                      resultCount: parsed.valid.length,
                      validationCounts: parsed.validationCounts,
                    },
                  });
                  if (valid.size < batch.length)
                    await recordDiagnostic(diagnostics, {
                      operation: "model.fallback",
                      ...trace,
                      ...(responseMetadata?.requestId
                        ? { requestId: responseMetadata.requestId }
                        : {}),
                      phase: "validation",
                      outcome: "partial",
                      code: parsed.invalidIds.length
                        ? "invalid_model_result"
                        : "missing_model_result",
                      counts: {
                        fallback: batch.length - valid.size,
                        invalid: parsed.invalidIds.length,
                        missing: parsed.missingIds.length,
                      },
                      level: "warn",
                    });
                  issues.push(
                    ...parsed.issues.map((issue) => ({
                      ...issue,
                      ...(validation
                        ? { diagnosticId: validation.diagnosticId }
                        : {}),
                    })),
                    ...parsed.missingIds.map((jobId) => ({
                      code: "missing_model_result",
                      jobId,
                      ...(validation
                        ? { diagnosticId: validation.diagnosticId }
                        : {}),
                    })),
                  );
                } catch (error) {
                  if (signal?.aborted || error.name === "AbortError")
                    throw error;
                  if (error.code === "model_budget_exhausted")
                    budgetFallbackCount += batch.length;
                  else {
                    const entry = await recordDiagnostic(
                      diagnostics,
                      {
                        operation: "model.fallback",
                        ...trace,
                        phase: error.phase || "response",
                        outcome: "partial",
                        code: error.code || "model_unavailable",
                        counts: { fallback: batch.length },
                        requestId: error.requestId,
                      },
                      error,
                    );
                    issues.push({
                      code: error.code || "model_unavailable",
                      message: "模型调用未完成，保留规则评价。",
                      ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
                    });
                  }
                }
            } else if (ai) {
              const entry = await recordDiagnostic(diagnostics, {
                operation: "model.fallback",
                ...trace,
                phase: "validation",
                outcome: "skipped",
                code: "missing_model_key",
                counts: { fallback: batch.length },
                level: "warn",
              });
              issues.push({
                code: "missing_model_key",
                message: "未配置模型密钥，保留规则评价。",
                ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
              });
            }
            const completed = batch.map(
              ({ record, jdHash, cacheKey, draft, fact }) => {
                const model = valid.get(record.jobId);
                const evaluation = {
                  ...draft,
                  evaluationId: "ev-" + randomUUID(),
                  jobId: record.jobId,
                  profileRevisionId,
                  targetRevisionId,
                  jdHash,
                  factContentHash: fact.factContentHash,
                  observationId: fact.observationIds[0],
                  promptVersion: PROMPT_VERSION,
                  modelFingerprint: fingerprint,
                  cacheKey,
                  runId,
                  createdAt: new Date(clock.now()).toISOString(),
                  status: model ? "ai" : ai ? "rule_fallback" : "rules",
                };
                if (model) {
                  evaluation.modelAdvice = {
                    score: Math.round(model.score),
                    reasons: model.reasons,
                    gaps: model.gaps,
                    evidence: model.evidence,
                  };
                  evaluation.score =
                    draft.qualification.status === "fail"
                      ? Math.min(49, Math.round(model.score))
                      : Math.round(model.score);
                  evaluation.recommendation =
                    draft.qualification.status === "fail"
                      ? "not_recommended"
                      : draft.recommendation === "insufficient"
                        ? "insufficient"
                        : evaluation.score >= 75 &&
                            draft.qualification.status === "pass"
                          ? "high"
                          : evaluation.score >= 50
                            ? "consider"
                            : "low";
                }
                return evaluation;
              },
            );
            await repository.mutateWorkspace(
              (w) => {
                for (const e of completed) {
                  if (!resolveJobId(w, e.jobId, { allowMissing: true }))
                    throw Error("Job disappeared during evaluation");
                  w.evaluations[e.evaluationId] = e;
                }
              },
              { operationLease },
            );
            for (const e of completed) {
              evaluations.push(e);
              if (["rules", "ai"].includes(e.status))
                cache.set(e.cacheKey, structuredClone(e));
            }
          }
          if (budgetFallbackCount) {
            const entry = await recordDiagnostic(diagnostics, {
              operation: "model.fallback",
              ...trace,
              phase: "budget",
              outcome: "skipped",
              code: "model_budget_exhausted",
              counts: { fallback: budgetFallbackCount },
              usage: { model: budget.snapshot() },
              level: "warn",
            });
            issues.push({
              code: "model_budget_exhausted",
              message: "本次模型请求达到上限，其余岗位保留规则评价。",
              affectedCount: budgetFallbackCount,
              ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
            });
          }
          await recordDiagnostic(diagnostics, {
            operation: "model.result",
            ...trace,
            mode,
            phase: "finished",
            outcome: issues.length ? "partial" : "success",
            durationMs: Math.max(0, clock.now() - started),
            counts: {
              input: ids.length,
              accepted: evaluations.length,
              cached: cachedCount,
              aiSuccess: evaluations.filter(
                (evaluation) => evaluation.status === "ai",
              ).length,
              fallback: evaluations.filter(
                (evaluation) => evaluation.status === "rule_fallback",
              ).length,
            },
            issueCount: issues.length,
            usage: {
              model: {
                ...budget.snapshot(),
                promptTokens: client?.usage?.promptTokens || 0,
                completionTokens: client?.usage?.completionTokens || 0,
              },
            },
          });
          return {
            evaluations,
            usage: {
              ...budget.snapshot(),
              promptTokens: client?.usage?.promptTokens || 0,
              completionTokens: client?.usage?.completionTokens || 0,
            },
            issues,
          };
        },
      );
    },
    async rescore(input) {
      return operationGate.withOperation(
        "evaluate",
        {
          targetRevisionId: input.targetRevisionId,
          profileRevisionId: input.profileRevisionId,
          parentLease: input.operationLease,
          signal: input.signal,
        },
        async (operationLease) => {
          const before = await repository.read();
          backfillTargetMembers(before);
          const ids = new Set(resolveJobIds(before, input.jobIds || []));
          const previous = new Map();
          for (const jobId of ids) {
            const fact = selectVersionJobFact(before, {
              targetRevisionId: input.targetRevisionId,
              jobId,
            });
            previous.set(
              jobId,
              selectMatchingEvaluation(before, {
                jobId,
                targetRevisionId: input.targetRevisionId,
                profileRevisionId: input.profileRevisionId,
                factContentHash: fact.factContentHash,
              }),
            );
          }
          const result = await this.evaluate({
            ...input,
            runId: null,
            operationLease,
          });
          const summary = (e) =>
            e
              ? {
                  evaluationId: e.evaluationId,
                  score: e.score,
                  qualification: e.qualification?.status || "unknown",
                  profileRevisionId: e.profileRevisionId,
                  targetRevisionId: e.targetRevisionId,
                }
              : null;
          return {
            ...result,
            versions: {
              profileRevisionId: input.profileRevisionId,
              targetRevisionId: input.targetRevisionId,
            },
            comparison: result.evaluations.map((e) => ({
              jobId: e.jobId,
              before: summary(previous.get(e.jobId)),
              after: summary(e),
            })),
          };
        },
      );
    },
  };
}
