import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  setImmediate as nextTurn,
  setTimeout as delay,
} from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createWorkspaceOperationGate } from "../../src/application/workspace-operations.mjs";
import { createCollectionService } from "../../src/application/collection-service.mjs";
import { createCollectionLedger } from "../../src/application/collection-ledger.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createConditionalCache } from "../../src/infrastructure/http/conditional-cache.mjs";
import { createRunService } from "../../src/application/run-service.mjs";
import { collectionPartId } from "../../src/application/collection-row-access.mjs";
import { job } from "../helpers/fixtures.mjs";
import {
  createStorageDiagnostics,
  tagStorageError,
} from "../../src/infrastructure/storage/diagnostics.mjs";
import { writeTestEvidence } from "../helpers/evidence.mjs";

const artifacts = path.resolve(".cache/phase2-storage-observability/fixtures");
async function fixture(t, options = {}) {
  await fs.mkdir(artifacts, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(artifacts, "sqlite-"));
  const { diagnosticsFactory, ...repositoryOptions } = options;
  const diagnostics =
    options.diagnostics ||
    diagnosticsFactory?.(dataDir) ||
    createDiagnosticsLog({ dataDir });
  const repository = await openWorkspaceRepository({
    dataDir,
    ...repositoryOptions,
    diagnostics,
  });
  t.after(() => repository.close());
  return { dataDir, diagnostics, repository };
}
const selection = { select: [{ collection: "settings", ids: ["probe"] }] };
const save = (repository, value) =>
  repository.transaction(selection, (tx) => {
    tx.putRow({ collection: "settings", id: "probe", value });
    return "saved";
  });

