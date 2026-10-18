import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createBackendSyntheticEnvironment as createEnvironment } from "./synthetic-environment.mjs";
const digest = (text) =>
  createHash("sha256")
    .update(text || "")
    .digest("hex");
const projection = (run) => ({
  runId: run.runId,
  ownerPackageId: run.ownerPackageId,
  status: run.status,
  collectionRole: run.collectionRole ?? null,
  collectionActivityId: run.collectionActivityId ?? null,
  mode: run.mode ?? null,
  collectionMode: run.collectionMode ?? null,
  targetSnapshot: { revisionId: run.targetSnapshot?.revisionId ?? null },
  ...(run.collectionProgress
    ? {
        collectionProgress: {
          status: run.collectionProgress.status,
          limits: {
            maxCostCny: run.collectionProgress.limits?.maxCostCny ?? null,
          },
        },
      }
    : {}),
});

export function createBackendSyntheticEnvironment({ dataDir }) {
  if (
    process.env.RJR_BACKEND_SELF_TEST !== "1" ||
    process.env.RJR_DISABLE_LOCAL_CREDENTIALS !== "1" ||
    !fs.existsSync(path.join(dataDir, ".rjr-self-test"))
  )
    throw Error("synthetic_backend_only");
  const environment = createEnvironment({ dataDir });
  return {
    ...environment,
    attach({ context, handlers }) {
      const { repository } = context,
        { controls, clock } = environment;
      let startGate = null,
        releaseStart = null,
        entered = false;
      const originalStart = context.runService.startRun.bind(
        context.runService,
      );
      context.runService.startRun = async (...args) => {
        if (startGate) {
          entered = true;
          await startGate;
        }
        return originalStart(...args);
      };
      const inspect = async () => {
        // Maintenance inspection stays in the isolated backend. Only counts,
        // states, run identities and a synthetic text hash leave this process.
        const w = await repository.exportWorkspace();
        const packages = Object.fromEntries(
          Object.entries(w.packages).map(([id, pkg]) => [
            id,
            { state: pkg.state, purgeAt: pkg.purgeAt ?? null },
          ]),
        );
        const counts = Object.fromEntries(
          Object.keys(w.packages).map((id) => [
            id,
            Object.fromEntries(
              ["jobs", "evaluations", "runs", "applications"].map(
                (collection) => [
                  collection,
                  Object.values(w[collection] || {})
                    .flat()
                    .filter((row) => row.ownerPackageId === id).length,
                ],
              ),
            ),
          ]),
        );
        const copies = Object.fromEntries(
          Object.values(w.targets)
            .flat()
            .map((target) => [
              target.ownerPackageId,
              {
                ownerPackageId: target.profileSnapshot?.ownerPackageId ?? null,
                textHash: digest(target.profileSnapshot?.text),
              },
            ]),
        );
        return {
          packages,
          counts,
          copies,
          runs: Object.fromEntries(
            Object.entries(w.runs).map(([id, run]) => [id, projection(run)]),
          ),
        };
      };
      Object.assign(handlers, {
        "synthetic.inspect": inspect,
        "synthetic.clock": () => ({ now: clock.now() }),
        "synthetic.advance": ({ ms }) => {
          clock.advance(ms);
          return { now: clock.now() };
        },
        "synthetic.controls": async ({
          hold,
          failCleanup,
          failCleanupPackageId,
        }) => {
          if (hold !== undefined) controls.hold = hold;
          if (failCleanup !== undefined) controls.failCleanup = failCleanup;
          if (failCleanupPackageId) {
            const state = await inspect();
            controls.failCleanupRunIds = new Set(
              Object.values(state.runs)
                .filter((run) => run.ownerPackageId === failCleanupPackageId)
                .map((run) => run.runId),
            );
          }
          return { hold: controls.hold, failCleanup: controls.failCleanup };
        },
        "synthetic.startGate": ({ action }) => {
          if (action === "hold") {
            entered = false;
            startGate = new Promise((resolve) => {
              releaseStart = resolve;
            });
          }
          if (action === "release") {
            releaseStart?.();
            releaseStart = null;
            startGate = null;
          }
          return { entered };
        },
        "synthetic.duplicate": async ({ scope }) => {
          await repository.mutateWorkspace(
            (w) => {
              const original = Object.values(w.jobs).find(
                  (job) => job.ownerPackageId === scope.packageId,
                ),
                clone = structuredClone(original);
              if (!original) throw Error("synthetic_job_missing");
              clone.jobId += "-synthetic-duplicate";
              clone.recordId = randomUUID();
              w.jobs[clone.jobId] = clone;
              const observation = structuredClone(
                Object.values(w.observations).find(
                  (row) => row.jobId === original.jobId,
                ),
              );
              observation.jobId = clone.jobId;
              observation.recordId = randomUUID();
              observation.observationId += "-synthetic-duplicate";
              w.observations[observation.observationId] = observation;
              w.targetMembers[scope.targetRevisionId][clone.jobId] = {
                ...structuredClone(
                  w.targetMembers[scope.targetRevisionId][original.jobId],
                ),
                factRefs: [{ observationId: observation.observationId }],
                currentObservationId: observation.observationId,
              };
            },
            { scope },
          );
          return { prepared: true };
        },
        "synthetic.score": async ({ scope, evaluationId }) => {
          const syntheticId = randomUUID();
          await repository.mutateWorkspace(
            (w) => {
              const original = w.evaluations[evaluationId];
              if (!original || original.ownerPackageId !== scope.packageId)
                throw Error("synthetic_evaluation_missing");
              w.evaluations[syntheticId] = {
                ...structuredClone(original),
                evaluationId: syntheticId,
                recordId: randomUUID(),
                score: 100,
                createdAt: new Date(clock.now() + 60000).toISOString(),
              };
            },
            { scope },
          );
          return { evaluationId: syntheticId };
        },
        "synthetic.removeScore": async ({ scope, evaluationId }) => {
          await repository.mutateWorkspace(
            (w) => {
              if (
                w.evaluations[evaluationId]?.ownerPackageId !== scope.packageId
              )
                throw Error("synthetic_evaluation_missing");
              delete w.evaluations[evaluationId];
            },
            { scope },
          );
          return { removed: true };
        },
        "synthetic.profile": async ({ scenario }) => {
          const inputs = {
            "preview-conflict": [
              "合成冲突预览简历",
              "self-test-preview-conflict",
              "合成预览冲突简历正文，本科消防工程专业，2027届，具有合成消防课程项目与机场应急管理经历。",
            ],
            "preview-revision": [
              "合成预览后新增简历",
              "self-test-preview-revision",
              "合成修改修订简历正文，本科消防工程专业，2027届，具有课程项目和机场应急管理的合成经历。",
            ],
            "ui-expiry": [
              "合成界面到期简历",
              "self-test-ui-expiry",
              "合成到期正文仅用于自测的关闭核验；本科消防工程专业，2027届，机场消防和应急管理合成课程经历。",
            ],
            expiry: [
              "合成到期简历",
              "self-test-expiry",
              "合成到期简历正文，消防工程专业，本科学历，合成课程与项目经历。",
            ],
          };
          const [versionName, submissionId, text] = inputs[scenario];
          const saved = await context.workspaceService.saveProfile({
            versionName,
            submissionId,
            text,
            profile: {
              major: "消防工程",
              education: "本科",
              graduationYear: 2027,
            },
          });
          return { packageId: saved.packageId, versionName: saved.versionName };
        },
        "synthetic.archive": async ({ packageId }) => {
          await context.trashService.archive({ packageId });
          return { archived: true };
        },
        "synthetic.sweep": async () => {
          await context.trashScheduler.sweep();
          return { completed: true };
        },
        "synthetic.activity": async ({ ref }) => {
          const run = await context.collectionService.get(ref);
          return { ...projection(run), collectionUsage: run.collectionUsage };
        },
        "synthetic.bossContracts": async ({ targets }) =>
          (await import("../self-test-boss.mjs")).runBossSelfTest({
            context,
            targets,
            dataDir,
          }),
      });
    },
  };
}
