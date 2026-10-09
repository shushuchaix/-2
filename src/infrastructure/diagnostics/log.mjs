import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  token,
  identifier,
  cleanMetadata,
  cleanParser,
  defaultRuntime,
} from "./fields.mjs";
const contextStorage = new AsyncLocalStorage();
export function withDiagnosticContext(context, action) {
  return contextStorage.run(
    { ...contextStorage.getStore(), ...cleanMetadata(context) },
    action,
  );
}

/** Observers are optional and must never change the operation they describe. */
export async function recordDiagnostic(diagnostics, event, error) {
  let timer;
  try {
    const metadata = { ...contextStorage.getStore(), ...event };
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
  const code = token(error.code),
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
    ...(cleanMetadata(error).phase
      ? { phase: cleanMetadata(error).phase }
      : {}),
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
    previous = path.join(dir, "application.previous.log");
  let queue = Promise.resolve(),
    memory = [],
    storage = { mode: "file" },
    ioDisabled = false,
    pendingWrites = 0;
  const sessionId = "s-" + randomUUID();
  const safeRuntime = cleanMetadata({ runtime }).runtime || {};
  const failed = () => {
    storage = {
      mode: "memory",
      message:
        "日志文件写入或读取失败或超时，请检查目录权限和可用空间；当前日志暂存在内存，关闭软件后可能丢失，请先导出后重启软件。",
    };
  };
  async function boundedIO(action) {
    let timer,
      expired = false;
    const timeoutError = () =>
      Object.assign(new Error("Diagnostic IO timeout"), {
        code: "diagnostic_io_timeout",
      });
    const check = () => {
      if (expired || ioDisabled) throw timeoutError();
    };
    try {
      return await Promise.race([
        Promise.resolve().then(() => action(check)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            ioDisabled = true;
            reject(timeoutError());
          }, 500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
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
  async function collect(options = {}) {
    await queue;
    const entries = new Map();
    let damagedLines = 0,
      rotated = false;
    for (const filename of [previous, file]) {
      if (ioDisabled) break;
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
        if (filename === previous) rotated = true;
        damagedLines += records.damagedLines;
        for (const entry of records.entries)
          entries.set(entry.diagnosticId, entry);
      } catch (error) {
        if (error.code !== "ENOENT") failed();
      }
    }
    for (const entry of memory) entries.set(entry.diagnosticId, entry);
    const matching = [...entries.values()]
      .filter((entry) => {
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
      storage: { ...storage },
      file: "logs/application.log",
      runtime: safeRuntime,
      retention: {
        fileCount: 2,
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
      let entry;
      try {
        entry = cleanEntry(
          { ...contextStorage.getStore(), ...event },
          error,
          clock,
          sessionId,
        );
        if (ioDisabled) return entry;
        const line = JSON.stringify(entry) + "\n";
        if (Buffer.byteLength(line) > Math.min(16384, maxFileBytes))
          return entry;
        fsSync.mkdirSync(dir, { recursive: true });
        let size = 0;
        try {
          size = fsSync.statSync(file).size;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (size + Buffer.byteLength(line) > maxFileBytes) {
          try {
            fsSync.unlinkSync(previous);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          try {
            fsSync.renameSync(file, previous);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        fsSync.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
      } catch {
        failed();
      }
      return entry;
    },
    async record(event = {}, error) {
      const entry = cleanEntry(
        { ...contextStorage.getStore(), ...event },
        error,
        clock,
        sessionId,
      );
      memory =
        maxMemoryEntries > 0 ? [...memory, entry].slice(-maxMemoryEntries) : [];
      // A stalled filesystem must not retain an unbounded chain of entries.
      if (ioDisabled || pendingWrites >= 256) {
        ioDisabled = true;
        failed();
        return entry;
      }
      pendingWrites++;
      const write = queue.then(() => {
        if (ioDisabled) return;
        return boundedIO(async (check) => {
          const line = JSON.stringify(entry) + "\n";
          // Bound an entry too, even when a long stack is supplied.
          if (Buffer.byteLength(line) > Math.min(16384, maxFileBytes)) return;
          await fsAdapter.mkdir(dir, { recursive: true });
          check();
          let size = 0;
          try {
            size = (await fsAdapter.stat(file)).size;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          check();
          if (size + Buffer.byteLength(line) > maxFileBytes) {
            await fsAdapter.unlink(previous).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
            check();
            await fsAdapter.rename(file, previous).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
            check();
          }
          await fsAdapter.appendFile(file, line, {
            encoding: "utf8",
            mode: 0o600,
          });
          check();
          storage = { mode: "file" };
        });
      });
      queue = write.catch(failed).finally(() => pendingWrites--);
      await queue;
      return entry;
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