test("completed managed result keeps the original target after current-target changes and repository restart", async (t) => {
  const f = await fixture(t, { diagnostics() {} });
  const versions = createWorkspaceService({ repository: f.repository });
  const profile = await versions.saveProfile({
    text: "合成离线简历，本科工程专业学习，参与安全检查和工程项目实践，整理巡检记录，仅用于快照副本测试。",
    profile: { education: "本科" },
    versionName: "原始离线资料",
    submissionId: "snapshot-profile",
  });
  const target = await versions.saveTarget({
    profileRevisionId: profile.revisionId,
    versionName: "原始目标副本",
    submissionId: "snapshot-target",
    roles: ["消防"],
    cityMode: "selected",
    cities: ["北京"],
    jobTypes: ["campus"],
    sourceIds: ["synthetic"],
    siteIds: [],
    budgets: {},
  });
  const scope = {
    packageId: target.packageId,
    targetRevisionId: target.revisionId,
  };
  let pages = 0;
  const service = createCollectionService({
    repository: f.repository,
    operationGate: createWorkspaceOperationGate({ repository: f.repository }),
    ledger: createCollectionLedger({ repository: f.repository }),
    requestFactory: () => async () => {
      throw Error("Synthetic snapshot page performs no network request");
    },
    registry: createSourceRegistry([
      createPagedProvider({
        id: "synthetic",
        name: "synthetic",
        capabilities: {},
        listPage: async () => {
          pages++;
          return { records: [job({ siteId: "site" })], hasMore: false };
        },
      }),
    ]),
    planner: async () => ({
      units: [
        {
          unitId: "unit",
          sourceId: "synthetic",
          siteId: "site",
          queryIndex: 0,
          site: { siteId: "site" },
          query: { keyword: "synthetic" },
        },
      ],
      hashes: {
        planHash: "p",
        catalogHash: "c",
        queryHash: "q",
        parserVersion: "fixture",
      },
    }),
  });
  t.after(() => service.stop());
  const started = await service.start({ scope });
  const ref = { scope, activityId: started.activityId };
  await service.wait(ref);
  const frozen = await f.repository.getRow(
    {
      collection: "runSnapshots",
      ownerPackageId: scope.packageId,
      id: collectionPartId(started.activityId, "targetSnapshot", "value"),
    },
    { scope },
  );
  const slice = await f.repository.getRow(
    { collection: "runs", id: started.runId, ownerPackageId: scope.packageId },
    { scope },
  );
  assert.equal(pages, 1);
  assert.equal(slice.status, "completed");
  assert.equal(Object.hasOwn(slice, "targetSnapshot"), false);
  assert.ok(slice.snapshotRef);
  const diskFile = path.join(f.dataDir, slice.snapshotRef.path);
  const disk = JSON.parse(await fs.readFile(diskFile, "utf8"));
  assert.deepEqual(disk.run.targetSnapshot, frozen);
  assert.deepEqual(disk.run.targetSnapshot.cities, ["北京"]);
  await f.repository.transaction(
    {
      select: [
        {
          collection: "targets",
          ids: [target.revisionId],
          ownerPackageId: scope.packageId,
        },
      ],
    },
    (tx) => {
      const current = tx.getRow({
        collection: "targets",
        id: target.revisionId,
      });
      current.cities = ["上海"];
      current.roles = ["修改后的当前角色"];
      tx.putRow({
        collection: "targets",
        id: target.revisionId,
        value: current,
      });
    },
    { scope },
  );
  await service.stop();
  await f.repository.close();
  const reopened = await openWorkspaceRepository({ dataDir: f.dataDir });
  t.after(() => reopened.close());
  const runs = createRunService({ repository: reopened });
  reopened.metrics({ reset: true });
  const result = await runs.waitForRun(started.runId, scope);
  assert.deepEqual(result.run.targetSnapshot, frozen);
  assert.equal(result.jobs.length, 1);
  assert.deepEqual(
    (
      await reopened.getRow(
        {
          collection: "targets",
          id: target.revisionId,
          ownerPackageId: scope.packageId,
        },
        { scope },
      )
    ).cities,
    ["上海"],
  );
  result.run.targetSnapshot.cities.push("修改调用者副本");
  assert.deepEqual(
    (await runs.waitForRun(started.runId, scope)).run.targetSnapshot,
    frozen,
  );
  assert.deepEqual((await runs.getRun(started.runId, scope)).targetSnapshot, {
    revisionId: target.revisionId,
  });
  assert.equal(reopened.metrics().maintenanceExports, 0);
  assert.equal(reopened.metrics().maintenanceReads, 0);
  await reopened.close();
  const cli = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.resolve("tests/helpers/network-guard.mjs")).href,
      "src/cli.mjs",
      "runs",
      "show",
      started.runId,
      "--target",
      target.revisionId,
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        RJR_DATA_DIR: f.dataDir,
        RJR_DISABLE_LOCAL_CREDENTIALS: "1",
        DEEPSEEK_API_KEY: "",
        TAVILY_API_KEY: "",
        BOCHA_API_KEY: "",
        SERPER_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  cli.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  cli.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  const head = JSON.parse(stdout);
  assert.deepEqual(head.targetSnapshot, { revisionId: target.revisionId });
  await writeTestEvidence(
    "storage-observability", "completed-snapshot-restart.json",
    JSON.stringify(
      {
        pages,
        managedTarget: disk.run.targetSnapshot,
        reopenedTarget: frozen,
        currentCities: ["上海"],
        resultJobs: result.jobs.length,
        cliExit: code,
        cliTargetHeader: head.targetSnapshot,
        sqlHeadHasTargetBody: Object.hasOwn(slice, "targetSnapshot"),
      },
      null,
      2,
    ),
  );
});

test("rollback keeps the original error and observer rejection cannot repeat or commit the callback", async (t) => {
  const entries = [];
  const f = await fixture(t, {
    diagnostics(event) {
      entries.push(event);
      throw Error("synthetic observer unavailable");
    },
  });
  await save(f.repository, { value: "before" });
  await nextTurn();
  entries.length = 0;
  const primary = Object.assign(Error("synthetic private callback"), {
    code: "synthetic_callback_failure",
  });
  let callbacks = 0;
  await assert.rejects(
    f.repository.transaction(selection, (tx) => {
      callbacks++;
      tx.putRow({
        collection: "settings",
        id: "probe",
        value: { value: "after" },
      });
      throw primary;
    }),
    (error) => error === primary,
  );
  await nextTurn();
  assert.equal(callbacks, 1);
  assert.deepEqual(
    await f.repository.getRow({ collection: "settings", id: "probe" }),
    { value: "before" },
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, "failed");
  assert.equal(entries[0].code, "synthetic_callback_failure");
  assert.equal(entries[0].sqlTransactions, 1);
  assert.equal(entries[0].sqlCommits, 0);
  assert.equal(entries[0].sqlRollbacks, 1);
  assert.equal(entries[0].committed, false);
});

