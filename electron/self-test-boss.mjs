import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createCollectionBrowser } from "./collection/browser.mjs";
import { createCollectionSessions } from "./collection/sessions.mjs";
import { createCollectionService } from "../src/application/collection-service.mjs";
import { createCollectionLedger } from "../src/application/collection-ledger.mjs";
import { createBossProvider } from "../src/sources/adapters/boss.mjs";
import { createSourceRegistry } from "../src/sources/registry.mjs";
import { buildBossOperation } from "../src/sources/boss/protocol.mjs";
import { assertScope } from "../src/domain/packages.mjs";

// Packaged diagnostics use the production protocol, ownership and ledger. Only
// Electron's external page and proxy are replaced; this module opens no socket.
function syntheticBossWindows() {
  const sessions = new Map(),
    windows = [],
    methods = new Set();
  const controls = {
    risk: false,
    hold: false,
    late: null,
    started: null,
    aborts: 0,
  };
  const session = {
    fromPartition(partition) {
      if (!sessions.has(partition)) {
        const ses = new EventEmitter();
        Object.assign(ses, {
          cookies: { get: async () => [], set: async () => {} },
          webRequest: {
            onBeforeRequest: (filter, cb) => {
              ses.before = filter === null ? null : cb;
            },
            onHeadersReceived: (filter, cb) => {
              ses.headers = filter === null ? null : cb;
            },
          },
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
          async setProxy() {},
          async closeAllConnections() {},
          async clearStorageData() {},
          async clearCache() {},
        });
        sessions.set(partition, ses);
      }
      return sessions.get(partition);
    },
  };
  let nextId = 0;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      const ses = session.fromPartition(options.webPreferences.partition);
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        id: ++nextId,
        session: ses,
        getURL: () => this.url,
        setWebRTCIPHandlingPolicy() {},
        setWindowOpenHandler() {},
        executeJavaScript: (code) => vm.runInContext(code, this.page),
      });
      const ajaxSettings = { beforeSend() {} };
      const ajax = (input) => {
        ajaxSettings.beforeSend();
        let aborted = false;
        Promise.resolve()
          .then(async () => {
            const query = new URLSearchParams(input.data).toString();
            const url =
              input.type === "GET" ? input.url + "?" + query : input.url;
            const decision = await new Promise((resolve) =>
              ses.before(
                {
                  url,
                  method: input.type,
                  resourceType: "xhr",
                  webContentsId: this.webContents.id,
                  ...(input.type === "POST"
                    ? { uploadData: [{ bytes: Buffer.from(query) }] }
                    : {}),
                },
                resolve,
              ),
            );
            if (decision.cancel) return input.error({ status: 403 }, "blocked");
            methods.add(input.type);
            const page =
              input.data.page || Number(input.data.securityId.split("-").pop());
            const payload = controls.risk
              ? { code: 36 }
              : {
                  code: 0,
                  zpData:
                    input.type === "POST"
                      ? {
                          jobList: [
                            {
                              encryptJobId: "offline-boss-" + page,
                              jobName: "合成消防工程师" + page,
                              brandName: "合成机场企业",
                              cityName: "北京",
                              jobDegree: "本科",
                              securityId: "synthetic-private-read-ref-" + page,
                              lid: "synthetic-private-lid",
                            },
                          ],
                          hasMore: page === 1,
                        }
                      : {
                          jobCard: {
                            encryptJobId: "offline-boss-" + page,
                            postDescription:
                              "合成岗位职责：消防设施维护、安全检查、机场应急保障。任职要求：本科消防工程相关专业，掌握消防设施管理与风险排查。此数据仅供离线验收，不是真实招聘。",
                          },
                        },
                };
            const finish = () =>
              input.success(payload, "success", { status: 200 });
            if (controls.hold && input.type === "POST") {
              controls.late = finish;
              controls.started?.();
            } else if (!aborted) finish();
          })
          .catch(() => input.error({ status: 0 }, "synthetic_failure"));
        return {
          abort() {
            aborted = true;
            controls.aborts++;
            input.error({ status: 0 }, "abort");
          },
        };
      };
      this.page = vm.createContext({ window: { $: { ajax, ajaxSettings } } });
      windows.push(this);
    }
    async loadURL(url) {
      this.url = url;
      const ses = this.webContents.session;
      const decision = await new Promise((resolve) =>
        ses.before(
          {
            url,
            method: "GET",
            resourceType: "mainFrame",
            webContentsId: this.webContents.id,
          },
          resolve,
        ),
      );
      if (decision.cancel) throw Error("synthetic_route_blocked");
      ses.headers?.(
        { statusCode: 200, resourceType: "mainFrame", responseHeaders: {} },
        () => {},
      );
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        this.emit("closed");
      }
    }
  }
  const egressProxy = {
    start: async () => ({ proxyUrl: "http://127.0.0.1:12345" }),
    createClient: () => ({
      username: "synthetic",
      password: "synthetic",
      grant() {},
      revoke() {},
      snapshot: () => ({ bytes: 0 }),
    }),
    stop: async () => {},
  };
  return { session, BrowserWindow, egressProxy, controls, windows, methods };
}

