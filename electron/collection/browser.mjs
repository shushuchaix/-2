import { randomUUID } from "node:crypto";
import { parseBossResponse } from "../../src/sources/boss/protocol.mjs";
import { createBrowserWindowBudget } from "./window-budget.mjs";
import { createManualAdmission } from "./manual-admission.mjs";
import {
  bossPageScript,
  bossAbortScript,
  decodeBossPageResult,
  validateBossOperation,
} from "./boss-page.mjs";
import { recordDiagnostic } from "../../src/infrastructure/diagnostics/log.mjs";
import { createCollectionPublicResolver } from "./public-dns.mjs";
import {
  createBossLoginDiagnostics,
  classifyCollectionFailure,
  classifyBossBusinessResult,
} from "./boss-login-diagnostics.mjs";
import {
  publicCollectionUrl,
  platformPolicy,
  allowsRoute,
  createPagePolicy,
  attachNetworkPolicy,
  classifyBrowserBody,
} from "./network-policy.mjs";
import {
  cancellableSleep,
  sharedSocialScheduler,
} from "../../src/infrastructure/http/scheduler.mjs";
const failure = (code, message) => Object.assign(Error(message), { code });
export function createCollectionBrowser({
  BrowserWindow,
  session,
  ledger,
  egressProxy,
  sessionStore,
  offlineAllows,
  assertScope,
  rememberSession,
  diagnostics,
  dnsMode = "auto",
  publicResolverFactory = createCollectionPublicResolver,
} = {}) {
  const windows = new Map(),
    sessions = new Map(),
    busySessions = new Set(),
    generations = new Map(),
    prepares = new Map(),
    loginOpenings = new Map(),
    sessionPrepares = new Map(),
    sessionGenerations = new Map(),
    closingLoginScopes = new Set(),
    pendingReads = new Set(),
    nativeLifetimes = new Set();
  const scopeKey = (scope) =>
    JSON.stringify([scope.packageId, scope.targetRevisionId]);
  let reads = 0,
    stopping = false,
    backendRevoked = false,
    firstCleanupError;
  const riskRecovery = Symbol("owned-risk-recovery");
  async function assertBossRisk(input) {
    if (input[riskRecovery]) return;
    const status = await sessionStore.getStatus({
      scope: input.ref.scope,
      sessionRef: input.sessionRef,
    });
    if (status.riskBlocked)
      throw failure(
        "boss_risk_blocked",
        "当前版本Boss会话受限，请处理后明确解除并重新核验。",
      );
  }
  async function sessionFor(entry) {
    let stored = sessions.get(entry.sessionRef);
    if (!stored) {
      const ses = session.fromPartition(entry.partition, { cache: false });
      const material = await sessionStore.readMaterial({
        scope: {
          packageId: entry.packageId,
          targetRevisionId: entry.targetRevisionId,
        },
        sessionRef: entry.sessionRef,
      });
      for (const cookie of material.cookies) {
        const host = cookie.domain?.replace(/^\./, "");
        if (
          host &&
          (entry.platform === "boss"
            ? ["www.zhipin.com", "zhipin.com"].includes(host)
            : allowsRoute(
                "https://" + host + "/",
                platformPolicy(entry.platform),
                {
                  manual: true,
                },
              ))
        ) {
          const { hostOnly, session, ...saved } = cookie;
          await ses.cookies.set({
            ...saved,
            url: "https://" + host + (cookie.path || "/"),
          });
        }
      }
      stored = { ses, packageId: entry.packageId };
      sessions.set(entry.sessionRef, stored);
    }
    return stored.ses;
  }
  async function holdOwnedWindow(
    { window, ses, entry, scope, manualAllowance },
    code,
  ) {
    if (window.isDestroyed())
      throw failure("collection_cancelled", "采集窗口已关闭。");
    const id = window.webContents.id,
      lifetime = new AbortController();
    const policy = {
      authorize: async () => ({ cancel: true }),
      close() {},
      snapshot: () => ({ requests: 0, manual: true }),
    };
    const detach = attachNetworkPolicy(ses, "collection-page", policy);
    let closing;
    const onClosed = () => {
      item.dispose().catch(() => {});
    };
    const item = {
      id,
      window,
      ses,
      entry,
      scope,
      manualAllowance,
      lifetime,
      policy,
      manual: true,
      heldCode: code,
      client: { revoke() {}, snapshot: () => ({ bytes: 0 }) },
      dispose({ keepWindow = false } = {}) {
        if (closing) {
          if (!keepWindow && !window.isDestroyed()) window.destroy();
          return closing;
        }
        closing = Promise.resolve().then(async () => {
          lifetime.abort(failure("collection_cancelled", "采集窗口已关闭。"));
          let cleanupError;
          try {
            await ses.closeAllConnections();
            if (!keepWindow && !backendRevoked)
              await sessionStore.setState({
                scope,
                sessionRef: entry.sessionRef,
                state: "unverified",
              });
            if (!backendRevoked) {
              const cookies = await ses.cookies.get({});
              if (!backendRevoked)
                await sessionStore.saveMaterial({
                  scope,
                  sessionRef: entry.sessionRef,
                  cookies,
                });
            }
          } catch (error) {
            cleanupError = error;
          } finally {
            try {
              for (const cleanup of [
                detach,
                () => window.removeListener("closed", onClosed),
                () => {
                  if (!keepWindow && !window.isDestroyed()) window.destroy();
                },
              ]) {
                try {
                  cleanup();
                } catch (error) {
                  cleanupError ||= error;
                }
              }
            } finally {
              if (
                windows.get(id) === item &&
                (keepWindow || window.isDestroyed())
              )
                windows.delete(id);
            }
          }
          if (cleanupError) {
            firstCleanupError ||= cleanupError;
            throw cleanupError;
          }
        });
        return closing;
      },
    };
    windows.set(id, item);
    window.once("closed", onClosed);
    await recordDiagnostic(diagnostics, {
      operation: "collection.finish",
      sourceId: "boss",
      siteId: "boss",
      phase: "cleanup",
      outcome: "failed",
      code,
      counts: {
        manualRequests: manualAllowance.requests,
        manualBytes: manualAllowance.wireBytes + manualAllowance.dnsBytes,
      },
    });
    return item;
  }
  function prepare(input) {
    const packageId = input.ref.scope.packageId,
      generation = generations.get(packageId) || 0,
      sessionRef = input.entry?.sessionRef,
      sessionGeneration = sessionGenerations.get(sessionRef) || 0;
    const ensure = () => {
      if (
        stopping ||
        generation !== (generations.get(packageId) || 0) ||
        (sessionRef &&
          sessionGeneration !== (sessionGenerations.get(sessionRef) || 0))
      )
        throw failure("collection_cancelled", "采集窗口已关闭。");
      input.signal?.throwIfAborted();
    };
    const pending = prepareInternal({ ...input, ensure });
    if (!prepares.has(packageId)) prepares.set(packageId, new Set());
    prepares.get(packageId).add(pending);
    if (sessionRef) {
      if (!sessionPrepares.has(sessionRef))
        sessionPrepares.set(sessionRef, new Set());
      sessionPrepares.get(sessionRef).add(pending);
    }
    pending
      .finally(() => {
        prepares.get(packageId)?.delete(pending);
        sessionPrepares.get(sessionRef)?.delete(pending);
      })
      .catch(() => {});
    return pending;
  }
  async function prepareInternal({
    ref,
    token,
    routePolicy,
    operationLease,
    signal,
    manual = false,
    entry,
    ensure,
    accountingLedger = ledger,
    maxWireBytes = 20971520,
    existingWindow,
    manualAllowance = { requests: 0, dnsBytes: 0, wireBytes: 0, lastAt: 0 },
  }) {
    const partition = entry?.partition || "collection-" + randomUUID();
    const ses = entry
      ? await sessionFor(entry)
      : session.fromPartition(partition, { cache: false });
    ensure();
    if (
      manual &&
      existingWindow &&
      (manualAllowance.requests >= 60 ||
        manualAllowance.wireBytes >= 20971520 - 60 * 65536)
    )
      return holdOwnedWindow(
        {
          window: existingWindow,
          ses,
          entry,
          scope: ref.scope,
          manualAllowance,
        },
        "collection_login_budget_exhausted",
      );
    if (!existingWindow)
      await ses.clearStorageData({
        storages: ["serviceworkers", "cachestorage"],
      });
    ses.setPermissionRequestHandler((_, __, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const proxy = await egressProxy.start();
    const lifetime = new AbortController();
    nativeLifetimes.add(lifetime);
    const abortFromParent = () => lifetime.abort(signal.reason);
    signal?.addEventListener("abort", abortFromParent, { once: true });
    if (signal?.aborted) abortFromParent();
    const ownedSignal = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    let window, loginDiagnostics;
    const claimManualRequest = () => {
      ownedSignal.throwIfAborted();
      if (manualAllowance.requests >= 60) {
        loginDiagnostics?.denied(
          { webContentsId: window.webContents.id },
          "collection_login_budget_exhausted",
        );
        throw failure(
          "collection_login_budget_exhausted",
          "独立登录窗口已达到请求上限，请查看来源问题日志。",
        );
      }
      manualAllowance.requests++;
    };
    const manualLedger = {
      reserve: async (input) => {
        claimManualRequest();
        return input;
      },
      settle: async (input) => {
        manualAllowance.dnsBytes += input.verifiedUsage?.bytes || 0;
      },
    };
    const publicResolver = publicResolverFactory({
      ledger: manual ? manualLedger : accountingLedger,
      ref,
      token,
      operationLease,
      signal: ownedSignal,
      diagnostics,
      mode: dnsMode,
    });
    const client = egressProxy.createClient({
      hosts: routePolicy.hosts,
      // Native Boss QR status requests can wait 100 seconds without traffic.
      // Keep the connection handshake bounded independently in the proxy.
      idleTimeoutMs: manual && routePolicy.platform === "boss" ? 120000 : 45000,
      onLimitExceeded: () =>
        loginDiagnostics?.denied(
          { webContentsId: window.webContents.id },
          "collection_login_byte_limit",
        ),
      onTimeout: ({ phase, timeoutMs, durationMs }) =>
        recordDiagnostic(diagnostics, {
          operation: "network.request",
          sourceId: routePolicy.platform,
          siteId: routePolicy.platform,
          // An idle tunnel can outlive already completed HTTP requests.
          // Only request/connection errors should imply a failed request.
          phase: phase === "idle" ? "cleanup" : "transport",
          outcome: phase === "idle" ? "completed" : "failed",
          code:
            phase === "idle"
              ? "collection_idle_tunnel_closed"
              : "collection_browser_timeout",
          parser: { version: "egress-" + phase },
          timeoutMs,
          ...(Number.isSafeInteger(durationMs) && durationMs >= 0
            ? { durationMs }
            : {}),
          ...(phase === "idle" ? {} : { resultCategory: "timeout" }),
        }),
      // Each of the at most 60 manual DNS requests reserves 64 KiB. Keep
      // that allowance inside the existing 20 MiB window ceiling.
      maxBytes: manual
        ? Math.max(0, 20971520 - 60 * 65536 - manualAllowance.wireBytes)
        : maxWireBytes,
      signal: ownedSignal,
      resolvePublicUrl: publicResolver,
    });
    try {
      await ses.setProxy({
        mode: "fixed_servers",
        proxyRules: proxy.proxyUrl,
        proxyBypassRules: "<-loopback>",
      });
      await ses.closeAllConnections();
      ensure();
      await assertScope?.(ref.scope);
      ensure();
      if (existingWindow?.isDestroyed())
        throw failure("collection_cancelled", "采集窗口已关闭。");
      window =
        existingWindow ||
        new BrowserWindow({
          width: 1040,
          height: 800,
          show: manual,
          title: "招聘来源独立采集窗口",
          webPreferences: {
            partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            spellcheck: false,
            disableBlinkFeatures: "ServiceWorker",
          },
        });
    } catch (error) {
      lifetime.abort(error);
      nativeLifetimes.delete(lifetime);
      signal?.removeEventListener("abort", abortFromParent);
      client.revoke();
      await publicResolver?.close();
      throw error;
    }
    const webContents = window.webContents,
      id = webContents.id,
      networkStatus = { status: 200 };
    const physicalRequests = new Map(),
      completionSettlements = new Set();
    const requestKey = (details) =>
      details.webContentsId === id &&
      (typeof details.id === "number" || typeof details.id === "string")
        ? details.id
        : null;
    window.webContents.setWebRTCIPHandlingPolicy?.("disable_non_proxied_udp");
    loginDiagnostics =
      routePolicy.platform === "boss"
        ? createBossLoginDiagnostics({
            diagnostics,
            webContentsId: id,
            manual,
            operation: routePolicy.bossOperation,
            activityId: ref.activityId,
            counts: () => ({
              manualRequests: manualAllowance.requests,
              manualBytes:
                manualAllowance.wireBytes +
                manualAllowance.dnsBytes +
                client.snapshot().bytes,
            }),
            onBudgetExhausted: (code) =>
              window.setTitle?.(
                code === "collection_login_byte_limit"
                  ? "登录窗口已达到数据上限，请关闭后重新打开"
                  : "登录窗口已达到请求上限，请关闭后重新打开",
              ),
            onNavigationDenied: () =>
              window.setTitle?.("来源页面跳转被限制，请查看来源问题日志"),
          })
        : null;
    const manualAdmission = manual
      ? createManualAdmission({
          signal: ownedSignal,
          allowance: manualAllowance,
        })
      : null;
    const policy = createPagePolicy({
      routePolicy,
      maxRequests: 60,
      manual,
      signal: ownedSignal,
      offlineAllows,
      webContentsId: id,
      onDenied: (details, code) => loginDiagnostics?.denied(details, code),
      prepareRequest: (details) => client.grant(details.url),
      reserve: async (details, ownership) => {
        if (manual) {
          claimManualRequest();
          await manualAdmission.admit(details);
        } else {
          const reservationId = randomUUID();
          const reservation = await accountingLedger.reserve({
            ref,
            token,
            operationLease,
            reservationId,
            kind: details.resourceType === "mainFrame" ? "browser" : "resource",
            requestUpperBound: 1,
          });
          const key = requestKey(details);
          // Redirects reuse Electron's id. Each hop keeps its own allowance;
          // a final completion can prove only the most recent physical request.
          if (key !== null)
            physicalRequests.set(key, reservation.reservationId);
        }
        client.grant(details.url);
        loginDiagnostics?.started(details, {
          ownedOperation: ownership?.ownedBossOperation === true,
        });
      },
    });
    const denyDownload = (event) => event.preventDefault();
    const proxyLogin = (event, details, authInfo, callback) => {
      if (
        authInfo.isProxy &&
        authInfo.host === "127.0.0.1" &&
        authInfo.port === Number(new URL(proxy.proxyUrl).port)
      ) {
        event.preventDefault();
        callback(client.username, client.password);
      }
    };
    const navigation = (event, url) => {
      // Electron exposes the destination on the event and, in older callback
      // forms, as the second argument. Both carry the same policy boundary.
      const destination = typeof url === "string" ? url : event?.url;
      if (!allowsRoute(destination, routePolicy, { manual })) {
        event.preventDefault();
        loginDiagnostics?.denied(
          { url: destination, webContentsId: id },
          "collection_route_forbidden",
          "redirect",
        );
      }
    };
    let detach,
      item,
      policyAttached = false;
    try {
      detach = attachNetworkPolicy(ses, "collection-page", policy);
      policyAttached = true;
      ses.webRequest.onCompleted?.({ urls: ["<all_urls>"] }, (details) => {
        manualAdmission?.release(details);
        loginDiagnostics?.completed(details);
        const key = requestKey(details),
          reservationId = physicalRequests.get(key);
        if (!reservationId) return;
        physicalRequests.delete(key);
        const pending = Promise.resolve().then(() =>
          accountingLedger.settle?.({
            ref,
            token,
            operationLease,
            reservationId,
            verifiedUsage: { requests: 1, bytes: 0 },
          }),
        );
        completionSettlements.add(pending);
        pending
          .finally(() => completionSettlements.delete(pending))
          .catch(() => {});
      });
      ses.webRequest.onErrorOccurred?.({ urls: ["<all_urls>"] }, (details) => {
        manualAdmission?.release(details);
        loginDiagnostics?.failed(details);
        // Failed and cancelled requests retain their unresolved upper bound.
        physicalRequests.delete(requestKey(details));
      });
      ses.webRequest.onBeforeRedirect?.({ urls: ["<all_urls>"] }, (details) => {
        manualAdmission?.release(details);
        loginDiagnostics?.redirected(details);
      });
      ses.webRequest.onHeadersReceived(
        { urls: ["<all_urls>"] },
        (details, callback) => {
          loginDiagnostics?.headers(details);
          if (details.resourceType === "mainFrame")
            networkStatus.status = details.statusCode;
          const responseHeaders = { ...details.responseHeaders };
          const key =
            Object.keys(responseHeaders).find(
              (k) => k.toLowerCase() === "content-security-policy",
            ) || "Content-Security-Policy";
          responseHeaders[key] = [
            ...(responseHeaders[key] || []),
            "worker-src 'none'; object-src 'none'; media-src 'none'",
          ];
          callback({ responseHeaders });
        },
      );
      ses.on("will-download", denyDownload);
      window.webContents.on("login", proxyLogin);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", navigation);
      window.webContents.on("will-redirect", navigation);
      let disposing;
      const saveMaterial = async () => {
        if (entry && !backendRevoked) {
          const cookies = await ses.cookies.get({});
          if (!backendRevoked)
            await sessionStore.saveMaterial({
              scope: ref.scope,
              sessionRef: entry.sessionRef,
              cookies,
            });
        }
      };
      const onClosed = () => {
        item.dispose().catch(() => {});
      };
      item = {
        id,
        window,
        ses,
        entry,
        scope: ref.scope,
        client,
        policy,
        manual,
        manualAllowance,
        dnsFailure: (url) => publicResolver?.lastFailure?.(url) || null,
        networkStatus,
        requestDiagnostics: loginDiagnostics,
        lifetime,
        preserveMaterial: false,
        dispose({ keepWindow = false } = {}) {
          if (disposing) {
            // A concurrent clear/stop must win over a pending lease handoff.
            if (!keepWindow && !window.isDestroyed()) window.destroy();
            return disposing;
          }
          disposing = Promise.resolve().then(async () => {
            let cleanupError;
            try {
              lifetime.abort(
                failure("collection_cancelled", "采集窗口已关闭。"),
              );
              policy.close();
              manualAdmission?.close();
              client.revoke();
              await publicResolver?.close();
              if (manual && entry && !keepWindow && !backendRevoked)
                await sessionStore.setState({
                  scope: ref.scope,
                  sessionRef: entry.sessionRef,
                  state: "unverified",
                });
              if (!item.preserveMaterial) await saveMaterial();
              physicalRequests.clear();
              if (manual) manualAllowance.wireBytes += client.snapshot().bytes;
              if (manual && !keepWindow)
                await recordDiagnostic(diagnostics, {
                  operation: "collection.finish",
                  activityId: ref.activityId,
                  outcome: "completed",
                  counts: {
                    manualRequests: manualAllowance.requests,
                    manualBytes:
                      manualAllowance.wireBytes + manualAllowance.dnsBytes,
                  },
                });
            } catch (error) {
              cleanupError = error;
            } finally {
              try {
                await Promise.allSettled([...completionSettlements]);
                await loginDiagnostics?.close();
              } catch (error) {
                cleanupError ||= error;
              }
              try {
                // Electron's window.webContents getter throws after destroy().
                // Native teardown must not prevent bookkeeping or other hooks.
                for (const cleanup of [
                  () => nativeLifetimes.delete(lifetime),
                  () => signal?.removeEventListener("abort", abortFromParent),
                  detach,
                  () => ses.webRequest.onCompleted?.(null),
                  () => ses.webRequest.onErrorOccurred?.(null),
                  () => ses.webRequest.onBeforeRedirect?.(null),
                  () => ses.webRequest.onHeadersReceived(null),
                  () => ses.removeListener("will-download", denyDownload),
                  () => {
                    if (!window.isDestroyed() && !webContents.isDestroyed?.()) {
                      webContents.removeListener("login", proxyLogin);
                      webContents.removeListener("will-navigate", navigation);
                      webContents.removeListener("will-redirect", navigation);
                    }
                  },
                  () => window.removeListener("closed", onClosed),
                  () => {
                    if (!keepWindow && !window.isDestroyed()) window.destroy();
                  },
                ]) {
                  try {
                    cleanup();
                  } catch (error) {
                    cleanupError ||= error;
                  }
                }
                await ses.closeAllConnections();
                if (!entry) {
                  await ses.clearStorageData();
                  await ses.clearCache();
                }
              } catch (error) {
                cleanupError ||= error;
              } finally {
                if (
                  windows.get(id) === item &&
                  (keepWindow || window.isDestroyed())
                )
                  windows.delete(id);
              }
            }
            if (cleanupError) {
              firstCleanupError ||= cleanupError;
              throw cleanupError;
            }
          });
          return disposing;
        },
      };
      windows.set(id, item);
      window.once("closed", onClosed);
      return item;
    } catch (error) {
      try {
        for (const cleanup of [
          () => lifetime.abort(error),
          () => nativeLifetimes.delete(lifetime),
          () => signal?.removeEventListener("abort", abortFromParent),
          () => policy.close(),
          () => manualAdmission?.close(),
          () => client.revoke(),
          () => publicResolver?.close(),
          () => loginDiagnostics?.close(),
          () => {
            if (policyAttached) detach?.();
          },
          ...[
            "onCompleted",
            "onErrorOccurred",
            "onBeforeRedirect",
            "onHeadersReceived",
          ].map((hook) => () => {
            if (policyAttached) ses.webRequest[hook]?.(null);
          }),
          () => ses.removeListener("will-download", denyDownload),
          () => {
            if (!window.isDestroyed() && !webContents.isDestroyed?.()) {
              webContents.removeListener("login", proxyLogin);
              webContents.removeListener("will-navigate", navigation);
              webContents.removeListener("will-redirect", navigation);
            }
          },
          () => {
            if (!existingWindow && !window.isDestroyed()) window.destroy();
          },
          () => {
            if (policyAttached) return ses.closeAllConnections();
          },
        ]) {
          try {
            await cleanup();
          } catch (cleanupError) {
            firstCleanupError ||= cleanupError;
          }
        }
      } finally {
        if (
          windows.get(id) === item &&
          (!existingWindow || window.isDestroyed())
        )
          windows.delete(id);
      }
      throw error;
    }
  }
  const service = {
    async readBoss(input) {
      const operation = validateBossOperation(input.operation);
      if (!input.sessionRef)
        throw failure(
          "collection_session_scope",
          "请先打开当前版本的独立登录窗口。",
        );
      // The owned session queue checks risk before reserving/sending. Checking
      // asynchronously here lets a later invocation overtake the first read.
      return service.read({
        ...input,
        operation,
        url: platformPolicy("boss").entryUrl,
        routePolicy: { ...platformPolicy("boss"), bossOperation: operation },
      });
    },
    async recoverBossSession(input) {
      const entry = await sessionStore.get({
        scope: input.ref.scope,
        sessionRef: input.sessionRef,
      });
      if (entry.platform !== "boss")
        throw failure("collection_session_scope", "采集会话与来源不匹配。");
      const result = await service.readBoss({ ...input, [riskRecovery]: true });
      const verification = parseBossResponse({
        kind: input.operation.kind,
        ...result,
      });
      if (verification.status !== "success") {
        const error = failure(
          verification.code || "boss_risk_recovery_required",
          "会话核验未通过，风险阻塞保留。",
        );
        error.phase = verification.phase || "response";
        if (result.diagnosticId) error.diagnosticId = result.diagnosticId;
        if (result.requestId) error.requestId = result.requestId;
        throw error;
      }
      return sessionStore.clearRisk({
        scope: input.ref.scope,
        sessionRef: input.sessionRef,
        verification: {
          ...verification,
          sessionRef: input.sessionRef,
          expectedRiskStamp: entry.riskStamp,
        },
      });
    },
    async read({
      ref,
      token,
      url,
      routePolicy,
      operationLease,
      signal,
      sessionRef,
      operation,
      [riskRecovery]: recovering,
    }) {
      const readStartedAt = performance.now();
      publicCollectionUrl(url);
      if (
        sessionRef &&
        (closingLoginScopes.has(scopeKey(ref.scope)) ||
          (operation && loginOpenings.has(scopeKey(ref.scope))))
      )
        throw failure(
          "collection_session_busy",
          "本版本会话正在打开或清理，请稍后核验。",
        );
      await assertScope?.(ref.scope);
      if (stopping)
        throw failure("collection_browser_unavailable", "采集窗口已关闭。");
      while (reads >= 2 || (sessionRef && busySessions.has(sessionRef))) {
        if (stopping)
          throw failure("collection_browser_unavailable", "采集窗口已关闭。");
        signal?.throwIfAborted();
        await cancellableSleep(50, signal);
      }
      signal?.throwIfAborted();
      reads++;
      if (sessionRef) busySessions.add(sessionRef);
      let item,
        borrowed,
        byteReservation,
        windowBudget,
        phase = "budget";
      const packageGeneration = generations.get(ref.scope.packageId) || 0,
        sessionGeneration = sessionGenerations.get(sessionRef) || 0;
      const ensureReadOwner = () => {
        if (
          stopping ||
          closingLoginScopes.has(scopeKey(ref.scope)) ||
          packageGeneration !== (generations.get(ref.scope.packageId) || 0) ||
          sessionGeneration !== (sessionGenerations.get(sessionRef) || 0)
        )
          throw failure("collection_cancelled", "采集窗口已关闭。");
      };
      try {
        if (operation) {
          validateBossOperation(operation);
          if (routePolicy.platform !== "boss" || !sessionRef)
            throw failure("collection_session_scope", "采集会话与来源不匹配。");
          await assertBossRisk({ ref, sessionRef, [riskRecovery]: recovering });
        }
        if (ledger.reserveBatch && ledger.settleBatch)
          windowBudget = await createBrowserWindowBudget({
            ledger,
            ref,
            token,
            operationLease,
            signal,
          });
        else
          byteReservation = await ledger.reserve({
            ref,
            token,
            operationLease,
            reservationId: randomUUID(),
            kind: "browser",
            requestUpperBound: 0,
            bytesUpperBound: 20971520,
          });
        const entry = sessionRef
          ? await sessionStore.get({ scope: ref.scope, sessionRef })
          : undefined;
        if (entry && entry.platform !== routePolicy.platform)
          throw failure("collection_session_scope", "采集会话与来源不匹配。");
        const existing = [...windows.values()].find(
          (w) => w.manual && w.entry?.sessionRef === sessionRef,
        );
        if (existing) {
          borrowed = operation ? existing : undefined;
          await existing.dispose({ keepWindow: Boolean(borrowed) });
        }
        ensureReadOwner();
        item = await prepare({
          ref,
          token,
          routePolicy,
          operationLease,
          signal,
          entry,
          accountingLedger: windowBudget?.ledger || ledger,
          maxWireBytes: windowBudget?.maxWireBytes || 20971520,
          existingWindow: borrowed?.window,
        });
        ensureReadOwner();
        let rejectAbort;
        const aborted = new Promise((_, reject) => {
          rejectAbort = reject;
        });
        let abortDrain;
        const abort = () => {
          if (abortDrain) return;
          item.policy.close();
          item.client.revoke();
          rejectAbort(
            signal?.reason || failure("collection_cancelled", "采集已取消。"),
          );
          abortDrain = Promise.resolve().then(async () => {
            let timeout;
            try {
              if (operation && !item.window.isDestroyed())
                await Promise.race([
                  item.window.webContents.executeJavaScript(
                    bossAbortScript(item.id),
                  ),
                  new Promise((r) => {
                    timeout = setTimeout(r, 200);
                  }),
                ]);
            } catch {
            } finally {
              clearTimeout(timeout);
              if (!borrowed && !item.window.isDestroyed())
                item.window.destroy();
            }
          });
        };
        signal?.addEventListener("abort", abort, { once: true });
        item.lifetime.signal.addEventListener("abort", abort, { once: true });
        let timer;
        phase = "load";
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(failure("collection_browser_timeout", "页面读取超时。"));
            abort();
          }, 45000);
        });
        try {
          const currentUrl = item.window.webContents.getURL();
          const readyOwnedPage =
            borrowed &&
            allowsRoute(currentUrl, platformPolicy("boss")) &&
            /^\/web\/geek\/jobs\/?$|^\/job_detail\//.test(
              new URL(currentUrl).pathname,
            );
          if (!readyOwnedPage)
            await Promise.race([item.window.loadURL(url), aborted, deadline]);
          signal?.throwIfAborted();
          phase = "render";
          const ownershipToken = operation ? randomUUID() : undefined;
          if (operation) item.policy.armBossOperation(ownershipToken);
          const document = await Promise.race([
            item.window.webContents.executeJavaScript(
              operation
                ? bossPageScript(operation, item.id, ownershipToken)
                : `({html:document.documentElement.outerHTML,selectorFound:!!document.querySelector(${JSON.stringify(routePolicy.bodySelector || "__no_body_selector__")})?.textContent.trim()})`,
              true,
            ),
            aborted,
            deadline,
          ]);
          signal?.throwIfAborted();
          if (item.lifetime.signal.aborted)
            throw failure("collection_cancelled", "采集已取消。");
          if (operation) {
            phase = "response";
            let result = decodeBossPageResult(document);
            const ownedDenial = item.policy.bossOperationStatus().denied;
            if (
              [
                "source_budget_exhausted",
                "collection_browser_budget_exhausted",
              ].includes(ownedDenial)
            )
              throw Object.assign(failure(ownedDenial, "采集请求额度不足。"), {
                phase: "budget",
              });
            if (ownedDenial) result = { status: 0, code: ownedDenial };
            const checkedAt = new Date().toISOString();
            const parsed = parseBossResponse({
              kind: operation.kind,
              ...result,
              checkedAt,
            });
            if (parsed.status === "risk_blocked")
              await sessionStore.setRisk({
                scope: ref.scope,
                sessionRef,
                code: parsed.code,
                checkedAt,
              });
            else if (["success", "login_required"].includes(parsed.status))
              await sessionStore.setState({
                scope: ref.scope,
                sessionRef,
                state: parsed.status === "success" ? "verified" : "expired",
              });
            const observed = ownedDenial
              ? {}
              : item.requestDiagnostics?.operationMetadata() || {};
            const diagnostic = await recordDiagnostic(diagnostics, {
              operation: "network.request",
              sourceId: "boss",
              siteId: "boss",
              engine: "browser",
              phase: "parse",
              failurePhase:
                parsed.status === "success"
                  ? undefined
                  : parsed.phase || "response",
              outcome: parsed.status === "success" ? "success" : "failed",
              code: parsed.code || "boss_request_success",
              ...observed,
              resultCategory: classifyBossBusinessResult(
                parsed,
                result,
                observed,
              ),
              durationMs:
                observed.durationMs ??
                Math.max(0, Math.round(performance.now() - readStartedAt)),
              httpStatus: result.status >= 100 ? result.status : undefined,
              errorNumber: Number.isSafeInteger(result.payload?.code)
                ? result.payload.code
                : undefined,
              endpointKind:
                operation.kind === "boss.search" ? "list" : "detail",
              requestPurpose:
                operation.kind === "boss.search" ? "list" : "detail",
              method: operation.method,
              parser: {
                version: "boss-business-response",
                resultType: result.payload ? "object" : "null",
                format: "json",
              },
            });
            return {
              ...result,
              ...(observed.requestId ? { requestId: observed.requestId } : {}),
              ...(diagnostic?.diagnosticId
                ? { diagnosticId: diagnostic.diagnosticId }
                : {}),
              checkedAt,
              channel: "authorized_browser",
              usage: {
                ...item.policy.snapshot(),
                wireBytes: item.client.snapshot().bytes,
              },
            };
          }
          const html = typeof document === "string" ? document : document.html;
          if (typeof html !== "string" || Buffer.byteLength(html) > 8388608)
            throw failure(
              "collection_browser_output_limit",
              "页面内容超过上限。",
            );
          const status = item.networkStatus.status;
          const body = classifyBrowserBody({
            html,
            status,
            selectorFound:
              typeof document === "object" ? document.selectorFound : undefined,
          });
          return {
            status,
            url: publicCollectionUrl(item.window.webContents.getURL()).href,
            html,
            text: html,
            ...body,
            channel: sessionRef ? "authorized_browser" : "anonymous_browser",
            usage: {
              ...item.policy.snapshot(),
              wireBytes: item.client.snapshot().bytes,
            },
          };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          item.lifetime.signal.removeEventListener("abort", abort);
          await abortDrain;
        }
      } catch (error) {
        if (error && typeof error === "object" && !error.phase)
          error.phase = phase;
        if (operation) {
          const observed = item?.policy.bossOperationStatus?.().denied
            ? {}
            : item?.requestDiagnostics?.operationMetadata() || {};
          const diagnostic = await recordDiagnostic(
            diagnostics,
            {
              operation: "network.request",
              sourceId: "boss",
              siteId: "boss",
              activityId: ref.activityId,
              engine: "browser",
              phase: error.phase || phase,
              outcome: "failed",
              code: error.code || "collection_request_failed",
              ...observed,
              resultCategory: classifyCollectionFailure(error),
              durationMs:
                observed.durationMs ??
                Math.max(0, Math.round(performance.now() - readStartedAt)),
              endpointKind:
                operation.kind === "boss.search" ? "list" : "detail",
              requestPurpose:
                operation.kind === "boss.search" ? "list" : "detail",
              parser: { version: "boss-read-failure" },
              method: operation.method,
            },
            error,
          );
          if (error && typeof error === "object") {
            if (observed.requestId) error.requestId = observed.requestId;
            if (diagnostic?.diagnosticId)
              error.diagnosticId = diagnostic.diagnosticId;
          }
        }
        throw error;
      } finally {
        try {
          try {
            await item?.dispose({ keepWindow: Boolean(borrowed) });
          } finally {
            await windowBudget?.close({
              bytes: item?.client.snapshot().bytes ?? 0,
            });
          }
          if (byteReservation && item)
            await ledger.settle?.({
              ref,
              token,
              operationLease,
              reservationId: byteReservation.reservationId,
              verifiedUsage: {
                requests: 0,
                bytes: item.client.snapshot().bytes,
              },
            });
        } finally {
          if (borrowed && !borrowed.window.isDestroyed()) {
            try {
              ensureReadOwner();
              const owned = await sessionStore.get({
                scope: ref.scope,
                sessionRef,
              });
              ensureReadOwner();
              await prepare({
                ref: { scope: ref.scope },
                routePolicy: platformPolicy("boss"),
                manual: true,
                entry: owned,
                existingWindow: borrowed.window,
                manualAllowance: borrowed.manualAllowance,
              });
              ensureReadOwner();
            } catch (error) {
              try {
                ensureReadOwner();
                await sessionStore.get({ scope: ref.scope, sessionRef });
                ensureReadOwner();
                await holdOwnedWindow(
                  borrowed,
                  "collection_login_cleanup_failed",
                );
              } catch {
                // Explicit clear/stop or revoked ownership is allowed to close.
                if (!borrowed.window.isDestroyed()) borrowed.window.destroy();
              }
              await recordDiagnostic(
                diagnostics,
                {
                  operation: "collection.finish",
                  sourceId: "boss",
                  siteId: "boss",
                  phase: "cleanup",
                  outcome: "failed",
                  code: error.code || "collection_login_cleanup_failed",
                },
                error,
              );
            }
          }
          reads--;
          if (sessionRef) busySessions.delete(sessionRef);
        }
      }
    },
    async openLogin({
      ref,
      platform,
      accountRef,
      signal,
      remember,
      testUrl,
      sessionRef,
    }) {
      signal?.throwIfAborted();
      const generation = generations.get(ref.scope.packageId) || 0,
        initialSessionGeneration = sessionGenerations.get(sessionRef) || 0;
      await assertScope?.(ref.scope);
      if (stopping)
        throw failure(
          "collection_browser_unavailable",
          "请先关闭其他采集窗口。",
        );
      if (
        platform === "boss" &&
        (closingLoginScopes.has(scopeKey(ref.scope)) ||
          (sessionRef && busySessions.has(sessionRef)))
      )
        throw failure(
          "collection_session_busy",
          "本版本来源正在读取或清理，请稍后打开。",
        );
      const routePolicy = platformPolicy(platform);
      if (
        platform === "wechat" &&
        (!testUrl ||
          !allowsRoute(testUrl, routePolicy) ||
          !/^\/s(?:\/|$)/.test(new URL(testUrl).pathname))
      )
        throw failure(
          "collection_article_required",
          "请提供要验证的公开公众号文章地址。",
        );
      const entryUrl =
          platform === "wechat"
            ? testUrl
            : routePolicy.loginEntryUrl || routePolicy.entryUrl,
        entry = await sessionStore.create({
          scope: ref.scope,
          platform,
          accountRef,
          remember,
          sessionRef,
        });
      let item, timer, abortLoad;
      const entryGeneration =
        sessionRef === entry.sessionRef
          ? initialSessionGeneration
          : sessionGenerations.get(entry.sessionRef) || 0;
      const ensureOwned = async () => {
        signal?.throwIfAborted();
        if (
          stopping ||
          generation !== (generations.get(ref.scope.packageId) || 0) ||
          entryGeneration !== (sessionGenerations.get(entry.sessionRef) || 0)
        )
          throw failure("collection_cancelled", "采集窗口已关闭。");
        await sessionStore.get?.({
          scope: ref.scope,
          sessionRef: entry.sessionRef,
        });
      };
      try {
        await ensureOwned();
        if (platform === "boss" && busySessions.has(entry.sessionRef))
          throw failure(
            "collection_session_busy",
            "本版本来源正在读取，请稍后打开。",
          );
        const existing =
          platform === "boss" &&
          [...windows.values()].find(
            (w) =>
              w.manual &&
              w.entry?.sessionRef === entry.sessionRef &&
              !w.lifetime.signal.aborted &&
              !w.window.isDestroyed(),
          );
        if (existing) {
          if (existing.window.isMinimized()) existing.window.restore();
          existing.window.show();
          existing.window.focus();
          if (existing.heldCode)
            throw failure(
              existing.heldCode,
              existing.heldCode === "collection_login_budget_exhausted"
                ? "独立窗口人工浏览额度已用完，页面和登录已保留。可关闭此窗口后重新打开。"
                : "独立窗口读取权限暂不可用，页面和登录已保留，请查看来源问题日志。",
            );
          await ensureOwned();
          await rememberSession?.({
            scope: ref.scope,
            platform,
            sessionRef: entry.sessionRef,
          });
          await ensureOwned();
          return {
            ...(await sessionStore.getStatus?.({
              scope: ref.scope,
              sessionRef: entry.sessionRef,
            })),
            sessionRef: entry.sessionRef,
            state: entry.state,
            remembered: Boolean(entry.remember),
          };
        }
        if (windows.size >= 20)
          throw failure(
            "collection_browser_unavailable",
            "请先关闭其他采集窗口。",
          );
        item = await prepare({ ref, routePolicy, manual: true, entry, signal });
        item.preserveMaterial = Boolean(entry.reused);
        await Promise.race([
          item.window.loadURL(entryUrl),
          new Promise((_, reject) => {
            abortLoad = () => reject(item.lifetime.signal.reason);
            item.lifetime.signal.addEventListener("abort", abortLoad, {
              once: true,
            });
            if (item.lifetime.signal.aborted) abortLoad();
            timer = setTimeout(
              () =>
                reject(
                  failure(
                    "collection_login_load_timeout",
                    "独立登录页面加载超时。",
                  ),
                ),
              45000,
            );
          }),
        ]);
        item.lifetime.signal.throwIfAborted();
        await ensureOwned();
        await rememberSession?.({
          scope: ref.scope,
          platform,
          sessionRef: entry.sessionRef,
        });
        await ensureOwned();
        item.preserveMaterial = false;
      } catch (error) {
        const cancelled =
          error?.code === "collection_cancelled" ||
          item?.lifetime.signal.aborted;
        const dnsFailure = !cancelled && item?.dnsFailure(entryUrl);
        const reported = failure(
          cancelled
            ? "collection_cancelled"
            : [
                  "collection_login_budget_exhausted",
                  "collection_login_cleanup_failed",
                ].includes(error.code)
              ? error.code
              : "collection_login_load_failed",
          cancelled
            ? "采集窗口已关闭。"
            : [
                  "collection_login_budget_exhausted",
                  "collection_login_cleanup_failed",
                ].includes(error.code)
              ? error.message
              : dnsFailure?.code === "request_timeout"
                ? "独立登录页域名解析超时，备用解析节点也未连接成功。请稍后重试并查看来源问题日志。"
                : dnsFailure
                  ? "独立登录页域名解析失败，请查看来源问题日志中的具体原因。"
                  : "独立登录页面加载失败，请查看来源问题日志。",
        );
        if (dnsFailure)
          reported.cause = Object.assign(Error(dnsFailure.code), {
            ...dnsFailure,
            phase: "dns",
          });
        const diagnostic = await recordDiagnostic(
          diagnostics,
          {
            operation: "collection.finish",
            phase: "load",
            outcome: "failed",
            code: reported.code,
            ...(platform === "boss"
              ? { sourceId: "boss", siteId: "boss" }
              : {}),
            ...(dnsFailure ? { failurePhase: "dns" } : {}),
            ...(Number.isSafeInteger(error.errno)
              ? { errorNumber: error.errno }
              : {}),
          },
          reported,
        );
        if (/^d-[a-f0-9-]{36}$/.test(diagnostic?.diagnosticId || "")) {
          reported.diagnosticId = diagnostic.diagnosticId;
          // Electron serializes invoke errors as messages, discarding fields.
          reported.message += "\n错误编号：" + diagnostic.diagnosticId;
        }
        let cleanupFailed = false;
        try {
          await item?.dispose();
        } catch {
          cleanupFailed = true;
        }
        try {
          if (!entry.reused)
            await sessionStore.clear({
              scope: ref.scope,
              sessionRef: entry.sessionRef,
            });
        } catch (cleanupError) {
          const alreadyRevoked =
            cancelled &&
            cleanupError?.code === "collection_session_scope" &&
            (stopping ||
              generation !== (generations.get(ref.scope.packageId) || 0) ||
              entryGeneration !==
                (sessionGenerations.get(entry.sessionRef) || 0));
          if (!alreadyRevoked) cleanupFailed = true;
        }
        if (cleanupFailed)
          await recordDiagnostic(diagnostics, {
            operation: "collection.finish",
            phase: "cleanup",
            outcome: "failed",
            code: "collection_login_cleanup_failed",
          });
        throw reported;
      } finally {
        clearTimeout(timer);
        if (abortLoad)
          item?.lifetime.signal.removeEventListener("abort", abortLoad);
      }
      return {
        ...(await sessionStore.getStatus?.({
          scope: ref.scope,
          sessionRef: entry.sessionRef,
        })),
        sessionRef: entry.sessionRef,
        state: "unverified",
        remembered: Boolean(entry.remember),
      };
    },
    async verifySession(input) {
      const entry = await sessionStore.get({
        scope: input.ref.scope,
        sessionRef: input.sessionRef,
      });
      const result = await service.read({
        ...input,
        url: input.testUrl,
        routePolicy: platformPolicy(entry.platform),
      });
      const state =
        result.bodyStatus === "complete" ? "verified" : "unverified";
      await sessionStore.setState({
        scope: input.ref.scope,
        sessionRef: input.sessionRef,
        state,
      });
      return {
        sessionRef: input.sessionRef,
        state,
        bodyStatus: result.bodyStatus,
      };
    },
    async clearSession({ scope, sessionRef }) {
      await assertScope?.(scope);
      await sessionStore.get({ scope, sessionRef });
      const key = scopeKey(scope);
      closingLoginScopes.add(key);
      sessionGenerations.set(
        sessionRef,
        (sessionGenerations.get(sessionRef) || 0) + 1,
      );
      try {
        await Promise.allSettled([...(sessionPrepares.get(sessionRef) || [])]);
        for (const item of [...windows.values()])
          if (item.entry?.sessionRef === sessionRef) await item.dispose();
        await Promise.allSettled([
          ...(loginOpenings.has(key) ? [loginOpenings.get(key)] : []),
          ...[...pendingReads]
            .filter((r) => r.sessionRef === sessionRef)
            .map((r) => r.task),
        ]);
        const stored = sessions.get(sessionRef);
        if (stored) {
          await stored.ses.closeAllConnections();
          await stored.ses.clearStorageData();
          await stored.ses.clearCache();
          sessions.delete(sessionRef);
        }
        return sessionStore.clear({ scope, sessionRef });
      } finally {
        closingLoginScopes.delete(key);
      }
    },
    async closePackage(packageId) {
      generations.set(packageId, (generations.get(packageId) || 0) + 1);
      await Promise.allSettled([...(prepares.get(packageId) || [])]);
      let cleanupFailed = false;
      for (const item of [...windows.values()])
        if (item.scope.packageId === packageId)
          try {
            await item.dispose();
          } catch {
            cleanupFailed = true;
          }
      await Promise.allSettled([
        ...[...loginOpenings]
          .filter(([key]) => JSON.parse(key)[0] === packageId)
          .map(([, task]) => task),
        ...[...pendingReads]
          .filter((r) => r.scope.packageId === packageId)
          .map((r) => r.task),
      ]);
      for (const [id, stored] of [...sessions])
        if (stored.packageId === packageId) {
          try {
            await stored.ses.closeAllConnections();
            await stored.ses.clearStorageData();
            await stored.ses.clearCache();
            sessions.delete(id);
          } catch {
            cleanupFailed = true;
          }
        }
      const result = await sessionStore.cleanupPackage(packageId);
      return cleanupFailed ? { status: "cleanup_pending" } : result;
    },
    setDnsMode(mode) {
      if (
        !["auto", "system", "doh"].includes(mode) ||
        windows.size ||
        prepares.size
      )
        throw failure(
          "collection_browser_configuration",
          "采集窗口网络设置不可用。",
        );
      dnsMode = mode;
      return { configured: true };
    },
    revokeBackend(reason = failure("backend_exited", "后台已停止。")) {
      // This path is intentionally synchronous. Never wait on a dead backend's
      // ledger or session RPC before closing network policies and proxy grants.
      stopping = true;
      backendRevoked = true;
      for (const packageId of new Set([
        ...prepares.keys(),
        ...[...windows.values()].map((item) => item.scope.packageId),
      ]))
        generations.set(packageId, (generations.get(packageId) || 0) + 1);
      for (const sessionRef of sessions.keys())
        sessionGenerations.set(
          sessionRef,
          (sessionGenerations.get(sessionRef) || 0) + 1,
        );
      for (const lifetime of nativeLifetimes) lifetime.abort(reason);
      for (const item of windows.values()) {
        for (const revoke of [
          () => item.policy.close(),
          () => item.client.revoke(),
          () => item.lifetime.abort(reason),
          () => {
            if (!item.window.isDestroyed()) item.window.webContents.stop?.();
          },
          () => {
            if (!item.window.isDestroyed()) item.window.destroy();
          },
          () =>
            Promise.resolve(item.ses.closeAllConnections()).catch(
              (error) => (firstCleanupError ||= error),
            ),
        ]) {
          try {
            revoke();
          } catch (error) {
            firstCleanupError ||= error;
          }
        }
      }
    },
    async stop() {
      stopping = true;
      await Promise.allSettled([...prepares.values()].flatMap((s) => [...s]));
      await Promise.allSettled(
        [...windows.values()].map((item) => item.dispose()),
      );
      await Promise.allSettled([
        ...loginOpenings.values(),
        ...[...pendingReads].map((r) => r.task),
      ]);
      for (const { ses } of sessions.values()) {
        try {
          await ses.closeAllConnections();
          await ses.clearStorageData();
          await ses.clearCache();
        } catch (error) {
          firstCleanupError ||= error;
        }
      }
      sessions.clear();
      try {
        await egressProxy.stop();
      } catch (error) {
        firstCleanupError ||= error;
      }
      if (firstCleanupError) throw firstCleanupError;
    },
    snapshot: () => ({ activeReads: reads, windows: windows.size }),
  };
  const read = service.read;
  service.read = (input) => {
    const task = sharedSocialScheduler.run(
      new URL(input.url).origin,
      () => read(input),
      {
        signal: input.signal,
      },
    );
    const pending = {
      scope: input.ref.scope,
      sessionRef: input.sessionRef,
      task,
    };
    pendingReads.add(pending);
    task.finally(() => pendingReads.delete(pending)).catch(() => {});
    return task;
  };
  const openLogin = service.openLogin;
  service.openLogin = (input) => {
    if (input.platform !== "boss") return openLogin(input);
    const key = scopeKey(input.ref.scope);
    if (closingLoginScopes.has(key))
      return Promise.reject(
        failure("collection_session_busy", "本版本会话正在清理，请稍后打开。"),
      );
    const generation = generations.get(input.ref.scope.packageId) || 0;
    const pending = (loginOpenings.get(key) || Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (
          stopping ||
          generation !== (generations.get(input.ref.scope.packageId) || 0)
        )
          throw failure("collection_cancelled", "采集窗口已关闭。");
        return openLogin(input);
      });
    loginOpenings.set(key, pending);
    pending
      .finally(() => {
        if (loginOpenings.get(key) === pending) loginOpenings.delete(key);
      })
      .catch(() => {});
    return pending;
  };
  return service;
}