test("post-commit diagnostics preserve the durable boundary, error number and redaction across restart", async (t) => {
  let armed = false,
    callbacks = 0;
  const secret = "PRIVATE_STORAGE_SENTINEL";
  const f = await fixture(t, {
    faultInjector(stage) {
      if (armed && stage === "sqlite.afterCommit") {
        armed = false;
        throw Object.assign(Error("SELECT secret FROM private " + secret), {
          code: "ERR_SQLITE_ERROR",
          errcode: 13,
        });
      }
    },
  });
  armed = true;
  await assert.rejects(
    f.repository.transaction(selection, (tx) => {
      callbacks++;
      tx.putRow({
        collection: "settings",
        id: "probe",
        value: { text: secret, sql: "SELECT private" },
      });
    }),
    (error) =>
      error.code === "sqlite_post_commit" &&
      error.committed === true &&
      error.cause.errcode === 13 &&
      error.runFatal === true,
  );
  assert.equal(callbacks, 1);
  assert.equal(
    (await f.repository.getRow({ collection: "settings", id: "probe" })).text,
    secret,
  );
  await nextTurn();
  await f.diagnostics.list();
  const reopened = createDiagnosticsLog({ dataDir: f.dataDir });
  const result = await reopened.list();
  const event = result.entries.find(
    (entry) => entry.operation === "storage.transaction",
  );
  assert.equal(event.outcome, "partial");
  assert.equal(event.code, "sqlite_post_commit");
  assert.equal(event.errorNumber, 13);
  assert.equal(event.committed, true);
  assert.equal(event.sqlTransactions, 1);
  assert.equal(event.sqlCommits, 1);
  assert.equal(event.sqlRollbacks, 0);
  const exported = await reopened.exportText();
  assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes("SELECT private"), false);
  assert.equal(exported.includes(f.dataDir), false);
});

test("real SQLite busy retains errcode 5 without claiming a transaction or repeating business work", async (t) => {
  const entries = [];
  const f = await fixture(t, {
    busyTimeoutMs: 20,
    diagnostics: (event) => entries.push(event),
  });
  const blocker = new DatabaseSync(path.join(f.dataDir, "workspace.sqlite"));
  t.after(() => blocker.close());
  blocker.exec("BEGIN IMMEDIATE");
  let callbacks = 0;
  try {
    await assert.rejects(
      f.repository.transaction(selection, () => {
        callbacks++;
      }),
      (error) =>
        error.code === "sqlite_busy" &&
        error.cause.errcode === 5 &&
        error.runFatal === true,
    );
  } finally {
    blocker.exec("ROLLBACK");
  }
  await nextTurn();
  assert.equal(callbacks, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].code, "sqlite_busy");
  assert.equal(entries[0].errorNumber, 5);
  assert.equal(entries[0].sqlTransactions, 0);
  assert.equal(entries[0].sqlCommits, 0);
  assert.equal(entries[0].committed, false);
  assert.ok(entries[0].storeMs >= 15);
  assert.equal(Object.hasOwn(entries[0], "timeoutMs"), false);
});

