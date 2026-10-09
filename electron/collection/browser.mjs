import { randomUUID } from "node:crypto";
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
} = {}) {
  const windows = new Map(),
    sessions = new Map(),
    busySessions = new Set(),
    generations = new Map(),
    prepares = new Map();
  let reads = 0,
    stopping = false;
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
          allowsRoute("https://" + host + "/", platformPolicy(entry.platform), {
            manual: true,
          })
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
  function prepare(input) {
    const packageId = input.ref.scope.packageId,
      generation = generations.get(packageId) || 0;
    const ensure = () => {
      if (stopping || generation !== (generations.get(packageId) || 0))
        throw failure("collection_cancelled", "采集窗口已关闭。");
      input.signal?.throwIfAborted();
    };
    const pending = prepareInternal({ ...input, ensure });
    if (!prepares.has(packageId)) prepares.set(packageId, new Set());
    prepares.get(packageId).add(pending);
    pending
      .finally(() => prepares.get(packageId)?.delete(pending))
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
  }) {
    const partition = entry?.partition || "collection-" + randomUUID();
    const ses = entry
      ? await sessionFor(entry)
      : session.fromPartition(partition, { cache: false });
    ensure();
    await ses.clearStorageData({
      storages: ["serviceworkers", "cachestorage"],
    });
    ses.setPermissionRequestHandler((_, __, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const proxy = await egressProxy.start();
    const client = egressProxy.createClient({
      hosts: routePolicy.hosts,
      maxBytes: 20971520,
      signal,
    });
    let window;
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
      window = new BrowserWindow({
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
      client.revoke();
      throw error;
    }
    const id = window.webContents.id,
      networkStatus = { status: 200 };
    const lifetime = new AbortController();
    window.webContents.setWebRTCIPHandlingPolicy?.("disable_non_proxied_udp");
    let manualQueue = Promise.resolve(),
      lastManualAt = 0;
    const policy = createPagePolicy({
      routePolicy,
      maxRequests: 60,
      manual,
      signal,
      offlineAllows,
      webContentsId: id,
      reserve: async (details) => {
        if (manual) {
          const next = manualQueue.then(async () => {
            await cancellableSleep(
              Math.max(0, lastManualAt + 300 - Date.now()),
              signal,
            );
            lastManualAt = Date.now();
          });
          manualQueue = next.catch(() => {});
          await next;
        } else
          await ledger.reserve({
            ref,
            token,
            operationLease,
            reservationId: randomUUID(),
            kind: details.resourceType === "mainFrame" ? "browser" : "resource",
            requestUpperBound: 1,
          });
        client.grant(details.url);
      },
    });
    const detach = attachNetworkPolicy(ses, "collection-page", policy);
    ses.webRequest.onHeadersReceived(
      { urls: ["<all_urls>"] },
      (details, callback) => {
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
    const denyDownload = (event) => event.preventDefault();
    ses.on("will-download", denyDownload);
    window.webContents.on("login", (event, details, authInfo, callback) => {
      if (
        authInfo.isProxy &&
        authInfo.host === "127.0.0.1" &&
        authInfo.port === Number(new URL(proxy.proxyUrl).port)
      ) {
        event.preventDefault();
        callback(client.username, client.password);
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!allowsRoute(url, routePolicy, { manual })) event.preventDefault();
    });
    let disposing;
    const saveMaterial = async () => {
      if (entry)
        await sessionStore.saveMaterial({
          scope: ref.scope,
          sessionRef: entry.sessionRef,
          cookies: await ses.cookies.get({}),
        });
    };
    const item = {
      id,
      window,
      ses,
      entry,
      scope: ref.scope,
      client,
      policy,
      manual,
      networkStatus,
      lifetime,
      dispose() {
        if (disposing) return disposing;
        disposing = Promise.resolve().then(async () => {
          lifetime.abort(failure("collection_cancelled", "采集窗口已关闭。"));
          policy.close();
          client.revoke();
          try {
            if (manual && entry)
              await sessionStore.setState({
                scope: ref.scope,
                sessionRef: entry.sessionRef,
                state: "unverified",
              });
            await saveMaterial();
          } finally {
            detach();
            ses.webRequest.onHeadersReceived(null);
            ses.removeListener("will-download", denyDownload);
            if (!window.isDestroyed()) window.destroy();
            try {
              await ses.closeAllConnections();
              if (!entry) {
                await ses.clearStorageData();
                await ses.clearCache();
              }
            } finally {
              windows.delete(id);
            }
          }
        });
        return disposing;
      },
    };
    windows.set(id, item);
    window.once("closed", () => {
      item.dispose().catch(() => {});
    });
    return item;
  }
  const service = {
    async read({
      ref,
      token,
      url,
      routePolicy,
      operationLease,
      signal,
      sessionRef,
    }) {
      publicCollectionUrl(url);
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
      let item, byteReservation;
      try {
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
        if (existing) await existing.dispose();
        item = await prepare({
          ref,
          token,
          routePolicy,
          operationLease,
          signal,
          entry,
        });
        let rejectAbort;
        const aborted = new Promise((_, reject) => {
          rejectAbort = reject;
        });
        const abort = () => {
          rejectAbort(
            signal?.reason || failure("collection_cancelled", "采集已取消。"),
          );
          if (!item.window.isDestroyed()) item.window.destroy();
        };
        signal?.addEventListener("abort", abort, { once: true });
        item.lifetime.signal.addEventListener("abort", abort, { once: true });
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(failure("collection_browser_timeout", "页面读取超时。"));
            if (!item.window.isDestroyed()) item.window.destroy();
          }, 45000);
        });
        try {
          await Promise.race([item.window.loadURL(url), aborted, deadline]);
          signal?.throwIfAborted();
          const document = await Promise.race([
            item.window.webContents.executeJavaScript(
              `({html:document.documentElement.outerHTML,selectorFound:!!document.querySelector(${JSON.stringify(routePolicy.bodySelector || "__no_body_selector__")})?.textContent.trim()})`,
              true,
            ),
            aborted,
            deadline,
          ]);
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
        }
      } finally {
        try {
          await item?.dispose();
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
          reads--;
          if (sessionRef) busySessions.delete(sessionRef);
        }
      }
    },
    async openLogin({ ref, platform, accountRef, remember = false, testUrl }) {
      await assertScope?.(ref.scope);
      if (stopping || windows.size >= 20)
        throw failure(
          "collection_browser_unavailable",
          "请先关闭其他采集窗口。",
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
      const entryUrl = platform === "wechat" ? testUrl : routePolicy.entryUrl,
        entry = await sessionStore.create({
          scope: ref.scope,
          platform,
          accountRef,
          remember,
        });
      const item = await prepare({ ref, routePolicy, manual: true, entry });
      try {
        await rememberSession?.({
          scope: ref.scope,
          platform,
          sessionRef: entry.sessionRef,
        });
      } catch (error) {
        await item.dispose();
        await sessionStore.clear({
          scope: ref.scope,
          sessionRef: entry.sessionRef,
        });
        throw error;
      }
      item.window.loadURL(entryUrl).catch(() => {});
      return {
        sessionRef: entry.sessionRef,
        state: "unverified",
        remembered: entry.remember,
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
      for (const item of [...windows.values()])
        if (item.entry?.sessionRef === sessionRef) await item.dispose();
      const stored = sessions.get(sessionRef);
      if (stored) {
        await stored.ses.closeAllConnections();
        await stored.ses.clearStorageData();
        await stored.ses.clearCache();
        sessions.delete(sessionRef);
      }
      return sessionStore.clear({ scope, sessionRef });
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
    async stop() {
      stopping = true;
      await Promise.allSettled([...prepares.values()].flatMap((s) => [...s]));
      await Promise.allSettled(
        [...windows.values()].map((item) => item.dispose()),
      );
      for (const { ses } of sessions.values()) {
        try {
          await ses.closeAllConnections();
          await ses.clearStorageData();
          await ses.clearCache();
        } catch {}
      }
      sessions.clear();
      await egressProxy.stop();
    },
    snapshot: () => ({ activeReads: reads, windows: windows.size }),
  };
  const read = service.read;
  service.read = (input) =>
    sharedSocialScheduler.run(new URL(input.url).origin, () => read(input), {
      signal: input.signal,
    });
  return service;
}
