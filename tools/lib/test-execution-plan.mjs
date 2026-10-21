import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const exclusiveFiles = [
  "tests/integration/diagnostics-concurrency.test.mjs",
  "tests/integration/collection-row-lifecycle.test.mjs",
];

/** Leave one CPU when possible; four workers is a resource cap, not a tuned optimum. */
export function selectTestWorkerConcurrency(
  availableParallelism = os.availableParallelism(),
) {
  if (!Number.isSafeInteger(availableParallelism) || availableParallelism < 1)
    throw Error("Invalid test worker parallelism");
  return Math.max(1, Math.min(4, availableParallelism - 1));
}

/** The runner executes and records this same argument array. */
export function createTestWorkerArgs(wave, { root }) {
  if (
    !Array.isArray(wave.files) ||
    !wave.files.length ||
    !Number.isSafeInteger(wave.testConcurrency) ||
    wave.testConcurrency < 1 ||
    wave.testConcurrency > 4 ||
    wave.testConcurrency > wave.files.length
  )
    throw Error("Invalid test worker concurrency");
  return [
    "--import",
    pathToFileURL(path.join(root, "tests/helpers/network-guard.mjs")).href,
    "--test",
    "--test-concurrency=" + wave.testConcurrency,
    ...wave.files.map((file) => path.join(root, file)),
  ];
}

/** Partition the already filtered discovery inventory, without filtering cases. */
export function createTestExecutionPlan(files) {
  const selected = new Set(files);
  const waves = exclusiveFiles
    .filter((file) => selected.has(file))
    .map((file) => ({ name: file, files: [file] }));
  const ordinary = files.filter((file) => !exclusiveFiles.includes(file));
  if (ordinary.length) waves.push({ name: "remaining tests", files: ordinary });
  assertTestExecutionPlan(files, waves);
  return waves;
}

/** Fail closed if a discovered file is duplicated, omitted or added by a plan. */
export function assertTestExecutionPlan(files, waves) {
  const planned = waves.flatMap((wave) => wave.files);
  if (
    !files.length ||
    new Set(files).size !== files.length ||
    planned.length !== files.length ||
    new Set(planned).size !== planned.length ||
    planned.some((file) => !files.includes(file)) ||
    waves.some((wave) => !wave.files.length)
  )
    throw Error(
      "Invalid test execution plan: duplicate, missing or extra file",
    );
}

/** One monotonic budget covers every synchronous wave, including failed waves. */
export function runTestExecutionPlan({
  files,
  waves = createTestExecutionPlan(files),
  executeWave,
  timeoutMs = 300000,
  now = () => performance.now(),
  startedAt = now(),
  onWave = () => {},
  availableParallelism = os.availableParallelism(),
}) {
  assertTestExecutionPlan(files, waves);
  const maxWorkers = selectTestWorkerConcurrency(availableParallelism);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw Error("Invalid test execution timeout");
  const deadline = startedAt + timeoutMs,
    results = [];
  let exhausted = false;
  for (const wave of waves) {
    const testConcurrency = Math.min(maxWorkers, wave.files.length);
    const remaining = Math.floor(deadline - now());
    const record = {
      name: wave.name,
      plannedFiles: [...wave.files],
      testConcurrency,
      // These inventories describe the subprocess boundary. A killed batch
      // cannot establish which individual Node test workers finished.
      launchedFiles: [],
      completedFiles: [],
    };
    if (exhausted || remaining <= 0) {
      exhausted = true;
      Object.assign(record, {
        status: "not_run",
        code: 1,
        reason: "global_deadline_exhausted",
        durationMs: 0,
        notRunFiles: [...wave.files],
      });
    } else {
      const waveStart = now();
      let outcome;
      try {
        outcome = executeWave({ ...wave, testConcurrency, timeoutMs: remaining });
        if (
          !outcome ||
          ![
            "passed",
            "failed",
            "timeout",
            "spawn_blocked",
            "spawn_error",
            "signal",
          ].includes(outcome.status) ||
          !Number.isInteger(outcome.code) ||
          (outcome.status === "passed") !== (outcome.code === 0)
        )
          throw Error("Invalid wave process result");
      } catch {
        outcome = {
          status: "spawn_error",
          code: 1,
          errorCode: "ERR_TEST_EXECUTION",
        };
      }
      Object.assign(record, outcome, {
        name: wave.name,
        plannedFiles: [...wave.files],
        testConcurrency,
        timeoutMs: remaining,
        durationMs: Math.max(0, Math.round(now() - waveStart)),
        launchedFiles: ["spawn_error", "spawn_blocked"].includes(outcome.status)
          ? []
          : [...wave.files],
        completedFiles: ["passed", "failed"].includes(outcome.status)
          ? [...wave.files]
          : [],
      });
      exhausted = outcome.status === "timeout" || now() >= deadline;
    }
    results.push(record);
    onWave(record);
  }
  exhausted ||= now() >= deadline;
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  const failure = results.find((result) => result.code !== 0);
  const timeout = results.find((result) => result.status === "timeout");
  return {
    name: "v2 tests",
    status: timeout || exhausted ? "timeout" : failure?.status || "passed",
    code: timeout || exhausted ? 1 : failure?.code || 0,
    timeoutMs,
    durationMs,
    workerPolicy: { availableParallelism, maxWorkers },
    ...(timeout || exhausted
      ? {
          errorCode: "ETIMEDOUT",
          ...(timeout?.signal ? { signal: timeout.signal } : {}),
        }
      : failure?.errorCode
        ? { errorCode: failure.errorCode }
        : {}),
    ...(failure?.signal && !timeout && !exhausted
      ? { signal: failure.signal }
      : {}),
    plannedFiles: [...files],
    waves: results,
    notRunFiles: results.flatMap((wave) => wave.notRunFiles || []),
    // Bounded human summary; the complete wave inventory remains available.
    failedWaves: results
      .filter((wave) => wave.code !== 0)
      .slice(0, 5)
      .map((wave) => ({
        name: wave.name,
        status: wave.status,
        code: wave.code,
      })),
  };
}