test("fence aggregation excludes unrelated WAL reads and measures actual queue and lock wait", async (t) => {
  const entries = [];
  const f = await fixture(t, { diagnostics: (event) => entries.push(event) });
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const before = f.repository.metrics();
  const first = f.repository.withWriteFence(async (fence) => {
    fence.transaction(selection, (tx) =>
      tx.putRow({ collection: "settings", id: "probe", value: { value: 1 } }),
    );
    entered();
    await gate;
    return fence.transaction(selection, (tx) =>
      tx.putRow({ collection: "settings", id: "probe", value: { value: 2 } }),
    );
  });
  await ready;
  const second = save(f.repository, { value: 3 });
  for (let i = 0; i < 40; i++) await f.repository.getMeta("revision");
  await delay(30);
  release();
  await Promise.all([first, second]);
  const after = f.repository.metrics();
  await nextTurn();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sqlTransactions, 2);
  assert.equal(entries[0].sqlCommits, 2);
  assert.equal(entries[1].sqlTransactions, 1);
  assert.ok(entries[0].lockMs >= 25);
  assert.ok(entries[1].queueMs >= 25);
  assert.ok(
    after.statements -
      before.statements -
      entries.reduce((sum, event) => sum + event.statements, 0) >=
      40,
  );
  assert.ok(
    after.rowsRead -
      before.rowsRead -
      entries.reduce((sum, event) => sum + event.readRows, 0) >=
      40,
  );
  assert.equal(
    entries.some((entry) => Object.hasOwn(entry, "sqlMs")),
    false,
  );
});

test("a slow real file logger starts outside the workspace lock and cannot hold up the next commit", async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let appendCalls = 0,
    lockPresent;
  const f = await fixture(t, {
    diagnosticsFactory: (dataDir) =>
      createDiagnosticsLog({
        dataDir,
        fsAdapter: {
          ...fs,
          async appendFile(...args) {
            appendCalls++;
            lockPresent = fsSync.existsSync(
              path.join(dataDir, ".workspace.lock"),
            );
            entered();
            await gate;
            return fs.appendFile(...args);
          },
        },
      }),
  });
  t.after(() => release());
  await save(f.repository, { value: 1 });
  await ready;
  const started = performance.now();
  const result = await save(f.repository, { value: 2 });
  const commitMs = performance.now() - started;
  assert.equal(result.result, "saved");
  assert.equal(lockPresent, false);
  assert.equal(appendCalls, 1);
  assert.ok(commitMs < 250, `commit waited ${commitMs}ms for an observer`);
  release();
  await nextTurn();
  const log = await f.diagnostics.list();
  assert.equal(
    log.entries.filter((entry) => entry.operation === "storage.transaction")
      .length,
    2,
  );
});

test("helper ignores failing metric observers and keeps only fixed recovered control resources", async () => {
  const entries = [];
  const helper = createStorageDiagnostics({
    diagnostics: (event) => entries.push(event),
    metrics() {
      throw Error("synthetic metrics unavailable");
    },
  });
  const observation = helper.startFence();
  observation.acquired();
  const original = Error("synthetic unchanged");
  assert.equal(
    observation.measure(() => 7),
    7,
  );
  assert.throws(
    () =>
      observation.measure(() => {
        throw original;
      }),
    (error) => error === original,
  );
  helper.onControlRenameRecovery({
    resource: "C:/private/state.json",
    retryCount: 1,
    retryDelayMs: 25,
    code: "EPERM",
  });
  helper.onControlRenameRecovery({
    resource: "control/state.json",
    retryCount: 1,
    retryDelayMs: 25,
    code: "EPERM",
    secret: "PRIVATE",
  });
  helper.onControlRenameRecovery({
    resource: "control/state.json",
    retryCount: 2,
    retryDelayMs: 75,
    code: "EPERM",
  });
  observation.finish(original);
  observation.finish();
  assert.equal(entries.length, 0);
  await nextTurn();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].operation, "storage.recovered");
  assert.equal(entries[0].retryCount, 2);
  assert.equal(entries[0].retryDelayMs, 100);
  assert.equal(entries[0].recoveredWrites, 2);
  assert.equal(JSON.stringify(entries).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(entries).includes("C:/private"), false);
  const full = Object.assign(Error("synthetic"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 13,
  });
  assert.equal(tagStorageError(full), full);
  assert.equal(full.runFatal, true);
  const remote = Object.assign(Error("synthetic"), { code: "ECONNRESET" });
  assert.equal(tagStorageError(remote), remote);
  assert.equal(Object.hasOwn(remote, "runFatal"), false);
});

