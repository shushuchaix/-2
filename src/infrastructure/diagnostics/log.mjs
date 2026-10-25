import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  withDiagnosticLogTurn,
  withDiagnosticFatalTurn,
  getDiagnosticFatalFailureFacts,
} from "./coordination.mjs";
import {
  token,
  identifier,
  cleanMetadata,
  cleanParser,
  defaultRuntime,
} from "./fields.mjs";
const contextStorage = new AsyncLocalStorage();
const storageFailureCodes = new Set([
  "EACCES", "EPERM", "EBUSY", "ENOSPC", "EIO", "ENOENT", "EEXIST",
  "EMFILE", "ENFILE", "EROFS", "EINVAL", "EBADF", "ENOTDIR", "EISDIR",
  "ENAMETOOLONG", "EFBIG", "ENOTSUP", "EXDEV",
  "diagnostic_lock_lost", "diagnostic_lock_busy", "diagnostic_lock_timeout",
  "diagnostic_io_timeout", "diagnostic_queue_full", "diagnostic_entry_too_large",
  "diagnostic_filesystem_stalled", "diagnostic_storage_error",
]);
const storageFailurePhases = new Set([
  "storage", "normal_queue", "normal_directory", "normal_turn", "fatal_prepare",
  "fatal_turn", "read_queue", "read_file", "normal_observer", "entry_size", "queue",
]);
function storageFailureCode(error) {
  try {
    const code = error?.code;
    return storageFailureCodes.has(code) ? code : "diagnostic_storage_error";
  } catch {
    return "diagnostic_storage_error";
  }
}
// This accepts only module-owned, frozen facts, never external error metadata.
// Keep the export surface explicit even when more internal observations exist.
function copyFatalFailureFacts(facts) {
  return Object.freeze({
    configuredTimeoutMs: facts.configuredTimeoutMs,
    acquisitionElapsedMs: facts.acquisitionElapsedMs,
    prepareCallElapsedMs: facts.prepareCallElapsedMs,
    acquireProbeCount: facts.acquireProbeCount,
    totalWaitRequestedMs: facts.totalWaitRequestedMs,
    actualWaitMs: facts.actualWaitMs,
    lastStage: facts.lastStage,
  });
}
const runtimeGlobalOperations = new Set([
  "application.start",
  "application.migration",
  "application.recovery",
  "application.shutdown",
  "desktop.start",
  "desktop.ready",
  "desktop.load",
  "desktop.failure",
]);
const explicitGlobalStorageOperations = new Set([
  "storage.read",
  "storage.write",
  "storage.transaction",
  "storage.recovered",
]);
const businessContextKeys = [
  "runId",
  "sourceId",
  "siteId",
  "jobId",
  "activityId",
  "sliceRunId",
  "unitId",
  "packageId",
  "ownerPackageId",
  "ownerPackageIds",
  "targetRevisionId",
  "scope",
  "package",
  "target",
  "owner",
  "targetId",
  "profileId",
  "profileRevisionId",
  "recordId",
  "operationId",
  "applicationId",
  "route",
  "session",
  "sessionRef",
  "sessionRefs",
  "sessionScope",
  "sessionKey",
  "cookies",
  "cookie",
];
function hasBusinessContext(value, diagnosticSessionId) {
  return (
    value?.businessContext === true ||
    businessContextKeys.some((key) => Object.hasOwn(value, key)) ||
    (Object.hasOwn(value, "sessionId") &&
      !(
        identifier(value.sessionId, "s") &&
        value.sessionId === diagnosticSessionId
      ))
  );
}
function diagnosticMetadata(event) {
  const inherited = contextStorage.getStore();
  const metadata = { ...inherited, ...event };
  if (inherited?.businessContext === true) metadata.businessContext = true;
  return metadata;
}
function isRuntimeGlobal(entry) {
  return (
    !hasBusinessContext(entry, entry.sessionId) &&
    (runtimeGlobalOperations.has(entry.operation) ||
      (explicitGlobalStorageOperations.has(entry.operation) &&
        entry.runtimeGlobal === true))
  );
}
export function withDiagnosticContext(context, action) {
  const metadata = diagnosticMetadata(cleanMetadata(context));
  if (hasBusinessContext(context)) metadata.businessContext = true;
  return contextStorage.run(metadata, action);
}

