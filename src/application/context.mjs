import fs from "node:fs/promises";
import { resolveDataLayout } from "../infrastructure/storage/layout.mjs";
import { createAttachmentCleanup } from "../attachments/cleanup.mjs";
import { createAttachmentService } from "../attachments/service.mjs";
import { createLocalOcr } from "../attachments/ocr.mjs";
import { createDocConverter } from "../attachments/doc-converter.mjs";
import { createConditionalCache } from "../infrastructure/http/conditional-cache.mjs";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_ROOT } from "../config.mjs";
import { openWorkspaceRepository } from "../infrastructure/storage/repository.mjs";
import { migrateV1 } from "../infrastructure/storage/migrate-v1.mjs";
import { recoverWorkspace } from "../infrastructure/storage/recovery.mjs";
import { upgradeWorkspace } from "../infrastructure/storage/upgrade-workspace.mjs";
import { writeAtomicJson } from "../infrastructure/storage/atomic.mjs";
import {
  createBackup,
  restoreBackup,
  validateBackupArchive,
} from "../infrastructure/storage/backup.mjs";
import { createWorkspaceService } from "./workspace-service.mjs";
import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import { createJobService } from "./job-service.mjs";
import { createJobCleanupService } from "./job-cleanup-service.mjs";
import { createEvaluationService } from "./evaluation-service.mjs";
import { createSourceService } from "./source-service.mjs";
import { createImportService } from "./import-service.mjs";
import { createExportService } from "./export-service.mjs";
import { createRunService } from "./run-service.mjs";
import { createRunEventHub } from "./run-events.mjs";
import { createDefaultSourceRegistry } from "../sources/registry.mjs";
import { loadSiteCatalog } from "../sources/catalog.mjs";
import { createRequestClient } from "../infrastructure/http/client.mjs";
import { createSourceBudget } from "../infrastructure/http/budget.mjs";
import { DeepSeek } from "../llm/deepseek.mjs";
import {
  createConfiguredModelBudget,
  effectiveModelBudgets,
} from "../llm/budget.mjs";
import { RunGate } from "../limits.mjs";
import { redactBusiness } from "../domain/redact.mjs";
import {
  createDiagnosticsLog,
  recordDiagnostic,
} from "../infrastructure/diagnostics/log.mjs";
import { defaultRuntime } from "../infrastructure/diagnostics/fields.mjs";
import { bootstrapWorkspace } from "../infrastructure/storage/bootstrap-workspace.mjs";
import { createTrashService } from "./trash-service.mjs";
import { createPurgeService } from "./purge-service.mjs";
import { createTrashScheduler } from "./trash-scheduler.mjs";
import { createLegacyAssignmentService } from "./legacy-assignment-service.mjs";
import { packageError, assertScope } from "../domain/packages.mjs";
import { createCollectionService } from "./collection-service.mjs";
import { createCollectionRefresh } from "./collection-refresh.mjs";
import { createCollectionLedger } from "./collection-ledger.mjs";
import { buildCollectionPlan } from "../sources/planning.mjs";
export async function createApplicationContext({
  cfg,
  dataDir = process.env.RJR_DATA_DIR || DATA_ROOT,
  dependencies = {},
}) {
  const diagnostics =
    dependencies.diagnostics ||
    createDiagnosticsLog({ dataDir, clock: dependencies.clock });
  const tick = () => dependencies.clock?.now?.() ?? Date.now();
  async function trace(operation, action, summarize = () => ({})) {
    const started = tick();
    try {
      const result = await action();
      await recordDiagnostic(diagnostics, {
        operation,
        phase: "finished",
        outcome: "success",
        durationMs: Math.max(0, tick() - started),
        ...summarize(result),
      });
      return result;
    } catch (error) {
      const entry = await recordDiagnostic(
        diagnostics,
        {
          operation,
          outcome: "failed",
          durationMs: Math.max(0, tick() - started),
        },
        error,
      );
      if (entry) error.diagnosticId ||= entry.diagnosticId;
      throw error;
    }
  }
  const repository =
    dependencies.repository ||
    (await trace(
      "application.start",
      () =>
        openWorkspaceRepository({
          dataDir,
          clock: dependencies.clock,
          diagnostics,
          allowLegacy: true,
          fsAdapter: dependencies.fsAdapter,
        }),
      () => ({ stage: "startup", runtime: defaultRuntime() }),
    ));
  const migration = await trace(
    "application.migration",
    () =>
      dependencies.legacySchema === true
        ? migrateV1({
            dataDir: repository.dataDir,
            repository,
          })
        : bootstrapWorkspace({ repository, fsAdapter: dependencies.fsAdapter }),
    (result) => ({ issueCount: result.issues?.length || 0 }),
  );
  const operationGate = createWorkspaceOperationGate({ repository });
  const managementUpgrade = await trace(
    "application.migration",
    () =>
      dependencies.legacySchema === true
        ? upgradeWorkspace({ repository, operationGate })
        : Promise.resolve({ changed: false }),
    (result) => ({ issueCount: result.changed ? 1 : 0 }),
  );
  const recovery = await trace(
    "application.recovery",
    () => recoverWorkspace(repository, { operationGate }),
    (result) => ({
      counts: {
        interrupted: result.interruptedRunIds.length,
        orphan: result.orphanSnapshots.length,
        issues: result.issues.length,
      },
    }),
  );
  const registry = dependencies.registry || createDefaultSourceRegistry();
  if (dependencies.legacySchema !== true) repository.enableStrictSchema3?.();
  const attachmentLayout = resolveDataLayout(repository.dataDir),
    attachmentCleanup =
      dependencies.attachmentCleanup ||
      createAttachmentCleanup({
        tempRoot: attachmentLayout.attachmentTemp,
        manifestPath: attachmentLayout.attachmentManifest,
      }),
    ocr = dependencies.ocr || createLocalOcr(),
    docConverter =
      dependencies.docConverter ||
      createDocConverter({
        executable: dependencies.docConverterExecutable,
        cleanup: attachmentCleanup,
      });
  await attachmentCleanup.resumePending();
  await dependencies.recoverOwnedResources?.();
  const cleanupPackage = async (id) => {
    const resources = await dependencies.cleanupOwnedResources?.(id),
      attachments = await attachmentCleanup.cleanupPackage(id);
    return {
      status: [resources?.status, attachments.status].includes(
        "cleanup_pending",
      )
        ? "cleanup_pending"
        : "clean",
    };
  };
  let runServiceForTrash;
  const trashService = createTrashService({
      repository,
      cancelPackageAndWait: (id) => runServiceForTrash.cancelPackageAndWait(id),
      cleanupPackage,
    }),
    purgeService = createPurgeService({
      repository,
      trash: trashService,
      operationGate,
      fsAdapter: dependencies.fsAdapter,
      diagnostics,
      cleanupPackage,
    }),
    assignmentService = createLegacyAssignmentService({ repository }),
    trashScheduler = createTrashScheduler({
      trash: trashService,
      purge: purgeService,
      clock: repository.clock,
      timers: dependencies.timers,
      diagnostics,
    });
  trashService.setPurgeService(purgeService);
  if (dependencies.legacySchema !== true) {
    await trace("application.recovery", async () => {
      const assignments = await assignmentService.recoverPending();
      if (assignments.pending?.length)
        throw packageError(
          "ownership_transfer_pending",
          "历史归属与删除记录需要恢复检查，已停止业务访问。",
          503,
        );
      return assignments;
    });
    await purgeService.resumePending();
    await trashScheduler.sweep();
  }
  const workspaceService = createWorkspaceService({
      repository,
      operationGate,
      trashService,
      modelConfig: () => cfg.deepseek,
      sourceIds: () => [
        ...registry.list().map((p) => p.id),
        "legacy-no-sources",
      ],
      siteIds: (w) =>
        (
          dependencies.catalog ||
          loadSiteCatalog({ customSites: w.settings.customSites })
        ).map((s) => s.siteId),
    }),
    jobService = createJobService({ repository });
  const requestFactory =
    dependencies.requestFactory ||
    ((options) =>
      createRequestClient({
        ...options,
        diagnostics,
        dnsMode: cfg.network?.dnsMode || "auto",
      }));
  const modelFactory =
    dependencies.modelFactory ||
    ((options) =>
      new DeepSeek(
        {
          ...cfg,
          deepseek: {
            ...(options.modelConfig || cfg.deepseek),
            apiKey:
              options.credentials?.userApiKey ||
              options.modelConfig?.apiKey ||
              cfg.deepseek.apiKey,
          },
        },
        { ...options, diagnostics },
      ));
  const evaluationService = createEvaluationService({
      repository,
      operationGate,
      modelFactory,
      budgetFactory: async ({ budgets } = {}) =>
        createConfiguredModelBudget({
          modelConfig: cfg.deepseek,
          budgets: budgets || (await repository.read()).settings.budgets,
        }),
      diagnostics,
    }),
    eventHub = createRunEventHub({ repository });
  const gate =
    dependencies.runGate ||
    new RunGate({
      ...cfg.limits,
      storageFile: path.join(repository.dataDir, "quota.json"),
    });
  const runService = createRunService({
    operationGate,
    diagnostics,
    repository,
    workspaceService,
    jobService,
    evaluationService,
    registry,
    requestFactory,
    modelFactory,
    eventHub,
    runGate: gate,
    catalog: dependencies.catalog,
    config: cfg,
  });
  runServiceForTrash = runService;
  const collectionService =
    dependencies.legacySchema === true
      ? null
      : createCollectionService({
          repository,
          operationGate,
          registry,
          requestFactory,
          ledger: createCollectionLedger({ repository }),
          attachmentService: createAttachmentService({
            ledger: createCollectionLedger({ repository }),
            cleanup: attachmentCleanup,
            cache: createConditionalCache({ repository }),
            ocr,
            converter: docConverter,
            clock: repository.clock,
          }),
          events: eventHub,
          evaluationService,
          modelFactory,
          modelConfig: cfg.deepseek,
          diagnostics,
          runGate: gate,
          planner: async (input) => {
            const w = input.workspace;
            return buildCollectionPlan({
              ...input,
              catalog:
                dependencies.catalog ||
                loadSiteCatalog({ customSites: w.settings.customSites }),
              health: {
                ...w.sourceHealth,
                ...w.packages[input.scope.packageId].collectionSettings
                  ?.sourceVerification,
              },
              sourceOverrides: {
                ...w.settings.sourceOverrides,
                ...w.packages[input.scope.packageId].collectionSettings
                  ?.sourceOverrides,
              },
            });
          },
        });
  if (collectionService) {
    await collectionService.recover();
    runService.setCollectionService(collectionService);
  }
  const collectionRefresh = collectionService
    ? createCollectionRefresh({
        service: collectionService,
        repository,
        clock: repository.clock,
        timers: dependencies.timers || globalThis,
      })
    : null;
  collectionRefresh?.start();
  const sourceService = createSourceService({
      catalog: dependencies.catalog,
      diagnostics,
      repository,
      registry,
      requestFactory,
      operationGate,
      activityContext: collectionService
        ? (ref, callback) =>
            collectionService.withActivityContext(ref, callback)
        : undefined,
    }),
    importService = createImportService({
      repository,
      operationGate,
      jobService,
      request: (url, options) =>
        requestFactory({
          budget: createSourceBudget({ maxRequests: 6, maxDetails: 2 }),
          diagnosticContext: { endpointKind: "import" },
        })(url, options),
    }),
    exportService = createExportService({ repository });
  let settingsQueue = Promise.resolve();
  const context = {
    trashService,
    purgeService,
    assignmentService,
    trashScheduler,
    async close() {
      await collectionRefresh?.stop();
      await trashScheduler.stop();
      await settingsQueue;
      const w = await repository.read();
      if (w.schemaVersion === 3)
        for (const p of Object.values(w.packages).filter(
          (p) => p.state === "active" && p.kind === "target",
        ))
          await runService.cancelPackageAndWait(p.packageId);
      await attachmentCleanup.resumePending();
      await ocr.close?.();
      await dependencies.stopOwnedResources?.();
    },
    jobCleanupService: createJobCleanupService({ repository, operationGate }),
    operationGate,
    diagnostics,
    cfg,
    repository,
    workspaceService,
    jobService,
    evaluationService,
    eventHub,
    runService,
    collectionService,
    collectionRefresh,
    attachmentCleanup,
    sourceService,
    importService,
    exportService,
    registry,
    requestFactory,
    modelFactory,
    gate,
    migration,
    managementUpgrade,
    recovery,
    async createModelBudget(scope) {
      const workspace = await repository.read();
      if (scope) assertScope(workspace, scope, repository.clock.now());
      const target =
        scope &&
        Object.values(workspace.targets)
          .flat()
          .find((v) => v.revisionId === scope.targetRevisionId);
      return createConfiguredModelBudget({
        modelConfig: cfg.deepseek,
        budgets: effectiveModelBudgets(
          workspace.settings.budgets,
          target?.budgets,
        ),
      });
    },
    async getCatalog() {
      const w = await repository.read();
      return (
        dependencies.catalog ||
        loadSiteCatalog({ customSites: w.settings.customSites })
      ).map((site) => ({
        ...site,
        health: w.sourceHealth[site.providerId + "/" + site.siteId] || null,
      }));
    },
    async getSettings() {
      const w = await repository.read();
      return {
        ...redactBusiness(w.settings),
        model: {
          ...redactBusiness(w.settings.model),
          baseUrl: cfg.deepseek.baseUrl,
          model: cfg.deepseek.model,
          configured: !!cfg.deepseek.apiKey,
        },
        searchConfigured: !!cfg.__activeSearchProvider,
      };
    },
    async saveSettings(input) {
      const result = settingsQueue.then(() =>
        trace("application.settings", async () => {
          const current = await repository.read(),
            effectiveModel = { ...cfg.deepseek, ...input?.model },
            effectiveBudgets = {
              ...current.settings.budgets,
              ...input?.budgets,
            };
          if (input?.budgets?.maxCostCny === null) {
            delete effectiveBudgets.maxCostCny;
            if (!Object.hasOwn(input.budgets, "maxModelRequests"))
              effectiveBudgets.maxModelRequests = Math.min(
                20,
                effectiveBudgets.maxModelRequests ?? 20,
              );
          }
          assertInput("settings", input, {
            nativeTypes: true,
            model: effectiveModel,
            maxCostCny: effectiveBudgets.maxCostCny,
          });
          if (input.budgets) {
            const limits = {
              maxModelRequests: effectiveBudgets.maxCostCny != null ? 1000 : 20,
              maxCostCny: 10,
              maxRequests: 240,
              maxDetails: 20,
              maxSites: 24,
            };
            for (const [key, value] of Object.entries(input.budgets))
              if (key === "maxCostCny" && value === null) continue;
              else if (
                !(key in limits) ||
                (key === "maxCostCny"
                  ? typeof value !== "number" ||
                    !Number.isFinite(value) ||
                    !Number.isInteger(Math.round(value * 100)) ||
                    Math.abs(value * 100 - Math.round(value * 100)) > 1e-8
                  : !Number.isSafeInteger(value)) ||
                value < 0 ||
                value > limits[key]
              )
                throw Error("Invalid budget " + key);
          }
          if (effectiveBudgets.maxCostCny != null) {
            try {
              createConfiguredModelBudget({
                modelConfig: effectiveModel,
                budgets: effectiveBudgets,
              });
            } catch {
              throw inputError({
                "model.model":
                  "费用上限需使用已核对价格的 DeepSeek V4.1（deepseek-flash）和官方 API 地址。",
              });
            }
          }
          const model = input.model || {};
          if (model.baseUrl) {
            const url = new URL(model.baseUrl);
            if (
              !["http:", "https:"].includes(url.protocol) ||
              url.username ||
              url.password
            )
              throw Error("Invalid model endpoint");
          }
          const changes = {};
          for (const key of ["baseUrl", "model", "apiKey"])
            if (Object.hasOwn(model, key)) {
              if (typeof model[key] !== "string")
                throw Error("Invalid model setting");
              changes[key] = model[key];
            }
          if (Object.keys(changes).length) {
            const filename = path.join(repository.dataDir, "config.json");
            let file = {};
            try {
              file = JSON.parse(await fs.readFile(filename, "utf8"));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            file.deepseek = { ...(file.deepseek || {}), ...changes };
            await writeAtomicJson(filename, file);
            Object.assign(cfg.deepseek, changes);
          }
          await repository.mutateWorkspace((w) => {
            if (input.budgets) {
              w.settings.budgets = { ...w.settings.budgets, ...input.budgets };
              if (input.budgets.maxCostCny === null) {
                delete w.settings.budgets.maxCostCny;
                if (!Object.hasOwn(input.budgets, "maxModelRequests"))
                  w.settings.budgets.maxModelRequests = Math.min(
                    20,
                    w.settings.budgets.maxModelRequests ?? 20,
                  );
              }
            }
            if (input.model)
              w.settings.model = {
                ...w.settings.model,
                ...redactBusiness(model),
              };
          });
          return context.getSettings();
        }),
      );
      settingsQueue = result.catch(() => {});
      return result;
    },
    async backup() {
      return trace("application.backup", async () => {
        if ((await repository.read()).schemaVersion === 3) {
          await trashScheduler.sweep();
          if (
            (await trashService.preview({ expiredOnly: true })).candidates
              .length
          )
            throw inputError(
              { file: "到期版本正在等待安全清理，请稍后再备份。" },
              "当前不能备份。",
              409,
            );
        }
        const result = await createBackup({ repository });
        return JSON.parse(await fs.readFile(result.path, "utf8"));
      });
    },
    async restore(archive) {
      return trace("application.restore", async () => {
        try {
          validateBackupArchive(archive);
        } catch {
          throw inputError({
            file: "备份格式或完整性检查未通过，请选择软件导出的完整备份文件。",
          });
        }
        if (
          Object.values((await repository.read()).runs).some((r) =>
            ["queued", "running"].includes(r.status),
          )
        )
          throw inputError(
            { file: "有任务正在运行，请等任务结束后再恢复备份。" },
            "当前不能恢复备份。",
            409,
          );
        const archivePath = path.join(
          repository.dataDir,
          "backups",
          "workspace-restore-" + randomUUID() + ".json",
        );
        await writeAtomicJson(archivePath, archive);
        try {
          return await restoreBackup({
            repository,
            archivePath,
            trashService,
            purgeService,
            fsAdapter: dependencies.fsAdapter,
          });
        } catch (error) {
          if (
            error.code === "workspace_operation_busy" ||
            error.code === "invalid_operation_lease"
          )
            throw error;
          if (error.code && /ENOSPC|EACCES|EPERM|EROFS|EIO/.test(error.code))
            throw error;
          throw inputError({
            file: "备份格式或完整性检查未通过，请选择软件导出的完整备份文件。",
          });
        } finally {
          await fs.unlink(archivePath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      });
    },
  };
  if (
    dependencies.legacySchema !== true &&
    dependencies.startScheduler !== false
  )
    trashScheduler.start();
  return context;
}
const defaults = new Map();
export function getDefaultApplicationContext(cfg) {
  const dataDir = path.resolve(process.env.RJR_DATA_DIR || DATA_ROOT);
  if (!defaults.has(dataDir))
    defaults.set(dataDir, createApplicationContext({ cfg, dataDir }));
  return defaults.get(dataDir);
}
