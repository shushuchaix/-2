import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const messages = {
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
};
const token = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.@-]{1,160}$/.test(value)
    ? value
    : undefined;
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
  ].includes(value)
    ? value
    : /^r-[A-Za-z0-9_-]+\.json$/.test(String(value)) ||
        value === "runs-v2/*.json"
      ? "runs-v2/*.json"
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
  ];
  const frames = String(error.stack || "")
    .split("\n")
    .slice(1, 16)
    .flatMap((line) => {
      const local = line
        .replace(/\\/g, "/")
        .match(/(?:src|electron|public\/js)\/[A-Za-z0-9_./-]+:\d+:\d+/);
      const native = line.match(/node:[A-Za-z0-9_./-]+:\d+:\d+/);
      return local || native ? ["at " + (local || native)[0]] : [];
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
  const safe = cleanEntry(entry, null, { now: () => Date.parse(entry.at) });
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
function cleanEntry(event, error, clock) {
  const operation = Object.hasOwn(messages, event.operation)
    ? event.operation
    : "http.request";
  const result = {
    diagnosticId: "d-" + randomUUID(),
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
  for (const key of ["runId", "sourceId", "siteId", "code"])
    if (token(event[key])) result[key] = event[key];
  if (stages.has(event.stage)) result.stage = event.stage;
  for (const key of [
    "durationMs",
    "recordCount",
    "httpStatus",
    "retryCount",
    "retryDelayMs",
  ])
    if (Number.isSafeInteger(event[key]) && event[key] >= 0)
      result[key] = event[key];
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
  maxFileBytes = 2 * 1024 * 1024,
  maxMemoryEntries = 500,
}) {
  dataDir = path.resolve(dataDir);
  const dir = path.join(dataDir, "logs"),
    file = path.join(dir, "application.log"),
    previous = path.join(dir, "application.previous.log");
  let queue = Promise.resolve(),
    memory = [],
    storage = { mode: "file" };
  const failed = () => {
    storage = {
      mode: "memory",
      message:
        "日志文件写入或读取失败，请检查目录权限和可用空间；当前日志暂存在内存，关闭软件后可能丢失，请先导出。",
    };
  };
  return {
    dataDir,
    async record(event = {}, error) {
      const entry = cleanEntry(event, error, clock);
      memory = [...memory, entry].slice(-maxMemoryEntries);
      const write = queue.then(async () => {
        const line = JSON.stringify(entry) + "\n";
        // Bound an entry too, even when a long stack is supplied.
        if (Buffer.byteLength(line) > maxFileBytes) return;
        await fsAdapter.mkdir(dir, { recursive: true });
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
        storage = { mode: "file" };
      });
      queue = write.catch(failed);
      await queue;
      return entry;
    },
    async list({ runId, limit = 200 } = {}) {
      await queue;
      const entries = new Map();
      for (const filename of [previous, file]) {
        let handle;
        try {
          handle = await fsAdapter.open(filename, "r");
          const size = (await handle.stat()).size;
          const start = Math.max(0, size - maxFileBytes),
            buffer = Buffer.alloc(Math.min(size, maxFileBytes));
          await handle.read(buffer, 0, buffer.length, start);
          const lines = buffer.toString("utf8").split("\n");
          if (start) lines.shift();
          for (const line of lines) {
            try {
              const entry = storedEntry(JSON.parse(line));
              if (entry) entries.set(entry.diagnosticId, entry);
            } catch {
              /* Ignore interrupted or damaged diagnostic lines. */
            }
          }
        } catch (error) {
          if (error.code !== "ENOENT") failed();
        } finally {
          await handle?.close().catch(() => {});
        }
      }
      for (const entry of memory) entries.set(entry.diagnosticId, entry);
      return {
        entries: [...entries.values()]
          .filter((entry) => !runId || entry.runId === runId)
          .sort((a, b) => a.at.localeCompare(b.at))
          .slice(
            -Math.min(
              200,
              Math.max(1, Number.isSafeInteger(limit) ? limit : 200),
            ),
          )
          .reverse(),
        storage: { ...storage },
        file: "logs/application.log",
      };
    },
    async exportText(options) {
      const result = await this.list(options);
      return (
        [
          "简历岗位雷达运行诊断（已省略私人内容）",
          result.storage.message || "日志文件：" + result.file,
          ...result.entries.map((entry) => JSON.stringify(entry)),
        ].join("\n") + "\n"
      );
    },
  };
}