/** Observers are optional and must never change the operation they describe. */
export async function recordDiagnostic(diagnostics, event, error) {
  let timer;
  try {
    const metadata = diagnosticMetadata(event);
    const write =
      typeof diagnostics === "function"
        ? diagnostics(metadata, error)
        : diagnostics?.record(metadata, error);
    return await Promise.race([
      write,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), 500);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
export { safeApiRoute } from "../../../public/js/diagnostic-rules.js";

const messages = {
  "collection.plan": "采集活动计划已生成。",
  "collection.page": "采集页面已提交。",
  "collection.body": "招聘正文检查已结束。",
  "collection.application": "投递入口核验已结束。",
  "collection.attachment": "招聘附件解析已结束。",
  "collection.qualification": "招聘资格检查已结束。",
  "collection.dedup": "招聘去重检查已结束。",
  "collection.finish": "采集活动批次已结束。",
  "run.started": "招聘更新任务已启动。",
  "run.stage": "任务进入下一阶段。",
  "run.source": "来源采集已返回。",
  "run.collect": "来源采集失败。",
  "run.detail": "岗位详情未取得，保留已有记录。",
  "run.detail.insufficient": "原网站未提供完整岗位要求，已保留列表信息。",
  "run.ingest": "岗位记录处理失败。",
  "run.counts": "任务进度保存失败。",
  "run.events": "任务事件保存失败。",
  "run.failed": "招聘更新任务未完成。",
  "run.finished": "招聘更新任务已结束。",
  "run.snapshot": "任务快照保存失败。",
  "http.request": "操作请求未完成。",
  "source.probe": "招聘来源检查已返回。",
  "source.settings": "招聘来源设置已保存。",
  "desktop.start": "桌面程序已启动。",
  "desktop.failure": "桌面程序启动失败。",
  "storage.write": "工作区写入未完成。",
  "storage.recovered": "文件短暂无法替换，自动重试后已保存。",
  "storage.read": "工作区读取检查已返回。",
  "storage.transaction": "工作区事务已结束。",
  "application.start": "工作区启动检查已结束。",
  "application.migration": "历史数据迁移检查已结束。",
  "application.recovery": "工作区恢复检查已结束。",
  "application.shutdown": "应用关闭资源检查。",
  "application.settings": "设置保存操作已结束。",
  "application.backup": "备份操作已结束。",
  "application.restore": "恢复备份操作已结束。",
  "run.plan": "招聘采集计划已生成。",
  "run.stage.finished": "任务阶段已结束。",
  "run.page": "来源页面解析已返回。",
  "run.batch": "岗位批次已处理。",
  "run.cancel": "已请求取消任务。",
  "run.poll": "任务取消检查未完成。",
  "run.detail.result": "岗位详情检查已返回。",
  "run.expansion": "招聘公告展开已结束。",
  "network.request": "外部请求已结束。",
  "network.attempt": "外部请求尝试已返回。",
  "network.retry": "外部请求安排重试。",
  "network.redirect": "外部请求发生重定向。",
  "network.cache": "外部请求命中缓存。",
  "network.dns": "域名解析检查已返回。",
  "model.request": "模型请求已返回。",
  "model.result": "模型结果处理已结束。",
  "model.fallback": "模型处理已降级。",
  "model.validation": "模型结果校验已结束。",
  "desktop.ready": "桌面程序初始化已完成。",
  "desktop.load": "桌面页面加载检查已返回。",
  "desktop.renderer": "桌面渲染进程发生异常。",
  "desktop.preload": "桌面预加载发生异常。",
  "desktop.credentials": "桌面凭据操作已返回。",
  "renderer.request": "界面请求发生异常。",
  "renderer.stream": "界面任务事件连接发生异常。",
  "renderer.failure": "界面运行发生异常。",
  "profile.preview": "简历导入预览检查已返回。",
};
const stages = new Set([
  "queued",
  "planning",
  "collecting",
  "details",
  "expanding",
  "evaluating",
  "finished",
  "startup",
]);
const safeResource = (value) =>
  [
    "workspace.v2.json",
    "workspace.v2.previous.json",
    "workspace.sqlite",
    "control/state.json",
    "control/initialized.json",
    ".workspace.lock",
    "quota.json",
    "config.json",
    "credentials.json",
  ].includes(value)
    ? value
    : /^r-[A-Za-z0-9_-]+\.json$/.test(String(value)) ||
        value === "runs-v2/*.json"
      ? "runs-v2/*.json"
      : /^((backup|restore)-[A-Za-z0-9_-]+\.json)$/.test(String(value)) ||
          value === "backups/*.json"
        ? "backups/*.json"
        : undefined;
const errorMessages = [
  "Missing sourceId",
  "Missing source title",
  "Invalid source url",
  "Invalid source kind/type",
  "Invalid source evidence/cities",
  "Invalid date",
  "Unresolved identity collision",
  "Run not found",
  "Invalid workspace",
  "Corrupt workspace JSON",
  "Workspace busy",
  "Run snapshot immutable",
  "Unsupported workspace schema",
  "Unexpected network",
  "Job not found",
  "Source not found",
  "Site not found for provider",
  "Cannot read properties of undefined",
  "Cannot read properties of null",
];
export function diagnosticError(error, depth = 0) {
  if (!error) return undefined;
  const metadata = cleanMetadata(error),
    code = token(error.code),
    status = Number(
      error.status ||
        String(error.message || "").match(/\bHTTP\s+(\d{3})\b/)?.[1],
    );
  const known = errorMessages.find((message) =>
    String(error.message || "").startsWith(message),
  );
  const names = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "AbortError",
    "TimeoutError",
    "DeepSeekError",
  ];
  const frames = String(error.stack || "")
    .split("\n")
    .slice(1, 16)
    .flatMap((line) => {
      const local = line
        .replace(/\\/g, "/")
        .match(/(?:src|electron|public\/js)\/[A-Za-z0-9_./-]+:\d+:\d+/);
      const native = line.match(/node:[A-Za-z0-9_./-]+:\d+:\d+/);
      const frame = (local || native)?.[0];
      return frame && frame.length <= 240 ? ["at " + frame] : [];
    });
  const basename = path.basename(
    String(error.dest || error.path || "").replace(/\\/g, "/"),
  );
  const resource = safeResource(basename);
  return {
    name: names.includes(error.name) ? error.name : "Error",
    ...(code ? { code } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    message:
      known ||
      (Number.isInteger(status) && status >= 100 && status <= 599
        ? "HTTP " + status
        : null) ||
      (code
        ? "底层错误：" + code
        : "异常内容已省略，使用错误类型及调用位置定位。"),
    ...(frames.length ? { stack: frames.join("\n") } : {}),
    ...([
      "open",
      "write",
      "fsync",
      "close",
      "rename",
      "unlink",
      "mkdir",
      "read",
      "stat",
    ].includes(error.syscall)
      ? { syscall: error.syscall }
      : {}),
    ...(resource ? { resource } : {}),
    ...(metadata.phase
      ? { phase: metadata.phase }
      : {}),
    ...(metadata.contractStage ? { contractStage: metadata.contractStage } : {}),
    ...(metadata.contractReason ? { contractReason: metadata.contractReason } : {}),
    ...(identifier(error.requestId, "q") ? { requestId: error.requestId } : {}),
    ...(["requests", "details"].includes(error.budgetKind)
      ? { budgetKind: error.budgetKind }
      : {}),
    ...(cleanParser(error.parser) ? { parser: cleanParser(error.parser) } : {}),
    ...(depth < 2 && error.cause
      ? { cause: diagnosticError(error.cause, depth + 1) }
      : {}),
    ...(token(error.storageOperation)
      ? { storageOperation: error.storageOperation }
      : {}),
    ...(Number.isSafeInteger(error.retryCount) &&
    error.retryCount >= 0 &&
    error.retryCount <= 6
      ? { retryCount: error.retryCount }
      : {}),
  };
}
function storedEntry(entry) {
  if (
    !entry ||
    !/^d-[a-f0-9-]{36}$/.test(entry.diagnosticId) ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(entry.at) ||
    !Number.isFinite(Date.parse(entry.at)) ||
    !Object.hasOwn(messages, entry.operation)
  )
    return null;
  const safe = cleanEntry(
    entry,
    null,
    { now: () => Date.parse(entry.at) },
    entry.sessionId,
  );
  safe.diagnosticId = entry.diagnosticId;
  if (entry.error && typeof entry.error === "object") {
    const original = entry.error;
    safe.error = diagnosticError({
      ...original,
      path: original.resource,
      stack: "\n" + String(original.stack || ""),
    });
    if (original.cause)
      safe.error.cause = diagnosticError({
        ...original.cause,
        stack: "\n" + String(original.cause.stack || ""),
      });
  }
  return safe;
}
function cleanEntry(event, error, clock, sessionId) {
  const operation = Object.hasOwn(messages, event.operation)
    ? event.operation
    : "http.request";
  const result = {
    diagnosticId: "d-" + randomUUID(),
    schemaVersion: 2,
    ...(identifier(sessionId, "s") ? { sessionId } : {}),
    at: new Date(clock.now()).toISOString(),
    level:
      error?.code === "detail_insufficient" && event.level !== "error"
        ? "warn"
        : error || event.level === "error"
          ? "error"
          : event.level === "warn"
            ? "warn"
            : "info",
    operation,
    message: messages[operation],
  };
  Object.assign(result, cleanMetadata(event));
  // Preserve ownership presence before unknown IDs/scopes are redacted. It is
  // deliberately monotonic across nested contexts and stored-entry cleaning.
  if (hasBusinessContext(event, sessionId)) result.businessContext = true;
  if (
    (runtimeGlobalOperations.has(operation) ||
      explicitGlobalStorageOperations.has(operation)) &&
    typeof event.runtimeGlobal === "boolean"
  )
    result.runtimeGlobal = event.runtimeGlobal;
  if (safeResource(event.resource))
    result.resource = safeResource(event.resource);
  if (error) result.error = diagnosticError(error);
  return result;
}

/** Only explicit diagnostic fields are recorded. Request bodies and console output never enter this log. */
export function createDiagnosticsLog({
  dataDir,
  clock = { now: Date.now },
  fsAdapter = fs,
  maxFileBytes = 4 * 1024 * 1024,
  maxMemoryEntries = 1000,
  runtime = defaultRuntime(),
}) {
  dataDir = path.resolve(dataDir);
  const dir = path.join(dataDir, "logs"),
    file = path.join(dir, "application.log"),
    previous = path.join(dir, "application.previous.log"),
    fatalFile = path.join(dir, "application.fatal.log"),
    fatalPrevious = path.join(dir, "application.fatal.previous.log"),
    logTurn = path.join(dir, ".application.lock"),
    fatalTurn = path.join(dir, ".application-fatal.lock");
  let queue = Promise.resolve(),
    memory = [],
    storage = { mode: "file" },
    ioStalled = false,
    pendingWrites = 0,
    droppedWrites = 0,
    failedWrites = 0,
    enqueuedWrites = 0,
    rejectedThrough = 0;
  const sessionId = "s-" + randomUUID();
  const safeRuntime = cleanMetadata({ runtime }).runtime || {};
  const readSnapshots = new WeakMap();
  const activeNativeIO = new Set();
  async function nativeIO(action) {
    const operation = { startedAt: Date.now() };
    activeNativeIO.add(operation);
    try {
      return await action();
    } finally {
      activeNativeIO.delete(operation);
    }
  }
  // Include handle IO used by the shared lock primitives. Waiting for another
  // live owner alone is not a stalled filesystem and must not disable fatal IO.
  const tracked = (object) =>
    new Proxy(object, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args) =>
          nativeIO(async () => {
            const result = await Reflect.apply(value, target, args);
            return key === "open" ? tracked(result) : result;
          });
      },
    });
  fsAdapter = tracked(fsAdapter);
  const remember = (entry) => {
    memory =
      maxMemoryEntries > 0 ? [...memory, entry].slice(-maxMemoryEntries) : [];
  };
  const failed = (error, phase = "storage") => {
    const facts = getDiagnosticFatalFailureFacts(error);
    storage = {
      mode: "memory",
      failureCode: storageFailureCode(error),
      failurePhase: storageFailurePhases.has(phase) ? phase : "storage",
      ...(facts ? { failureFacts: copyFatalFailureFacts(facts) } : {}),
      message:
        "日志文件写入或读取失败或超时，请检查目录权限和可用空间；当前日志暂存在内存，关闭软件后可能丢失，请先导出后重启软件。",
    };
  };
  async function boundedIO(action, onTimeout) {
    let timer,
      observerWake,
      expired = false;
    const timeoutError = () =>
      Object.assign(new Error("Diagnostic IO timeout"), {
        code: "diagnostic_io_timeout",
      });
    const check = () => {
      if (expired) throw timeoutError();
    };
    try {
      return await Promise.race([
        Promise.resolve().then(() => action(check)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            // Short, completed lock probes are contention. Only a native call
            // pending for almost the full deadline marks a filesystem stall;
            // allow 50ms for timer/microtask scheduling around the observer.
            if (
              [...activeNativeIO].some(
                (operation) => Date.now() - operation.startedAt >= 450,
              )
            )
              ioStalled = true;
            if (onTimeout) {
              // Stop only an acquisition which owns no turn yet. Let its
              // rejection/queue bookkeeping settle in this event-loop turn;
              // native IO or a held turn remains owned until it really ends.
              onTimeout();
              observerWake = setImmediate(() => reject(timeoutError()));
            } else reject(timeoutError());
          }, 500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearImmediate(observerWake);
    }
  }
  function category(entry) {
    const name = entry.operation.split(".")[0];
    return name === "renderer"
      ? "desktop"
      : name === "profile"
        ? "application"
        : name;
  }
  async function readRetained() {
    await boundedIO(() => queue).catch((error) => failed(error, "read_queue"));
    const entries = new Map();
    let damagedLines = 0,
      rotated = false;
    for (const filename of [previous, file, fatalPrevious, fatalFile]) {
      try {
        const records = await boundedIO(async (check) => {
          let handle;
          try {
            handle = await fsAdapter.open(filename, "r");
            check();
            const size = (await handle.stat()).size;
            check();
            const start = Math.max(0, size - maxFileBytes),
              buffer = Buffer.alloc(Math.min(size, maxFileBytes));
            await handle.read(buffer, 0, buffer.length, start);
            check();
            const lines = buffer.toString("utf8").split("\n");
            if (start) lines.shift();
            const result = { entries: [], damagedLines: 0 };
            for (const line of lines.filter(Boolean)) {
              try {
                const entry = storedEntry(JSON.parse(line));
                if (entry) result.entries.push(entry);
                else result.damagedLines++;
              } catch {
                result.damagedLines++;
              }
            }
            return result;
          } finally {
            await handle?.close().catch(() => {});
          }
        });
        if (filename === previous || filename === fatalPrevious) rotated = true;
        damagedLines += records.damagedLines;
        for (const entry of records.entries)
          entries.set(entry.diagnosticId, entry);
      } catch (error) {
        if (error.code !== "ENOENT") failed(error, "read_file");
      }
    }
    for (const entry of memory) entries.set(entry.diagnosticId, entry);
    return { entries: [...entries.values()], damagedLines, rotated };
  }
  async function collect(options = {}) {
    let records;
    if (options.readSnapshot !== undefined) {
      records = readSnapshots.get(options.readSnapshot);
      if (!records)
        throw Object.assign(Error("Unknown diagnostic read snapshot"), {
          code: "diagnostic_snapshot_invalid",
        });
    } else records = await readRetained();
    const { entries, damagedLines, rotated } = records;
    // Internal scope callers supply an already-authorized run allowlist. The
    // HTTP boundary still validates its own filters; a malformed allowlist is
    // empty, never an instruction to expose every run. Filter before limiting.
    const runIds =
      options.runIds === undefined
        ? null
        : new Set(Array.isArray(options.runIds) ? options.runIds : []);
    const includeRuntimeGlobals =
      Array.isArray(options.runIds) && options.includeRuntimeGlobals === true;
    const matching = entries
      .filter((entry) => {
        if (
          runIds &&
          !runIds.has(entry.runId) &&
          !(includeRuntimeGlobals && isRuntimeGlobal(entry))
        )
          return false;
        for (const key of [
          "runId",
          "sourceId",
          "siteId",
          "diagnosticId",
          "requestId",
        ])
          if (options[key] && entry[key] !== options[key]) return false;
        if (
          options.level === "problem" &&
          !["warn", "error"].includes(entry.level)
        )
          return false;
        if (
          options.level &&
          options.level !== "problem" &&
          entry.level !== options.level
        )
          return false;
        return !options.category || category(entry) === options.category;
      })
      .sort((a, b) => a.at.localeCompare(b.at));
    return { matching, damagedLines, rotated };
  }
  function resultFor(records, limit, reverse = true) {
    const { matching, damagedLines, rotated } = records;
    const entries = matching.slice(-limit);
    return {
      entries: reverse ? entries.reverse() : entries,
      storage: { ...storage, pendingWrites, droppedWrites, failedWrites },
      file: "logs/application.log",
      runtime: safeRuntime,
      retention: {
        fileCount: 4,
        normalFileCount: 2,
        fatalFileCount: 2,
        maxFileBytes,
        maxMemoryEntries,
        maxEntryBytes: 16384,
        exportMode: "retained",
      },
      summary: {
        total: matching.length,
        returned: entries.length,
        truncated: matching.length > limit,
        errors: matching.filter((e) => e.level === "error").length,
        warnings: matching.filter((e) => e.level === "warn").length,
        oldestAt: matching[0]?.at || null,
        newestAt: matching.at(-1)?.at || null,
        damagedLines,
        rotated,
      },
    };
  }
  return {
    dataDir,
    // Only the fatal monitor uses synchronous IO, before Node exits by default.
    recordFatal(event = {}, error) {
      let entry, failurePhase = "fatal_prepare";
      try {
        entry = cleanEntry(diagnosticMetadata(event), error, clock, sessionId);
        remember(entry);
        const line = JSON.stringify(entry) + "\n";
        if (
          ioStalled ||
          Buffer.byteLength(line) > Math.min(16384, maxFileBytes)
        ) {
          droppedWrites++;
          failed({ code: ioStalled ? "diagnostic_filesystem_stalled" : "diagnostic_entry_too_large" }, ioStalled ? "fatal_prepare" : "entry_size");
          return entry;
        }
        fsSync.mkdirSync(dir, { recursive: true });
        // A synchronous fatal monitor cannot wait for this thread's pending
        // normal append. Its independent, fixed two-file channel is also
        // serialized across every main/backend/CLI process.
        failurePhase = "fatal_turn";
        withDiagnosticFatalTurn(fatalTurn, () => {
          let size = 0;
          try {
            size = fsSync.statSync(fatalFile).size;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (size + Buffer.byteLength(line) > maxFileBytes) {
            try {
              fsSync.unlinkSync(fatalPrevious);
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            try {
              fsSync.renameSync(fatalFile, fatalPrevious);
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          fsSync.appendFileSync(fatalFile, line, {
            encoding: "utf8",
            mode: 0o600,
          });
        });
      } catch (failure) {
        failedWrites++;
        failed(failure, failurePhase);
      }
      return entry;
    },
    async record(event = {}, error) {
      const entry = cleanEntry(
        diagnosticMetadata(event),
        error,
        clock,
        sessionId,
      );
      remember(entry);
      // A stalled filesystem must not retain an unbounded chain of entries.
      if (pendingWrites >= 256) {
        droppedWrites++;
        failed({ code: "diagnostic_queue_full" }, "queue");
        return entry;
      }
      pendingWrites++;
      const sequence = ++enqueuedWrites;
      const controller = new AbortController();
      let failurePhase = "normal_queue";
      let waitingForOwner = false;
      // The native write owns its place in the queue until it actually settles.
      // A caller deadline never starts a second writer or abandons a late write.
      const write = queue.then(async () => {
        // Once a completed lock wait fails, already-waiting entries fall back
        // together. They must not each keep a CLI alive for another 500ms.
        // New records can retry; unfinished native writes never enter here.
        if (sequence <= rejectedThrough || controller.signal.aborted)
          throw Object.assign(Error("Diagnostic log ownership unavailable"), {
            code: "diagnostic_lock_timeout",
          });
        const line = JSON.stringify(entry) + "\n";
        // Bound an entry too, even when a long stack is supplied.
        if (Buffer.byteLength(line) > Math.min(16384, maxFileBytes)) {
          droppedWrites++;
          failed({ code: "diagnostic_entry_too_large" }, "entry_size");
          return;
        }
        failurePhase = "normal_directory";
        await fsAdapter.mkdir(dir, { recursive: true });
        try {
          failurePhase = "normal_turn";
          await withDiagnosticLogTurn(logTurn, fsAdapter, async () => {
            let size = 0;
            try {
              size = (await fsAdapter.stat(file)).size;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            if (size + Buffer.byteLength(line) > maxFileBytes) {
              await fsAdapter.unlink(previous).catch((error) => {
                if (error.code !== "ENOENT") throw error;
              });
              await fsAdapter.rename(file, previous).catch((error) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
            await fsAdapter.appendFile(file, line, {
              encoding: "utf8",
              mode: 0o600,
            });
          }, { signal: controller.signal, onWaiting: (waiting) => { waitingForOwner = waiting; } });
        } catch (error) {
          if (error.code === "diagnostic_lock_timeout")
            rejectedThrough = enqueuedWrites;
          throw error;
        }
        ioStalled = false;
        if (!failedWrites && !droppedWrites) storage = { mode: "file" };
      });
      queue = write
        .catch((error) => {
          failedWrites++;
          failed(error, failurePhase);
        })
        .finally(() => pendingWrites--);
      await boundedIO(() => queue, () => {
        if (waitingForOwner) controller.abort();
      }).catch((error) => failed(error, "normal_observer"));
      return entry;
    },
    async captureReadSnapshot() {
      const records = await readRetained();
      const entries = records.entries.map(storedEntry).filter(Boolean);
      const snapshot = Object.freeze({
        runIds: Object.freeze([
          ...new Set(entries.map((entry) => entry.runId).filter(Boolean)),
        ]),
      });
      readSnapshots.set(snapshot, { ...records, entries });
      return snapshot;
    },
    async list(options = {}) {
      return resultFor(
        await collect(options),
        Math.min(
          200,
          Math.max(
            1,
            Number.isSafeInteger(options.limit) ? options.limit : 200,
          ),
        ),
      );
    },
    async exportText(options) {
      const records = await collect(options);
      const result = resultFor(
        records,
        Number.isSafeInteger(options?.limit)
          ? Math.min(5000, Math.max(1, options.limit))
          : Math.max(1, records.matching.length),
        false,
      );
      return (
        [
          "简历岗位雷达运行诊断（已省略私人内容）",
          result.storage.message || "日志文件：" + result.file,
          "持久化状态：" +
            JSON.stringify({ pendingWrites, droppedWrites, failedWrites,
              ...(storage.failureCode ? { failureCode: storage.failureCode, failurePhase: storage.failurePhase } : {}),
              ...(storage.failureFacts ? { failureFacts: copyFatalFailureFacts(storage.failureFacts) } : {}),
            }),
          "运行环境：" + JSON.stringify(result.runtime),
          "保留范围：" +
            JSON.stringify({ ...result.summary, ...result.retention }),
          result.summary.truncated
            ? "导出不完整：超过导出条数上限，仅保留最近的匹配记录。"
            : "已导出当前保留范围内全部匹配记录。",
          result.summary.rotated
            ? "日志已轮转，早于当前保留范围的历史可能已被覆盖。"
            : "日志未检测到轮转历史。",
          result.summary.damagedLines ? "存在损坏日志行，历史可能不完整。" : "",
          ...result.entries.map((entry) => JSON.stringify(entry)),
        ].join("\n") + "\n"
      );
    },
  };
}
