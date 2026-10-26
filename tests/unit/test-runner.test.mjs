import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTestExecutionPlan,
  assertTestExecutionPlan,
  runTestExecutionPlan,
} from "../../tools/lib/test-execution-plan.mjs";
import { runTestProcess } from "../../tools/lib/test-process.mjs";
import {
  assertWorkspace,
  assertSourceRecord,
  createEmptyWorkspace,
} from "../../src/domain/contracts.mjs";
const run = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });
test("offline guard rejects fetch and native https before any connection", () => {
  for (const source of [
    'fetch("https://example.com")',
    'import("node:https").then(h=>h.get("https://example.com"))',
    'import("node:net").then(n=>n.connect(443,"example.com"))',
    'import("node:tls").then(n=>n.connect(443,"example.com"))',
  ]) {
    const r = run([
      "--import",
      "./tests/helpers/network-guard.mjs",
      "--input-type=module",
      "-e",
      source,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /offline_network_forbidden/);
  }
});
test("runner discovers nested tests and rejects outside test paths", () => {
  const r = run(["tools/test-v2.mjs", "--list"]);
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).includes("tests/unit/test-runner.test.mjs"));
  assert.equal(
    run(["tools/test-v2.mjs", "--file", "src/server.mjs"]).status,
    1,
  );
});

test("wave inventory contains every recursively discovered file exactly once", () => {
  const listed = run(["tools/test-v2.mjs", "--list"]);
  assert.equal(listed.status, 0);
  const files = JSON.parse(listed.stdout),
    waves = createTestExecutionPlan(files);
  assert.equal(waves.length, 4);
  assert.deepEqual(
    waves.slice(0, 3).map((wave) => wave.files),
    [
      ["tests/integration/diagnostics-concurrency.test.mjs"],
      ["tests/integration/collection-row-lifecycle.test.mjs"],
      ["tests/integration/purge-typed-planning.test.mjs"],
    ],
  );
  assert.deepEqual(waves.flatMap((wave) => wave.files).sort(), files);
  assert.equal(new Set(waves.flatMap((wave) => wave.files)).size, files.length);
  const selected = "tests/integration/purge-typed-planning.test.mjs";
  assert.deepEqual(
    JSON.parse(run(["tools/test-v2.mjs", "--file", selected, "--list"]).stdout),
    [selected],
  );
  assert.deepEqual(
    createTestExecutionPlan([selected]).map((wave) => wave.files),
    [[selected]],
  );
  const unit = run(["tools/test-v2.mjs", "--group", "unit", "--list"]);
  assert.equal(unit.status, 0);
  const units = JSON.parse(unit.stdout);
  assert.deepEqual(
    units,
    files.filter((file) => file.startsWith("tests/unit/")),
  );
  assert.deepEqual(
    createTestExecutionPlan(units).map((wave) => wave.files),
    [units],
  );
  const integration = run(["tools/test-v2.mjs", "--group", "integration", "--list"]);
  assert.equal(integration.status, 0);
  const integrations = JSON.parse(integration.stdout);
  assert.deepEqual(
    integrations,
    files.filter((file) => file.startsWith("tests/integration/")),
  );
  const integrationWaves = createTestExecutionPlan(integrations);
  assert.deepEqual(integrationWaves.flatMap((wave) => wave.files).sort(), integrations);
  assert.deepEqual(integrationWaves.slice(0, 3).map((wave) => wave.files),
    waves.slice(0, 3).map((wave) => wave.files));
  assert.equal(
    run(["tools/test-v2.mjs", "--group", "unknown", "--list"]).status,
    1,
  );
  assert.equal(
    run([
      "tools/test-v2.mjs",
      "--file",
      "src/server.mjs",
      "--group",
      "unit",
      "--list",
    ]).status,
    1,
  );
  assert.deepEqual(
    JSON.parse(
      run([
        "tools/test-v2.mjs",
        "--file",
        selected,
        "--group",
        "unit",
        "--list",
      ]).stdout,
    ),
    [],
  );
});

