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
import { createJobVerificationService } from "./job-verification-service.mjs";
import { createJobCleanupService } from "./job-cleanup-service.mjs";
import { createEvaluationService } from "./evaluation-service.mjs";
import { createSourceService } from "./source-service.mjs";
import { projectSourceHealth } from "./source-health-projection.mjs";
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
import { createAnonymousWorker } from "../infrastructure/collection/worker-client.mjs";
import { createEgressProxy } from "../infrastructure/collection/egress-proxy.mjs";
import { verifyCollectionRuntime } from "../infrastructure/collection/runtime.mjs";
import { createContentReadService } from "./content-read-service.mjs";
import { assertCollectionWrite } from "../domain/collection.mjs";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { createResourceShutdown } from "../infrastructure/lifecycle/resource-shutdown.mjs";
import { createCollectionRuntimeManager } from './collection-runtime-manager.mjs';
import { rowKey } from '../infrastructure/storage/sqlite-records.mjs';
import { recoverPendingStorageMaintenance } from '../infrastructure/storage/restore-maintenance.mjs';
import { createModelCredentialBinding, matchesModelCredentialBinding } from './model-credential-binding.mjs';
export async function createApplicationContext({
  cfg,
  dataDir = process.env.RJR_DATA_DIR || DATA_ROOT,
  dependencies = {},
}) {
  const startupResources=[];
  try {
  const diagnostics =
    dependencies.diagnostics ||
    createDiagnosticsLog({ dataDir, clock: dependencies.clock });
  const tick = () => dependencies.clock?.now?.() ?? Date.now();
  const startupStage = stage => dependencies.onStartupStage?.({stage});
  startupStage('storage-opening');
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
          allowLegacy: dependencies.legacySchema === true,
          fsAdapter: dependencies.fsAdapter,
          faultInjector: dependencies.storageFaultInjector,
          onStartupStage: dependencies.onStartupStage,
        }),
      () => ({ stage: "startup", runtime: defaultRuntime() }),
    ));
  if(!dependencies.repository)startupResources.push(()=>repository.close());
  startupResources.push(()=>dependencies.stopOwnedResources?.());
  if(dependencies.legacySchema!==true)await recoverPendingStorageMaintenance({repository,fsAdapter:dependencies.fsAdapter});
  const migration = await trace(
    "application.migration",
    () =>
      dependencies.legacySchema === true
        ? migrateV1({
            dataDir: repository.dataDir,
            repository,
          })
        : repository.migration || bootstrapWorkspace({ repository, fsAdapter: dependencies.fsAdapter }),
    (result) => ({ issueCount: result.issues?.length || 0 }),
  );
  const operationGate = createWorkspaceOperationGate({ repository });
  startupStage('storage-recovering');
  const readSettings = async () => {
    if(dependencies.legacySchema===true)return (await repository.read()).settings;
    const page=await repository.queryRows({collection:'settings',limit:200});
    if(page.hasMore)throw packageError('settings_limit_exceeded','设置记录超过安全读取上限。',503);
    return Object.fromEntries(page.rows.map(row=>[row.id,row.value]));
  };
  const storedSettings=await readSettings();
  cfg.deepseek||={};
  let credentialCandidate=typeof cfg.deepseek.apiKey==='string'?cfg.deepseek.apiKey:'';
  let credentialBinding=storedSettings.apiKeyBinding;
  let credentialStatus='not_configured';
  const publishModelSettings=(settings,candidate=credentialCandidate)=>{
    for(const key of ['baseUrl','model'])if(typeof settings.model?.[key]==='string')cfg.deepseek[key]=settings.model[key];
    credentialBinding=settings.apiKeyBinding;
    credentialCandidate=candidate;
    if(dependencies.legacySchema===true){cfg.deepseek.apiKey=candidate;credentialStatus=candidate?'configured':'not_configured';return;}
    const verified=matchesModelCredentialBinding(candidate,cfg.deepseek,credentialBinding);
    cfg.deepseek.apiKey=verified?candidate:'';
    credentialStatus=verified?'configured':candidate||credentialBinding?.configured?'needs_configuration':'not_configured';
  };
  publishModelSettings(storedSettings);
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
  if(dependencies.legacySchema!==true&&!storedSettings.model?.baseUrl&&!storedSettings.model?.model){
    const model=Object.fromEntries(['baseUrl','model'].filter(key=>typeof cfg.deepseek[key]==='string').map(key=>[key,cfg.deepseek[key]]));
    if(Object.keys(model).length)await repository.transaction({select:[{collection:'settings',ids:['model']}]},tx=>{
      const latest=tx.getRow({collection:'settings',id:'model'})||{};
      tx.putRow({collection:'settings',id:'model',value:{...model,...latest}});
    });
  }
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
  startupResources.push(()=>ocr.close?.());
  await attachmentCleanup.resumePending();
  await dependencies.recoverOwnedResources?.();
  const collectionRuntime = createCollectionRuntimeManager({runtime:dependencies.collectionRuntime,
    root:dependencies.collectionRuntimeRoot,verify:dependencies.verifyCollectionRuntime||verifyCollectionRuntime,onStage:dependencies.onStartupStage});
  const rawAnonymousWorker =
    dependencies.anonymousWorker ||
    createAnonymousWorker({
      runtime: collectionRuntime,
      ledger: createCollectionLedger({ repository }),
      egressProxy: createEgressProxy(),
      cleanup: attachmentCleanup,
      tempRoot: attachmentLayout.attachmentTemp,
      clock: repository.clock,
      diagnostics,
    });
  const anonymousWorker=dependencies.anonymousWorker||Object.freeze({...rawAnonymousWorker,
    async read(input){await collectionRuntime.ensureReady();return rawAnonymousWorker.read(input);}});
  startupResources.push(()=>anonymousWorker.stop());
  const cleanupPackage = async (id) => {
    await anonymousWorker.closePackage(id);
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
  startupResources.push(()=>trashScheduler.stop());
  if (dependencies.legacySchema !== true) {
    await trace("application.recovery", async () => {
      const archived=await trashService.resumePending();
      if(archived.pending.length)throw packageError('archive_cleanup_pending','版本归档仍待安全清理，业务访问已停止。',503);
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
          loadSiteCatalog({ customSites: w.settings?.customSites })
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
  const createModel=dependencies.modelFactory||((options)=>new DeepSeek({...cfg,deepseek:options.modelConfig},{...options,diagnostics}));
  const modelFactory=(options={})=>{
    const modelConfig={...(options.modelConfig||cfg.deepseek)};
    if(dependencies.legacySchema===true&&options.credentials?.userApiKey)modelConfig.apiKey=options.credentials.userApiKey;
    if(dependencies.legacySchema!==true){
      // Recheck even an externally mutated cfg or an IPC-supplied candidate.
      // Per-run userApiKey remains an explicit independent session credential.
      const candidate=options.credentials?.userApiKey||modelConfig.apiKey||'';
      const verified=Boolean(options.credentials?.userApiKey)||matchesModelCredentialBinding(candidate,modelConfig,credentialBinding);
      modelConfig.apiKey=verified?candidate:'';
      if(!matchesModelCredentialBinding(cfg.deepseek.apiKey,cfg.deepseek,credentialBinding))cfg.deepseek.apiKey='';
    }
    return createModel({...options,modelConfig});
  };
  const evaluationService = createEvaluationService({
      repository,
      operationGate,
      modelFactory,
      budgetFactory: async ({ budgets } = {}) =>
        createConfiguredModelBudget({
          modelConfig: cfg.deepseek,
          budgets: budgets || (await readSettings()).budgets,
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
  const contentReadService =
    dependencies.contentReadService ||
    createContentReadService({
      anonymousWorker,
      browser: dependencies.collectionBrowser,
      clock: repository.clock,
      claimEnhancement: async ({ref,token,url,operationLease})=>{
        const id=rowKey(ref.activityId,'enhancement',contentHash(url));
        const receipt=await repository.transaction({select:[
          {collection:'runs',ownerPackageId:ref.scope.packageId,ids:[ref.activityId]},
          {collection:'sourceRotation',ownerPackageId:ref.scope.packageId,ids:[id]},
        ]},tx=>{
          const run=tx.getRow({collection:'runs',id:ref.activityId});
          const revisionId=tx.view.indexes.runs?.[ref.activityId]?.targetRevisionId;
          assertCollectionWrite({runs:{[ref.activityId]:{...run,targetSnapshot:{revisionId}}}},{ref,token});
          if(tx.getRow({collection:'sourceRotation',id}))return false;
          tx.putRow({collection:'sourceRotation',id,ownerPackageId:ref.scope.packageId,value:{ownerPackageId:ref.scope.packageId,runId:ref.activityId,kind:'enhancement',resourceKey:contentHash(url)}});
          return true;
        },{operationLease,scope:ref.scope});return receipt.result;
      },
    });
  if(!dependencies.contentReadService&&dependencies.collectionRuntimeRoot){
    const readContent=contentReadService.read.bind(contentReadService);
    contentReadService.read=async input=>{input.signal?.throwIfAborted();await collectionRuntime.ensureReady();return readContent(input);};
  }
  const collectionService =
    dependencies.legacySchema === true
      ? null
      : createCollectionService({
          repository,
          operationGate,
          registry,
          requestFactory,
          readService: contentReadService,
          jobService,
          officialSites: dependencies.catalog || loadSiteCatalog(),
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
          ensureCollectionRuntime: () => collectionRuntime.ensureReady(),
          diagnostics,
          runGate: gate,
          planner:
            dependencies.collectionPlanner ||
            (async (input) => {
              const {settings={},sourceHealth={},packageSettings={}}=input;
              return buildCollectionPlan({
                ...input,
                catalog:
                  dependencies.catalog ||
                  loadSiteCatalog({ customSites: settings.customSites }),
                health: {
                  ...sourceHealth,
                  ...packageSettings.sourceVerification,
                },
                sourceOverrides: {
                  ...settings.sourceOverrides,
                  ...packageSettings.sourceOverrides,
                },
              });
            }),
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
  startupResources.push(()=>collectionRefresh?.stop());
  const sourceService = createSourceService({
      catalog: dependencies.catalog,
      diagnostics,
      repository,
      registry,
      requestFactory,
      operationGate,
      activityContext: collectionService
        ? // OAuth capabilities use controlled references only, never browser cookies.
          (ref, callback) =>
            collectionService.withActivityContext(ref, callback)
        : undefined,
      officialCredentials: dependencies.officialCredentials,
      officialRunnerFactory: dependencies.officialRunnerFactory,
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
  let settingsRollbackFailure;
  const shutdown = createResourceShutdown({
    resources: () => [
      {
        id: "collection",
        stop: async () => {
          const outcomes = await Promise.allSettled([
            collectionRefresh?.stop(),
            collectionService?.stop(),
          ]);
          const failures = outcomes
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
          if (failures.length)
            throw new AggregateError(failures, "Collection shutdown failed");
        },
      },
      { id: "trash", stop: () => trashScheduler.stop() },
      { id: "settings", stop: () => settingsQueue },
      {
        id: "runs",
        stop: async () => {
          if ((await repository.getMeta('schemaVersion')) !== 3) return;
          const packages=await repository.queryRows({collection:'packages',where:{kind:'target',status:'active'},limit:200});
          if(packages.hasMore)throw packageError('workspace_operation_busy','版本数量超过本轮安全停止上限。',503);
          const outcomes = await Promise.allSettled(
            packages.rows.map(({value:p}) => runService.cancelPackageAndWait(p.packageId)),
          );
          const failures = outcomes
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
          if (failures.length)
            throw new AggregateError(failures, "Run shutdown failed");
        },
      },
      { id: "attachments", stop: () => attachmentCleanup.resumePending() },
      { id: "ocr", stop: () => ocr.close?.() },
      { id: "worker", stop: () => anonymousWorker.stop() },
      { id: "owned", stop: () => dependencies.stopOwnedResources?.() },
      { id: 'repository', stop: () => repository.close?.() },
    ],
    onError: (shutdownResource, error) =>
      recordDiagnostic(
        diagnostics,
        {
          operation: "application.shutdown",
          phase: "finished",
          shutdownResource,
          outcome: "failed",
          code: "shutdown_resource_failed",
        },
        error,
      ),
  });
  const context = {
    trashService,
    purgeService,
    assignmentService,
    trashScheduler,
    close: () => shutdown.close(),
    jobCleanupService: createJobCleanupService({ repository, operationGate }),
    operationGate,
    diagnostics,
    cfg,
    repository,
    workspaceService,
    jobService,
    evaluationService,
    eventHub,
    jobVerificationService: createJobVerificationService({
      repository,
      registry,
      activityContext: collectionService
        ? (ref, callback) =>
            collectionService.withDiagnosticContext(
              { ref, requestId: "job-verification-" + randomUUID() },
              callback,
            )
        : undefined,
    }),
    runService,
    collectionService,
    contentReadService,
    collectionRefresh,
    attachmentCleanup,
    anonymousWorker,
    collectionRuntime,
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
      const settings=await readSettings();
      let target;
      if(scope){
        await repository.getMeta('revision',{scope});
        target=await repository.getRow({collection:'targets',id:scope.targetRevisionId,ownerPackageId:scope.packageId},{scope});
      }
      return createConfiguredModelBudget({
        modelConfig: cfg.deepseek,
        budgets: effectiveModelBudgets(
          settings.budgets,
          target?.budgets,
        ),
      });
    },
    async getCatalog(scope) {
      const settings=await readSettings();
      let health;
      if(dependencies.legacySchema===true)health=projectSourceHealth(await repository.read(),{registry,scope});
      else{
        const page=await repository.queryRows({collection:'sourceHealth',limit:200});
        if(page.hasMore)throw packageError('source_health_limit','来源状态超过安全读取上限。',503);
        const pkg=scope?await repository.getRow({collection:'packages',id:scope.packageId},{scope}):null;
        health=projectSourceHealth({sourceHealth:Object.fromEntries(page.rows.map(row=>[row.id,row.value])),
          packages:pkg?{[pkg.packageId]:pkg}:{},runs:{},observations:{}},{registry,scope});
      }
      return (
        dependencies.catalog ||
        loadSiteCatalog({ customSites: settings.customSites })
      ).map((site) => ({
        ...site,
        health: health[site.providerId + "/" + site.siteId] || null,
      }));
    },
    async commitModelCredential(key) {
      if(typeof key!=='string')throw packageError('invalid_model_credential','模型凭据格式无效。',400);
      const settings=await context.saveSettings({model:{apiKey:key}});
      return {configured:settings.model.configured,credentialStatus:settings.model.credentialStatus};
    },
    async setModelCredentialCandidate(key) {
      if(typeof key!=='string')throw packageError('invalid_model_credential','模型凭据格式无效。',400);
      publishModelSettings(await readSettings(),key);
      return {configured:credentialStatus==='configured',credentialStatus};
    },
    async getSettings() {
      const settings=await readSettings();
      publishModelSettings(settings);
      return {
        ...redactBusiness(settings),
        model: {
          ...redactBusiness(settings.model),
          baseUrl: cfg.deepseek.baseUrl,
          model: cfg.deepseek.model,
          configured: credentialStatus==='configured',
          credentialStatus,
          ...(credentialStatus==='needs_configuration'?{credentialMessage:'本地模型凭据与当前配置尚未核对，请重新填写密钥并保存；规则分析仍可使用。'}:{}),
        },
        searchConfigured: !!cfg.__activeSearchProvider,
      };
    },
    async saveSettings(input) {
      const result = settingsQueue.then(() =>
        trace("application.settings", async () => {
          if (settingsRollbackFailure) throw settingsRollbackFailure;
          const current = {settings:await readSettings()},
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
          const previousApiKey=credentialCandidate;
          const keyChanged=Object.hasOwn(changes,'apiKey');
          const candidate=keyChanged?changes.apiKey:credentialCandidate;
          let credentialWritten=false, committedModel, committedBinding;
          try {
            if(keyChanged&&dependencies.saveModelCredential){
              await dependencies.saveModelCredential({apiKey:changes.apiKey});
              credentialWritten=true;
              await dependencies.settingsFaultInjector?.('settings.credential-written');
            }
            if(dependencies.legacySchema===true){
              await repository.mutateWorkspace(w=>{
                if(input.budgets)w.settings.budgets=effectiveBudgets;
                if(input.model)w.settings.model={...w.settings.model,...redactBusiness(model)};
              });
            }else{
              const receipt=await repository.transaction({select:[{collection:'settings',ids:['budgets','model','apiKeyBinding']}]},tx=>{
                const latestBudgets={...(tx.getRow({collection:'settings',id:'budgets'})||{}),...input.budgets};
                if(input.budgets?.maxCostCny===null){delete latestBudgets.maxCostCny;if(!Object.hasOwn(input.budgets,'maxModelRequests'))latestBudgets.maxModelRequests=Math.min(20,latestBudgets.maxModelRequests??20);}
                const latestModel={...(tx.getRow({collection:'settings',id:'model'})||{}),...redactBusiness(model)};
                if(latestBudgets.maxCostCny!=null)createConfiguredModelBudget({modelConfig:{...cfg.deepseek,...latestModel},budgets:latestBudgets});
                let binding=tx.getRow({collection:'settings',id:'apiKeyBinding'});
                // A budget-only patch never changes or clears a local credential.
                // Only explicit credential confirmation binds a key to the
                // endpoint/model. Public configuration changes fail closed.
                if(keyChanged){
                  binding=createModelCredentialBinding(candidate,latestModel);
                  tx.putRow({collection:'settings',id:'apiKeyBinding',value:binding});
                }
                if(input.budgets)tx.putRow({collection:'settings',id:'budgets',value:latestBudgets});
                if(input.model)tx.putRow({collection:'settings',id:'model',value:latestModel});
                return {model:latestModel,binding};
              });committedModel=receipt.result.model;committedBinding=receipt.result.binding;
            }
          }catch(error){
            if(error.committed){
              publishModelSettings(await readSettings(),candidate);
              throw error;
            }
            if(credentialWritten){
              try{await dependencies.saveModelCredential({apiKey:previousApiKey});}
              catch(rollbackError){
                await recordDiagnostic(diagnostics,{operation:'application.settings',phase:'rollback',outcome:'failed'},rollbackError);
                settingsRollbackFailure=packageError('settings_rollback_failed','设置保存失败，本地凭据未能恢复。请检查本地存储后重新启动。',503);
                throw settingsRollbackFailure;
              }
            }
            throw error;
          }
          if(dependencies.legacySchema===true)Object.assign(cfg.deepseek,changes);
          publishModelSettings({model:committedModel||cfg.deepseek,apiKeyBinding:committedBinding},candidate);
          return context.getSettings();
        }),
      );
      settingsQueue = result.catch(() => {});
      return result;
    },
    async backup() {
      return trace("application.backup", async () => {
        if ((await repository.getMeta('schemaVersion')) === 3) {
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
          const restored=await restoreBackup({
            repository,
            archivePath,
            trashService,
            purgeService,
            fsAdapter: dependencies.fsAdapter,
          });
          publishModelSettings(await readSettings());
          return restored;
        } catch (error) {
          credentialBinding=undefined;cfg.deepseek.apiKey='';credentialStatus='needs_configuration';
          if (
            error.code === "workspace_operation_busy" ||
            error.code === "invalid_operation_lease" ||
            error.code === "workspace_restore_pending"
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
  startupStage('business-ready');
  return context;
  }catch(error){
    for(const stop of startupResources.toReversed())try{await stop();}catch{}
    throw error;
  }
}
const defaults = new Map();
export function getDefaultApplicationContext(cfg) {
  const dataDir = path.resolve(process.env.RJR_DATA_DIR || DATA_ROOT);
  if (!defaults.has(dataDir))
    defaults.set(dataDir, createApplicationContext({ cfg, dataDir }));
  return defaults.get(dataDir);
}
