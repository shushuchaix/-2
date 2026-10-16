import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const childStatuses = new Set([
  "passed",
  "failed",
  "timeout",
  "spawn_blocked",
  "spawn_error",
  "signal",
]);
function resultPath(file, directory) {
  if (
    !file ||
    !directory ||
    path.dirname(path.resolve(file)) !== path.resolve(directory) ||
    !/^suite-[a-z0-9.-]+\.json$/.test(path.basename(file))
  )
    throw Error("Invalid isolated test result path");
  return path.resolve(file);
}
function resultMetadata(value) {
  if (
    !value ||
    !childStatuses.has(value.status) ||
    !Number.isInteger(value.code) ||
    (value.status === "passed") !== (value.code === 0)
  )
    throw Error("Invalid child test result");
  const result = { status: value.status, code: value.code };
  if (
    typeof value.errorCode === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(value.errorCode)
  )
    result.errorCode = value.errorCode;
  if (
    typeof value.signal === "string" &&
    /^SIG[A-Z0-9]{1,20}$/.test(value.signal)
  )
    result.signal = value.signal;
  if (Number.isFinite(value.timeoutMs) && value.timeoutMs > 0)
    result.timeoutMs = value.timeoutMs;
  return result;
}

/** Only nested runner entry points publish this metadata, never test workers. */
export function publishTestResult(result) {
  if (!process.env.RJR_TEST_RESULT_FILE) return;
  const file = resultPath(
    process.env.RJR_TEST_RESULT_FILE,
    process.env.RJR_DATA_DIR,
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, ...resultMetadata(result) }),
    { flag: "wx" },
  );
}

const failureCode = (status) =>
  Number.isInteger(status) && status !== 0 ? status : 1;

function processOutcome(result = {}) {
  const errorCode =
    typeof result.error?.code === "string" ? result.error.code : undefined;
  const base = {
    code: failureCode(result.status),
    ...(errorCode ? { errorCode } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
  };
  // A timed-out child may also have a termination signal; preserve the cause.
  if (errorCode === "ETIMEDOUT") return { ...base, status: "timeout" };
  if (["EPERM", "EACCES"].includes(errorCode))
    return { ...base, status: "spawn_blocked" };
  if (result.error) return { ...base, status: "spawn_error" };
  if (result.signal) return { ...base, status: "signal" };
  if (result.status === 0) return { code: 0, status: "passed" };
  return { ...base, status: "failed" };
}

/** Test-only subprocess boundary: all child tests opt out of local credentials. */
export function runTestProcess({
  name,
  args,
  executable = process.execPath,
  cwd,
  env = {},
  timeoutMs = 300000,
  stdio = "inherit",
  spawn = spawnSync,
  resultFile,
}) {
  const startedAt = performance.now();
  let result;
  try {
    if (resultFile) resultPath(resultFile, env.RJR_DATA_DIR);
    result = spawn(executable, args, {
      cwd,
      stdio,
      timeout: timeoutMs,
      env: {
        ...process.env,
        ...env,
        RJR_DISABLE_LOCAL_CREDENTIALS: "1",
        ...(resultFile ? { RJR_TEST_RESULT_FILE: resultFile } : {}),
      },
    });
  } catch (error) {
    result = { error };
  }
  const outcome = processOutcome(result);
  if (resultFile && ["passed", "failed"].includes(outcome.status)) {
    try {
      const file = resultPath(resultFile, env.RJR_DATA_DIR);
      if (fs.statSync(file).size > 2048)
        throw Error("Oversized child test result");
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw.version !== 1) throw Error("Unknown child test result version");
      const child = resultMetadata(raw);
      if ((outcome.code === 0) !== (child.code === 0))
        throw Error("Child result contradicts process exit");
      Object.assign(outcome, child);
    } catch {
      Object.assign(outcome, {
        status: "runner_error",
        code: 1,
        errorCode: "ERR_TEST_RESULT_INVALID",
      });
    }
  }
  return {
    name,
    timeoutMs,
    ...outcome,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

export function formatTestResult(result) {
  const labels = {
    passed: "通过",
    failed: "非零退出（断言或运行错误，参见套件输出）",
    timeout: "超时",
    spawn_blocked: "启动被权限阻止",
    spawn_error: "进程启动错误",
    signal: "被信号终止",
    runner_error: "运行器结果缺失或不一致",
    prerequisite_failed: "前置构建失败",
    not_run: "未运行：前置构建失败",
    skipped: "跳过",
  };
  const details = [
    result.errorCode,
    result.signal,
    result.reason,
    result.status === "failed" ? "exit=" + result.code : undefined,
    result.status === "timeout"
      ? "limit=" + result.timeoutMs + "ms"
      : undefined,
  ].filter(Boolean);
  return `${result.name}: ${labels[result.status] || "运行器错误"}${details.length ? "（" + details.join(" · ") + "）" : ""}`;
}

/** A failed renderer build is a hard gate; never label unexecuted assertions failed. */
export async function runTestPipeline({
  prerequisite,
  steps,
  runStep,
  onResult = () => {},
}) {
  const results = [];
  const add = (result) => {
    results.push(result);
    onResult(result);
  };
  const startedAt = performance.now();
  try {
    await prerequisite.run();
    add({
      name: prerequisite.name,
      status: "passed",
      code: 0,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    const cause = processOutcome({ error });
    add({
      name: prerequisite.name,
      ...cause,
      status: "prerequisite_failed",
      causeStatus: cause.status,
      reason: error?.message || "UI build failed",
      durationMs: Math.round(performance.now() - startedAt),
    });
    for (const step of steps)
      add({
        name: step.name,
        status: step.skipReason ? "skipped" : "not_run",
        code: step.skipReason ? 0 : 1,
        ...(step.skipReason ? { reason: step.skipReason } : {}),
      });
    return results;
  }
  for (const step of steps) {
    if (step.skipReason) {
      add({
        name: step.name,
        status: "skipped",
        code: 0,
        reason: step.skipReason,
      });
      continue;
    }
    try {
      add(await runStep(step));
    } catch (error) {
      add({
        name: step.name,
        ...processOutcome({ error }),
        reason: error?.message || "Test runner failed",
      });
    }
  }
  return results;
}