test("wave inventory rejects omission, duplication, extra files and empty waves", () => {
  const files = ["a", "b"];
  for (const waves of [
    [{ files: ["a"] }],
    [{ files: ["a", "a"] }],
    [{ files: ["a", "extra"] }],
    [{ files }, { files: [] }],
  ]) {
    assert.throws(
      () => assertTestExecutionPlan(files, waves),
      /Invalid test execution plan/,
    );
    let attempts = 0;
    assert.throws(() =>
      runTestExecutionPlan({ files, waves, executeWave: () => attempts++ }),
    );
    assert.equal(attempts, 0);
  }
  assert.throws(() => createTestExecutionPlan(["a", "a"]), /duplicate/);
});

const threeWaveFiles = [
  "tests/integration/diagnostics-concurrency.test.mjs",
  "tests/integration/collection-row-lifecycle.test.mjs",
  "tests/unit/other.test.mjs",
];

test("normal wave failure continues, every file launches once, and budget is cumulative", () => {
  let elapsed = 100;
  const calls = [],
    notifications = [];
  const result = runTestExecutionPlan({
    files: threeWaveFiles,
    timeoutMs: 300000,
    now: () => elapsed,
    executeWave: (wave) => {
      calls.push(wave);
      elapsed += 10000;
      return {
        status: calls.length === 1 ? "failed" : "passed",
        code: calls.length === 1 ? 7 : 0,
        durationMs: 999999,
      };
    },
    onWave: (wave) => notifications.push(wave),
  });
  assert.deepEqual(
    calls.flatMap((wave) => wave.files),
    threeWaveFiles,
  );
  assert.deepEqual(
    calls.map((wave) => wave.timeoutMs),
    [300000, 290000, 280000],
  );
  assert.equal(result.status, "failed");
  assert.equal(result.code, 7);
  assert.equal(result.durationMs, 30000);
  assert.equal(result.timeoutMs, 300000);
  assert.deepEqual(
    result.waves.map((wave) => wave.status),
    ["failed", "passed", "passed"],
  );
  assert.ok(result.waves.every((wave) => wave.durationMs === 10000));
  assert.deepEqual(
    result.waves.flatMap((wave) => wave.completedFiles),
    threeWaveFiles,
  );
  assert.deepEqual(result.notRunFiles, []);
  assert.deepEqual(notifications, result.waves);
});