test("ordinary SQLite writes publish real storage transaction diagnostics", async (t) => {
  const f = await fixture(t);
  let actions = 0;
  const result = await f.repository.transaction(selection, (tx) => {
    actions++;
    tx.putRow({ collection: "settings", id: "probe", value: { saved: true } });
    return "saved";
  });
  await nextTurn();
  const entries = (await f.diagnostics.list()).entries.filter(
    (entry) => entry.operation === "storage.transaction",
  );
  assert.equal(actions, 1);
  assert.equal(result.result, "saved");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resource, "workspace.sqlite");
  assert.equal(entries[0].outcome, "success");
  assert.equal(entries[0].sqlTransactions, 1);
  assert.equal(entries[0].sqlCommits, 1);
  assert.equal(entries[0].sqlRollbacks, 0);
  assert.equal(entries[0].committed, true);
  assert.ok(entries[0].statements > 0);
  assert.ok(entries[0].writeRows > 0);
  assert.ok(entries[0].writeBytes > 0);
});

for (const [point, kind] of [
  ...["reserve", "settle"].flatMap((point) =>
    ["busy", "full", "post_commit"].map((kind) => [point, kind]),
  ),
  ["cache_read", "native_read"],
]) {
  test(`ledger storage failure ${point}/${kind} pauses activity without blaming source health`, async (t) => {
    let armed = false,
      injections = 0,
      transports = 0,
      requests = 0,
      providerPageCalls = 0,
      reservationAttempts = 0,
      dnsCalls = 0;
    let failure = Object.assign(Error("synthetic private SQL error"), {
      code: "ERR_SQLITE_ERROR",
      errcode: kind === "busy" ? 5 : 13,
    });
    if (kind === "native_read") {
      // Obtain an unchanged native error in an isolated in-memory database;
      // inject it at the existing fixed read fault boundary, never damage data.
      const memory = new DatabaseSync(":memory:");
      try {
        memory.prepare("SELECT * FROM synthetic_missing_table").get();
      } catch (error) {
        failure = error;
      } finally {
        memory.close();
      }
      assert.equal(failure.code, "ERR_SQLITE_ERROR");
      assert.equal(failure.errcode, 1);
    }
    let readError;
    const diagnostics = [];
    const f = await fixture(t, {
      diagnostics: (event, error) => {
        diagnostics.push({ ...event, error });
      },
      faultInjector(stage) {
        if (
          armed &&
          stage ===
            "sqlite." +
              (kind === "post_commit"
                ? "afterCommit"
                : kind === "native_read"
                  ? "beforeRead"
                  : "beforeCommit")
        ) {
          armed = false;
          injections++;
          throw failure;
        }
      },
    });
    const versions = createWorkspaceService({ repository: f.repository });
    const profile = await versions.saveProfile({
      text: "合成离线简历，本科工程专业学习，参与安全检查和工程项目实践，整理巡检记录，仅用于本地存储诊断测试。",
      profile: { education: "本科" },
      versionName: "离线诊断简历",
      submissionId: "storage-profile",
    });
    const target = await versions.saveTarget({
      profileRevisionId: profile.revisionId,
      versionName: "离线诊断目标",
      submissionId: "storage-target",
      roles: ["消防"],
      cityMode: "any",
      cities: [],
      jobTypes: ["campus"],
      sourceIds: ["synthetic"],
      siteIds: [],
      budgets: {},
    });
    const scope = {
      packageId: target.packageId,
      targetRevisionId: target.revisionId,
    };
    const ledger = createCollectionLedger({ repository: f.repository });
    const provider = createPagedProvider({
      id: "synthetic",
      name: "synthetic",
      capabilities: {},
      listPage: async (_site, _query, _page, ctx) => {
        providerPageCalls++;
        if (point === "cache_read") {
          armed = true;
          try {
            await createConditionalCache({ repository: f.repository }).get({
              scope,
              resourceKey: "https://jobs.example.org/synthetic-cached-page",
            });
          } catch (error) {
            readError = error;
            throw error;
          }
        }
        await ctx.request("https://jobs.example.org/list");
        return { records: [], hasMore: false };
      },
    });
    const service = createCollectionService({
      repository: f.repository,
      ledger,
      operationGate: createWorkspaceOperationGate({
        repository: f.repository,
      }),
      registry: createSourceRegistry([provider]),
      planner: async () => ({
        units: [
          {
            unitId: "unit",
            sourceId: "synthetic",
            siteId: "site",
            queryIndex: 0,
            site: { siteId: "site" },
            query: { keyword: "synthetic" },
          },
        ],
        hashes: {
          planHash: "p",
          catalogHash: "c",
          queryHash: "q",
          parserVersion: "fixture",
        },
      }),
      requestFactory: ({ budget, signal }) => {
        const request = createRequestClient({
          signal,
          scheduler: { run: (_origin, action) => action() },
          dnsLookup: async () => {
            dnsCalls++;
            return [{ address: "93.184.216.34", family: 4 }];
          },
          budget: {
            ...budget,
            claimRequest: async (...args) => {
              reservationAttempts++;
              if (point === "reserve") armed = true;
              return budget.claimRequest(...args);
            },
            settleRequest: async (...args) => {
              if (point === "settle") armed = true;
              return budget.settleRequest(...args);
            },
          },
          transport: async () => {
            transports++;
            return { status: 200, headers: {}, text: "{}" };
          },
        });
        return (...args) => {
          requests++;
          return request(...args);
        };
      },
    });
    t.after(() => service.stop());
    const started = await service.start({ scope });
    const ref = { scope, activityId: started.activityId };
    await service.wait(ref);
    await nextTurn();
    const health = await f.repository.getRow({
      collection: "sourceHealth",
      id: "synthetic/site",
    });
    const root = await service.get(ref);
    const usage = await ledger.snapshot(ref);
    await writeTestEvidence(
      "storage-observability", `classification-${point}-${kind}.json`,
      JSON.stringify(
        {
          injections,
          providerPageCalls,
          requestClientCalls: requests,
          reservationAttempts,
          transportCalls: transports,
          syntheticDnsCalls: dnsCalls,
          offlineTransportHook: true,
          health,
          status: root.collectionProgress.status,
          lastErrorCode: root.collectionProgress.lastErrorCode,
          usedRequests: usage.usedRequests,
          knownPhysicalRequests: usage.knownPhysicalRequests,
          unknownRequestUpperBound: usage.unknownRequestUpperBound,
          originalRunFatal: failure.runFatal === true,
          originalErrorCode: failure.code,
          originalErrorNumber: failure.errcode,
          sameReadError:
            point === "cache_read" ? readError === failure : undefined,
          storageErrors: diagnostics
            .filter(
              (entry) =>
                entry.operation === "storage.transaction" &&
                entry.outcome !== "success",
            )
            .map(({ error, ...entry }) => entry),
        },
        null,
        2,
      ),
    );
    assert.equal(injections, 1);
    assert.equal(providerPageCalls, 1);
    assert.equal(requests, point === "cache_read" ? 0 : 1);
    assert.equal(reservationAttempts, point === "cache_read" ? 0 : 1);
    assert.equal(dnsCalls, point === "cache_read" ? 0 : 1);
    assert.equal(transports, point === "settle" ? 1 : 0);
    assert.equal(health, null);
    assert.equal(root.collectionProgress.status, "paused");
    assert.equal(
      root.collectionProgress.lastErrorCode,
      kind === "busy"
        ? "sqlite_busy"
        : kind === "post_commit"
          ? "sqlite_post_commit"
          : "ERR_SQLITE_ERROR",
    );
    assert.equal(
      usage.usedRequests,
      point === "cache_read" || (point === "reserve" && kind !== "post_commit")
        ? 0
        : 1,
    );
    assert.equal(
      usage.knownPhysicalRequests,
      point === "settle" && kind === "post_commit" ? 1 : 0,
    );
    if (point === "cache_read") {
      assert.equal(readError, failure);
      assert.equal(readError.errcode, 1);
      assert.equal(readError.runFatal, true);
    }
  });
}
