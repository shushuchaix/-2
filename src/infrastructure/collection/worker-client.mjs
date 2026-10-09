import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn as defaultSpawn } from "node:child_process";
import {
  validateWorkerRequest,
  validateWorkerResult,
  createJsonLineReader,
  workerEnvironment,
} from "./worker-protocol.mjs";
import { allowsRoute } from "../../../electron/collection/network-policy.mjs";
const fail = (code) =>
  Object.assign(
    Error(
      {
        collection_worker_protocol: "匿名采集返回格式异常。",
        collection_worker_crashed: "匿名采集进程异常退出。",
        collection_worker_timeout: "匿名采集超时。",
        collection_worker_cancelled: "匿名采集已取消。",
      }[code] || "匿名采集不可用。",
    ),
    { code },
  );
const defaultKill = (child) =>
  new Promise((resolve) => {
    if (process.platform !== "win32") {
      child.kill("SIGKILL");
      resolve();
      return;
    }
    const killer = defaultSpawn(
      path.join(process.env.SystemRoot, "System32/taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, shell: false, stdio: "ignore" },
    );
    killer.once("exit", resolve);
    killer.once("error", () => {
      child.kill();
      resolve();
    });
  });
export function createAnonymousWorker({
  runtime,
  ledger,
  egressProxy,
  spawn = defaultSpawn,
  terminateTree = defaultKill,
  cleanup,
  clock = { now: Date.now },
  tempRoot,
  diagnostics,
} = {}) {
  const active = new Map(),
    enhancements = new Set(),
    preparing = new Map(),
    generations = new Map();
  let stopped = false,
    starting = 0;
  const service = {
    probe: () =>
      runtime?.verified
        ? { available: true, capabilities: runtime.capabilities }
        : {
            available: false,
            capabilities: { static: false, dynamic: false, enhanced: false },
            code: "collection_runtime_unavailable",
          },
    async read({
      ref,
      token,
      publicRoute,
      extractionRule,
      mode = "enhanced",
      operationLease,
      signal,
    }) {
      if (!service.probe().available || !runtime.capabilities[mode])
        return {
          bodyStatus: "unavailable",
          channel: "anonymous_" + mode,
          usage: { requests: 0 },
        };
      signal?.throwIfAborted();
      if (stopped) throw fail("collection_worker_cancelled");
      const request = validateWorkerRequest({
        protocolVersion: 1,
        kind: "read",
        requestId: randomUUID(),
        mode,
        publicRoute,
        ruleId: extractionRule,
        limits: {
          maxRequests: 60,
          maxWireBytes: 20971520,
          maxDomBytes: 6291456,
        },
        timeoutMs: 45000,
      });
      const key =
        ref.scope.packageId + ":" + ref.activityId + ":" + request.publicUrl;
      if (mode === "enhanced" && enhancements.has(key))
        return {
          bodyStatus: "incomplete",
          code: "collection_enhancement_already_attempted",
          usage: { requests: 0 },
        };
      if (mode === "enhanced") enhancements.add(key);
      while (active.size + starting >= 2) {
        signal?.throwIfAborted();
        if (stopped) throw fail("collection_worker_cancelled");
        await new Promise((r) => setTimeout(r, 50));
      }
      starting++;
      const prepareId = randomUUID(),
        packageId = ref.scope.packageId,
        generation = generations.get(packageId) || 0;
      preparing.set(prepareId, packageId);
      let reservation, proxy, client;
      try {
        reservation = await ledger.reserve({
          ref,
          token,
          operationLease,
          reservationId: randomUUID(),
          kind: "worker",
          requestUpperBound: 60,
          bytesUpperBound: 20971520,
        });
        proxy = await egressProxy.start();
        signal?.throwIfAborted();
        if (stopped || generation !== (generations.get(packageId) || 0))
          throw fail("collection_worker_cancelled");
        client = egressProxy.createClient({
          hosts: request.routePolicy.hosts,
          maxBytes: request.limits.maxWireBytes,
          signal,
        });
      } finally {
        starting--;
        preparing.delete(prepareId);
      }
      let child,
        timer,
        settled = false,
        exited = false,
        stderrBytes = 0,
        grants = 0,
        lastSequence = 0,
        result,
        workingDir,
        exitPromise,
        cancelled = false;
      const attemptId = randomUUID();
      const item = {
        packageId: ref.scope.packageId,
        cancel: () => {
          cancelled = true;
          client.revoke();
          child?.stdin.write(
            JSON.stringify({
              protocolVersion: 1,
              kind: "cancel",
              requestId: request.requestId,
            }) + "\n",
          );
        },
      };
      active.set(request.requestId, item);
      try {
        if (tempRoot) {
          if (!cleanup) throw fail("collection_worker_protocol");
          workingDir = path.join(tempRoot, attemptId);
          await cleanup?.register({
            scope: ref.scope,
            activityId: ref.activityId,
            attemptId,
            relativePath: attemptId,
          });
          await fs.mkdir(workingDir, { recursive: true });
        }
        const args = ["-I", "-B", "-u", runtime.workerPath];
        if (cancelled || signal?.aborted)
          throw fail("collection_worker_cancelled");
        child = spawn(runtime.python, args, {
          cwd: runtime.root,
          env: workerEnvironment(process.env, runtime.root),
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        exitPromise = new Promise((resolve) => child.once("exit", resolve));
        const value = await new Promise((resolve, reject) => {
          const rejectFixed = (code) => reject(fail(code));
          item.cancel = () => {
            cancelled = true;
            client.revoke();
            child.stdin.write(
              JSON.stringify({
                protocolVersion: 1,
                kind: "cancel",
                requestId: request.requestId,
              }) + "\n",
            );
            rejectFixed("collection_worker_cancelled");
          };
          const reader = createJsonLineReader({
            onMessage: (message) => {
              if (result) {
                rejectFixed("collection_worker_protocol");
                return;
              }
              if (
                message.requestId !== request.requestId ||
                message.protocolVersion !== 1
              ) {
                rejectFixed("collection_worker_protocol");
                return;
              }
              if (message.kind === "grant_request") {
                const seq = message.sequence;
                if (
                  !Number.isSafeInteger(seq) ||
                  seq !== lastSequence + 1 ||
                  ++grants > 60 ||
                  !["GET", "HEAD"].includes(message.method) ||
                  !allowsRoute(message.url, request.routePolicy, {
                    resourceType: ["document", "fetch"].includes(
                      message.resourceType,
                    )
                      ? "mainFrame"
                      : message.resourceType,
                  })
                ) {
                  rejectFixed("collection_worker_protocol");
                  return;
                }
                lastSequence = seq;
                try {
                  client.grant(message.url);
                  child.stdin.write(
                    JSON.stringify({
                      protocolVersion: 1,
                      kind: "grant",
                      requestId: request.requestId,
                      sequence: seq,
                      allowed: true,
                    }) + "\n",
                  );
                } catch {
                  rejectFixed("collection_worker_protocol");
                }
              } else if (message.kind === "result") {
                try {
                  result = validateWorkerResult(message, request);
                  if (result.usage.requests !== grants)
                    throw fail("collection_worker_protocol");
                } catch {
                  rejectFixed("collection_worker_protocol");
                }
              } else rejectFixed("collection_worker_protocol");
            },
          });
          child.stdout.on("data", (chunk) => {
            try {
              reader.push(chunk);
            } catch {
              rejectFixed("collection_worker_protocol");
            }
          });
          child.stdin.on("error", () =>
            rejectFixed("collection_worker_crashed"),
          );
          child.stderr.on("data", (chunk) => {
            stderrBytes += chunk.length;
          });
          child.once("error", () => rejectFixed("collection_worker_crashed"));
          child.once("exit", (code) => {
            exited = true;
            try {
              reader.finish();
            } catch {
              rejectFixed("collection_worker_protocol");
              return;
            }
            if (code !== 0 || !result) rejectFixed("collection_worker_crashed");
            else resolve(result);
          });
          signal?.addEventListener("abort", item.cancel, { once: true });
          timer = setTimeout(
            () => rejectFixed("collection_worker_timeout"),
            request.timeoutMs,
          );
          const { routePolicy, publicRoute: ignored, ...frame } = request;
          child.stdin.write(
            JSON.stringify({
              ...frame,
              control: {
                proxy: {
                  server: proxy.proxyUrl,
                  username: client.username,
                  password: client.password,
                },
                browserPath: runtime.browsers?.[mode],
                tempDir: workingDir,
              },
            }) + "\n",
          );
        });
        client.revoke();
        // The complete request allowance stays charged: Chromium internal requests
        // cannot be independently proven from a CONNECT tunnel. Verified bytes settle.
        await ledger.settle({
          ref,
          operationLease,
          reservationId: reservation.reservationId,
          verifiedUsage: {
            requests: mode === "static" ? grants : 60,
            bytes: client.snapshot().bytes,
          },
        });
        settled = true;
        return {
          ...value,
          usage: {
            ...value.usage,
            reservedRequests: mode === "static" ? grants : 60,
            wireBytes: client.snapshot().bytes,
            requestCountMode:
              mode === "static" ? "verified" : "conservative_upper_bound",
          },
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", item.cancel);
        client.revoke();
        try {
          if (child && !exited) {
            if (!child.stdin.destroyed)
              child.stdin.write(
                JSON.stringify({
                  protocolVersion: 1,
                  kind: "cancel",
                  requestId: request.requestId,
                }) + "\n",
              );
            let grace;
            await Promise.race([
              exitPromise,
              new Promise((resolve) => (grace = setTimeout(resolve, 3000))),
            ]);
            clearTimeout(grace);
            if (!exited) await terminateTree(child);
          }
        } finally {
          active.delete(request.requestId);
          await cleanup?.cleanupAttempt(attemptId);
        }
        // Only fixed metadata is eligible for diagnostics; never forward stderr.
        void diagnostics;
        void stderrBytes;
        void settled;
        void clock;
      }
    },
    async closePackage(packageId) {
      generations.set(packageId, (generations.get(packageId) || 0) + 1);
      while ([...preparing.values()].includes(packageId))
        await new Promise((r) => setTimeout(r, 20));
      const items = [...active.values()].filter(
        (i) => i.packageId === packageId,
      );
      for (const i of items) i.cancel();
      while ([...active.values()].some((i) => i.packageId === packageId))
        await new Promise((r) => setTimeout(r, 20));
      for (const key of enhancements)
        if (key.startsWith(packageId + ":")) enhancements.delete(key);
    },
    async stop() {
      stopped = true;
      while (preparing.size) await new Promise((r) => setTimeout(r, 20));
      for (const i of active.values()) i.cancel();
      while (active.size) await new Promise((r) => setTimeout(r, 20));
      await egressProxy.stop?.();
    },
    snapshot: () => ({ workers: active.size }),
  };
  return service;
}