test("wave timeout retains its cause and leaves later files explicitly unrun", () => {
  let elapsed = 0;
  const calls = [];
  const result = runTestExecutionPlan({
    files: threeWaveFiles,
    now: () => elapsed,
    executeWave: (wave) => {
      calls.push(wave);
      elapsed += calls.length === 1 ? 120000 : 180000;
      return calls.length === 1
        ? { status: "failed", code: 2 }
        : {
            status: "timeout",
            code: 1,
            errorCode: "ETIMEDOUT",
            signal: "SIGTERM",
          };
    },
  });
  assert.deepEqual(
    calls.map((wave) => wave.timeoutMs),
    [300000, 180000],
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.errorCode, "ETIMEDOUT");
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.durationMs, 300000);
  assert.equal(result.timeoutMs, 300000);
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.notRunFiles, [threeWaveFiles[2]]);
  assert.deepEqual(result.waves[1].completedFiles, []);
  assert.deepEqual(result.waves[2].launchedFiles, []);
  assert.equal(result.waves[2].status, "not_run");
  assert.equal(result.waves[2].reason, "global_deadline_exhausted");
  // Exercise the same bounded metadata parser used by the outer aggregate.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rjr-wave-metadata-"));
  try {
    const file = path.join(temp, "suite-v2.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        status: result.status,
        code: result.code,
        timeoutMs: result.timeoutMs,
        errorCode: result.errorCode,
        signal: result.signal,
      }),
    );
    const outer = runTestProcess({
      name: "outer",
      args: [],
      env: { RJR_DATA_DIR: temp },
      resultFile: file,
      spawn: () => ({ status: result.code }),
    });
    assert.equal(outer.status, "timeout");
    assert.equal(outer.timeoutMs, 300000);
    assert.equal(outer.errorCode, "ETIMEDOUT");
    assert.equal(outer.signal, "SIGTERM");
    assert.notEqual(outer.code, 0);
    assert.ok(outer.durationMs >= 0 && outer.durationMs < 300000);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("deadline exhaustion after a completed wave cannot start another or become green", () => {
  let elapsed = 0,
    calls = 0;
  const result = runTestExecutionPlan({
    files: threeWaveFiles,
    now: () => elapsed,
    executeWave: () => {
      calls++;
      elapsed = 300001;
      return { status: "passed", code: 0 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "timeout");
  assert.equal(result.errorCode, "ETIMEDOUT");
  assert.equal(result.durationMs, 300001);
  assert.deepEqual(result.notRunFiles, threeWaveFiles.slice(1));
  assert.ok(
    result.waves
      .slice(1)
      .every((wave) => wave.status === "not_run" && wave.code !== 0),
  );
});

test("spawn failures continue with failure identity and bounded summary", () => {
  const files = Array.from({ length: 7 }, (_, index) => "file-" + index);
  let elapsed = 0,
    calls = 0;
  const result = runTestExecutionPlan({
    files,
    waves: files.map((file) => ({ name: file, files: [file] })),
    now: () => elapsed,
    executeWave: () => {
      elapsed++;
      calls++;
      return { status: "spawn_blocked", code: 1, errorCode: "EPERM" };
    },
  });
  assert.equal(calls, 7);
  assert.equal(result.status, "spawn_blocked");
  assert.equal(result.errorCode, "EPERM");
  assert.equal(result.failedWaves.length, 5);
  assert.equal(result.waves.length, 7);
  assert.equal(result.plannedFiles.length, 7);
  assert.ok(result.waves.every((wave) => wave.launchedFiles.length === 0));
  assert.equal(result.durationMs, 7);
});

test("invalid wave metadata and thrown executors fail closed while later waves run", () => {
  for (const invalid of [
    null,
    { status: "passed", code: 1 },
    { status: "failed", code: 0 },
    { status: "invented", code: 1 },
  ]) {
    let calls = 0;
    const result = runTestExecutionPlan({
      files: threeWaveFiles,
      executeWave: () => {
        calls++;
        if (calls === 1) return invalid;
        if (calls === 2) throw Error("synthetic executor failure");
        return { status: "passed", code: 0 };
      },
    });
    assert.equal(calls, 3);
    assert.equal(result.status, "spawn_error");
    assert.equal(result.errorCode, "ERR_TEST_EXECUTION");
    assert.equal(result.code, 1);
    assert.deepEqual(
      result.waves.map((wave) => wave.status),
      ["spawn_error", "spawn_error", "passed"],
    );
  }
});

test("signalled waves retain signal identity and unknown completion while later waves run", () => {
  let calls = 0;
  const result = runTestExecutionPlan({
    files: threeWaveFiles,
    executeWave: () =>
      ++calls === 1
        ? { status: "signal", code: 1, signal: "SIGTERM" }
        : { status: "passed", code: 0 },
  });
  assert.equal(calls, 3);
  assert.equal(result.status, "signal");
  assert.equal(result.signal, "SIGTERM");
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.waves[0].launchedFiles, [threeWaveFiles[0]]);
  assert.deepEqual(result.waves[0].completedFiles, []);
  assert.ok(result.waves.slice(1).every((wave) => wave.status === "passed"));
});

test("invocation setup and wave reporting share the same total deadline", () => {
  let elapsed = 1000;
  const result = runTestExecutionPlan({
    files: ["single"],
    startedAt: 0,
    now: () => elapsed,
    executeWave: (wave) => {
      assert.equal(wave.timeoutMs, 299000);
      return { status: "passed", code: 0 };
    },
    onWave: () => {
      elapsed = 300001;
    },
  });
  assert.equal(result.status, "timeout");
  assert.equal(result.durationMs, 300001);
  assert.equal(result.errorCode, "ETIMEDOUT");
  assert.notEqual(result.code, 0);
});
test("workspace schema rejects future versions and malformed entities", () => {
  assert.throws(() => assertWorkspace({ schemaVersion: 4 }), /schema/i);
  const w = createEmptyWorkspace();
  assert.equal(assertWorkspace(w).revision, 0);
  assert.throws(() => assertWorkspace({ ...w, jobs: [] }), /jobs/i);
  assert.throws(
    () => assertSourceRecord({ title: "标题", url: "javascript:alert(1)" }),
    /source|url/i,
  );
});

test("every legacy test entry has exactly one aggregate or explicit exclusion registration", async () => {
  const { assertTestRegistration, TEST_SUITES, EXCLUDED_TEST_ENTRIES } =
    await import("../../tools/lib/test-suites.mjs");
  const files = fs
    .readdirSync(new URL("../../tools/", import.meta.url))
    .filter((file) => /^test-.*\.mjs$/.test(file));
  assert.doesNotThrow(() => assertTestRegistration({ files }));
  assert.throws(
    () => assertTestRegistration({ files: [...files, "test-new-orphan.mjs"] }),
    /Unregistered.*test-new-orphan/,
  );
  assert.throws(
    () =>
      assertTestRegistration({
        files,
        suites: [...TEST_SUITES, { f: "test-security.mjs", offline: true }],
      }),
    /Duplicate.*test-security/,
  );
  assert.throws(
    () =>
      assertTestRegistration({
        files,
        exclusions: [
          ...EXCLUDED_TEST_ENTRIES,
          {
            f: "test-no-longer-exists.mjs",
            reason: "manual fixture",
            mode: "manual",
          },
        ],
      }),
    /Missing.*test-no-longer-exists/,
  );
  for (const entry of EXCLUDED_TEST_ENTRIES) {
    assert.ok(entry.reason.length >= 10, entry.f);
    assert.ok(["aggregate", "native", "manual"].includes(entry.mode), entry.f);
  }
});

test("V2 worker policy reserves one CPU when possible and rejects invalid CPU counts before launch", async () => {
  const { selectTestWorkerConcurrency } = await import(
    "../../tools/lib/test-execution-plan.mjs"
  );
  assert.equal(typeof selectTestWorkerConcurrency, "function");
  for (const [cpus, expected] of [
    [1, 1], [2, 1], [3, 2], [4, 3], [5, 4], [20, 4],
    [Number.MAX_SAFE_INTEGER, 4],
  ])
    assert.equal(selectTestWorkerConcurrency(cpus), expected);
  for (const cpus of [
    0, -1, 1.5, NaN, Infinity, "20", null, Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => selectTestWorkerConcurrency(cpus), /parallelism/i);
    let launched = false;
    assert.throws(
      () => runTestExecutionPlan({
        files: ["one.test.mjs"],
        availableParallelism: cpus,
        executeWave: () => { launched = true; },
      }),
      /parallelism/i,
    );
    assert.equal(launched, false);
  }
});

test("V2 execution records bounded Node subprocess arguments while retaining exclusive waves and the shared budget", async () => {
  const { createTestWorkerArgs } = await import(
    "../../tools/lib/test-execution-plan.mjs"
  );
  assert.equal(typeof createTestWorkerArgs, "function");
  const root = path.resolve("."),
    files = [
      ...threeWaveFiles.slice(0, 2),
      "tests/integration/purge-typed-planning.test.mjs",
      ...threeWaveFiles.slice(2),
      "tests/unit/second.test.mjs",
      "tests/unit/third.test.mjs",
      "tests/unit/fourth.test.mjs",
      "tests/unit/fifth.test.mjs",
    ];
  for (const [cpus, counts] of [[1, [1, 1, 1, 1]], [2, [1, 1, 1, 1]], [20, [1, 1, 1, 4]]]) {
    let elapsed = 0;
    const spawned = [];
    const result = runTestExecutionPlan({
      files,
      availableParallelism: cpus,
      now: () => elapsed,
      executeWave: (wave) => {
        const args = createTestWorkerArgs(wave, { root });
        const outcome = runTestProcess({
          name: wave.name,
          args,
          timeoutMs: wave.timeoutMs,
          spawn: (executable, actualArgs, options) => {
            spawned.push({
              executable, args: [...actualArgs], timeoutMs: options.timeout,
            });
            elapsed += 10000;
            return { status: 0 };
          },
        });
        return { ...outcome, subprocessArgs: args };
      },
    });
    assert.equal(result.status, "passed");
    assert.equal(result.timeoutMs, 300000);
    assert.equal(result.durationMs, 40000);
    assert.deepEqual(result.workerPolicy, {
      availableParallelism: cpus, maxWorkers: cpus === 20 ? 4 : 1,
    });
    assert.deepEqual(result.waves.map((wave) => wave.testConcurrency), counts);
    assert.deepEqual(
      spawned.map((call) => call.timeoutMs), [300000, 290000, 280000, 270000],
    );
    assert.deepEqual(result.waves.flatMap((wave) => wave.completedFiles), files);
    result.waves.forEach((wave, index) => {
      const args = spawned[index].args;
      assert.equal(spawned[index].executable, process.execPath);
      assert.deepEqual(args, wave.subprocessArgs);
      assert.equal(
        args.filter((arg) => arg.startsWith("--test-concurrency=")).length, 1,
      );
      assert.equal(args[0], "--import");
      assert.match(args[1], /tests\/helpers\/network-guard\.mjs$/);
      assert.deepEqual(args.slice(2), [
        "--test", "--test-concurrency=" + counts[index],
        ...wave.plannedFiles.map((file) => path.join(root, file)),
      ]);
    });
  }
  for (const testConcurrency of [0, 5, 1.5, NaN, "1", 2])
    assert.throws(
      () => createTestWorkerArgs({ files: ["one.test.mjs"], testConcurrency }, { root }),
      /concurrency/i,
    );
});

test("Node executes the bounded worker command with its offline guard and credential opt-out", async () => {
  const { createTestWorkerArgs } = await import(
    "../../tools/lib/test-execution-plan.mjs"
  );
  const root = path.resolve("."),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjr-bounded-worker-")),
    file = path.join(dir, "synthetic.test.mjs"),
    proof = path.join(dir, "proof.json");
  try {
    fs.writeFileSync(file, `import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('isolated bounded worker', async () => { await assert.rejects(fetch('https://example.invalid'), /offline_network_forbidden/); fs.writeFileSync(${JSON.stringify(proof)}, JSON.stringify({ data: process.env.RJR_DATA_DIR, disabled: process.env.RJR_DISABLE_LOCAL_CREDENTIALS })); });`);
    const args = createTestWorkerArgs(
      { files: [path.relative(root, file)], testConcurrency: 1 }, { root },
    );
    let actualArgs, spawned;
    const outcome = runTestProcess({
      name: "real bounded worker",
      args,
      cwd: root,
      stdio: "pipe",
      env: { RJR_DATA_DIR: dir, RJR_DISABLE_LOCAL_CREDENTIALS: "0" },
      spawn: (executable, spawnedArgs, options) => {
        actualArgs = [...spawnedArgs];
        // This synthetic child is a new runner, not this test worker's nested harness.
        const env = { ...options.env };
        delete env.NODE_TEST_CONTEXT;
        spawned = spawnSync(executable, spawnedArgs, {
          ...options, env, encoding: "utf8",
        });
        return spawned;
      },
    });
    assert.equal(outcome.status, "passed");
    assert.deepEqual(actualArgs, args);
    assert.deepEqual(actualArgs.slice(2), [
      "--test", "--test-concurrency=1", file,
    ]);
    assert.ok(fs.existsSync(proof), JSON.stringify({
      stdout: spawned.stdout, stderr: spawned.stderr,
      context: process.env.NODE_TEST_CONTEXT,
    }));
    assert.deepEqual(JSON.parse(fs.readFileSync(proof, "utf8")), {
      data: dir, disabled: "1",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