export async function runBossSelfTest({ context, targets, dataDir }) {
  if (
    path.resolve(dataDir) !== path.resolve(context.repository.dataDir) ||
    !(
      await fs.stat(path.join(dataDir, ".rjr-self-test")).catch(() => null)
    )?.isFile()
  )
    throw Error("unsafe_self_test_directory");
  const { repository, operationGate } = context;
  const clock = repository.clock,
    results = [],
    summary = {};
  const check = (name, ok) => {
    results.push({ name, ok: Boolean(ok) });
    if (!ok) throw Error(name);
  };
  const failureCode = async (fn) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e.code;
    }
  };
  const scopes = targets.map((t) => ({
    packageId: t.packageId,
    targetRevisionId: t.revisionId,
  }));
  const storeOptions = {
    dataDir: path.join(dataDir, "boss-contracts"),
    safeStorage: { isEncryptionAvailable: () => false },
    clock,
  };
  const sessionStore = createCollectionSessions(storeOptions),
    ledger = createCollectionLedger({ repository });
  const h = syntheticBossWindows();
  const browser = createCollectionBrowser({
    ...h,
    sessionStore,
    ledger,
    assertScope: async (scope) =>
      assertScope(await repository.read(), scope, clock.now()),
  });
  const site = {
    siteId: "self-test-boss",
    providerId: "boss",
    origin: "https://www.zhipin.com",
  };
  const service = createCollectionService({
    repository,
    operationGate,
    ledger,
    clock,
    registry: createSourceRegistry([createBossProvider()]),
    readService: browser,
    requestFactory: () => async () => {
      throw Error("offline_network_forbidden");
    },
    planner: async () => ({
      units: [
        {
          unitId: "boss-contract",
          sourceId: "boss",
          siteId: site.siteId,
          site,
          queryIndex: 0,
          query: { keyword: "消防", pageLimit: 2 },
        },
      ],
      limits: {
        maxRequests: 40,
        maxDetails: 4,
        maxPagesPerQuery: 2,
        maxSites: 1,
        maxQueryGroups: 1,
        maxAttachments: 0,
        maxAttachmentBytes: 20971520,
        maxTotalAttachmentBytes: 209715200,
        maxCostCny: 0,
      },
    }),
  });
  const bind = async (scope) => {
    const entry = await sessionStore.create({
      scope,
      platform: "boss",
      accountRef: "synthetic",
    });
    await repository.mutateWorkspace((w) => {
      const p = w.packages[scope.packageId];
      p.collectionSettings ||= {
        sourceOverrides: {},
        sessionRefs: {},
        refreshEnabled: false,
      };
      p.collectionSettings.sessionRefs.boss = entry.sessionRef;
    });
    return entry;
  };
  const start = async (scope) => {
    const root = await service.start({ scope, options: { mode: "rules" } });
    return { scope, activityId: root.activityId };
  };
  try {
    const entries = [await bind(scopes[0]), await bind(scopes[1])],
      roots = [];
    for (const scope of scopes) {
      const ref = await start(scope);
      roots.push(await service.wait(ref));
    }
    summary.pagesByVersion = roots.map(
      (r) => r.collectionProgress.units["boss-contract"].committedPages,
    );
    check(
      "Boss 两版本各自保存两页",
      summary.pagesByVersion.every((n) => n === 2),
    );
    const w = await repository.read();
    summary.jobsByVersion = scopes.map(
      (s) =>
        Object.values(w.jobs).filter(
          (j) =>
            j.ownerPackageId === s.packageId && j.canonical.sourceId === "boss",
        ).length,
    );
    check(
      "Boss 相同公开ID仍逐版本隔离",
      summary.jobsByVersion.every((n) => n === 2),
    );
    const bossFacts = Object.values(w.observations).filter(
      (o) =>
        scopes.some((s) => s.packageId === o.ownerPackageId) &&
        o.sourceId === "boss",
    );
    check(
      "Boss 详情正文在各版本保存",
      bossFacts.length === 4 &&
        bossFacts.every((o) => o.fields.description?.includes("合成岗位职责")),
    );
    check(
      "Boss 临时读取引用未落盘",
      !/synthetic-private-read-ref|synthetic-private-lid|securityId/.test(
        JSON.stringify(w),
      ),
    );
    summary.methods = [...h.methods].sort();
    check(
      "Boss 固定 POST 列表与 GET 详情实际执行",
      summary.methods.join() === "GET,POST",
    );
    check(
      "Boss 两版本使用不同沙箱分区",
      new Set(h.windows.map((win) => win.options.webPreferences.partition))
        .size === 2 &&
        h.windows.every(
          (win) =>
            win.options.webPreferences.sandbox &&
            !win.options.webPreferences.nodeIntegration &&
            !win.options.webPreferences.preload,
        ),
    );
    h.controls.risk = true;
    const riskRef = await start(scopes[0]);
    const riskRoot = await service.wait(riskRef);
    check(
      "Boss 风险将本版本单元停止",
      riskRoot.collectionProgress.units["boss-contract"].riskBlocked === true,
    );
    const restarted = createCollectionSessions(storeOptions);
    check(
      "Boss 风险停止在重启后保留",
      (
        await restarted.getStatus({
          scope: scopes[0],
          sessionRef: entries[0].sessionRef,
        })
      ).riskBlocked === true,
    );
    const before = await ledger.snapshot(riskRef);
    await service.withDiagnosticContext(
      { ref: riskRef, requestId: "offline-risk-scope" },
      async (ctx) => {
        const input = {
          ...ctx,
          ref: riskRef,
          sessionRef: entries[0].sessionRef,
          operation: buildBossOperation({ kind: "boss.search", query: "消防" }),
        };
        summary.riskCode = await failureCode(() => browser.readBoss(input));
        summary.crossScopeCode = await failureCode(() =>
          browser.readBoss({ ...input, ref: { ...riskRef, scope: scopes[1] } }),
        );
      },
    );
    check(
      "Boss 风险阻塞先于额度预约",
      summary.riskCode === "boss_risk_blocked" &&
        (await ledger.snapshot(riskRef)).usedRequests === before.usedRequests,
    );
    check(
      "Boss 会话不能用于另一目标版本",
      summary.crossScopeCode === "collection_session_scope",
    );
    check(
      "Boss 另一版本不继承风险",
      !(
        await sessionStore.getStatus({
          scope: scopes[1],
          sessionRef: entries[1].sessionRef,
        })
      ).riskBlocked,
    );
    await browser.clearSession({
      scope: scopes[0],
      sessionRef: entries[0].sessionRef,
    });
    summary.revokedCode = await failureCode(() =>
      sessionStore.get({ scope: scopes[0], sessionRef: entries[0].sessionRef }),
    );
    check(
      "Boss 清理后立即撤销旧会话",
      summary.revokedCode === "collection_session_scope",
    );
    await bind(scopes[0]);
    h.controls.risk = false;
    h.controls.hold = true;
    let held;
    const started = new Promise((resolve) => {
      h.controls.started = resolve;
    });
    const cancelRef = await start(scopes[0]);
    const timer = setTimeout(
      () => held?.(Error("synthetic_boss_hold_timeout")),
      10000,
    );
    try {
      await Promise.race([
        started,
        new Promise((_, reject) => {
          held = reject;
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await service.cancel(cancelRef);
    h.controls.late();
    const cancelled = await service.wait(cancelRef),
      after = await repository.read();
    summary.cancelledStatus = cancelled.collectionProgress.status;
    const cancelledSlices = new Set(
      Object.values(after.runs)
        .filter((r) => r.collectionActivityId === cancelRef.activityId)
        .map((r) => r.runId),
    );
    summary.cancelledJobCount = new Set(
      Object.values(after.observations)
        .filter((o) => cancelledSlices.has(o.runId))
        .map((o) => o.jobId),
    ).size;
    check(
      "Boss 取消后迟到响应没有提交页或岗位",
      summary.cancelledStatus === "cancelled" &&
        cancelled.collectionProgress.units["boss-contract"].committedPages ===
          0 &&
        summary.cancelledJobCount === 0 &&
        Object.values(after.jobs).filter(
          (j) =>
            j.ownerPackageId === scopes[0].packageId &&
            j.canonical.sourceId === "boss",
        ).length === 2,
    );
    check(
      "Boss 取消排空页面且不发送第二次",
      h.controls.aborts === 1 && h.windows.every((win) => win.isDestroyed()),
    );
    return {
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
      summary,
    };
  } finally {
    await service.stop();
    await browser.stop();
  }
}
