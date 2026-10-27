import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  runTestProcess,
  runTestPipeline,
  formatTestResult,
} from "../../tools/lib/test-process.mjs";

test("test runner distinguishes real passing, assertion failure, timeout and spawn failure", () => {
  const run = (args, more = {}) =>
    runTestProcess({ name: "controlled", args, stdio: "ignore", ...more });
  assert.equal(run(["-e", "process.exit(0)"]).status, "passed");
  const failed = run(["-e", "require('node:assert/strict').equal(1, 2)"]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.code, 1);
  const timeout = run(["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 150,
  });
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.errorCode, "ETIMEDOUT");
  assert.notEqual(timeout.code, 0);
  const missing = run([], {
    executable: path.join(os.tmpdir(), "rjr-nonexistent-test-runner.exe"),
  });
  assert.equal(missing.status, "spawn_error");
  assert.equal(missing.errorCode, "ENOENT");
  assert.notEqual(missing.code, 0);
});

test("test runner preserves blocked and signalled failures without making them green", () => {
  const blocked = runTestProcess({
    name: "blocked",
    args: [],
    spawn: () => ({
      error: Object.assign(new Error("blocked"), { code: "EPERM" }),
      status: null,
      signal: null,
    }),
  });
  assert.equal(blocked.status, "spawn_blocked");
  assert.equal(blocked.errorCode, "EPERM");
  assert.notEqual(blocked.code, 0);
  assert.match(formatTestResult(blocked), /权限.*EPERM/);
  const signal = runTestProcess({
    name: "signalled",
    args: [],
    spawn: () => ({ status: null, signal: "SIGTERM" }),
  });
  assert.equal(signal.status, "signal");
  assert.equal(signal.signal, "SIGTERM");
  assert.notEqual(signal.code, 0);
  const thrown = runTestProcess({
    name: "spawn threw",
    args: [],
    spawn: () => {
      throw Object.assign(new Error("bad spawn"), { code: "EINVAL" });
    },
  });
  assert.equal(thrown.status, "spawn_error");
  assert.equal(thrown.errorCode, "EINVAL");
});

test("failed UI prerequisite marks downstream as not run and never invokes tests", async () => {
  let attempts = 0;
  const results = await runTestPipeline({
    prerequisite: {
      name: "UI前置构建",
      run: () => {
        throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
      },
    },
    steps: [
      { name: "legacy suite" },
      { name: "v2 tests" },
      { name: "React UI tests" },
    ],
    runStep: () => {
      attempts++;
      throw Error("must not execute");
    },
  });
  assert.equal(attempts, 0);
  assert.equal(results[0].status, "prerequisite_failed");
  assert.equal(results[0].errorCode, "EPERM");
  assert.ok(
    results.slice(1).every((r) => r.status === "not_run" && r.code !== 0),
  );
  assert.match(formatTestResult(results[1]), /未运行.*前置构建/);
});

test("one failed suite does not hide later outcomes after successful UI prerequisite", async () => {
  const calls = [];
  const results = await runTestPipeline({
    prerequisite: { name: "UI前置构建", run: () => {} },
    steps: [
      { name: "first" },
      { name: "network", skipReason: "需要联网" },
      { name: "last" },
    ],
    runStep: (step) => {
      calls.push(step.name);
      return {
        name: step.name,
        status: step.name === "first" ? "failed" : "passed",
        code: step.name === "first" ? 1 : 0,
      };
    },
  });
  assert.deepEqual(calls, ["first", "last"]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["passed", "failed", "skipped", "passed"],
  );
});

test("test child receives the credential opt-out, isolated data directory and network guard", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rjr-test-runner-proof-"));
  try {
    const file = path.join(temp, "proof.json");
    const source = `const fs = require('node:fs'); fetch('https://example.invalid').then(() => process.exit(2), error => { fs.writeFileSync(process.argv[1], JSON.stringify({ disabled: process.env.RJR_DISABLE_LOCAL_CREDENTIALS, data: process.env.RJR_DATA_DIR, blocked: /offline_network_forbidden/.test(error.message) })); });`;
    const result = runTestProcess({
      name: "isolated",
      args: [
        "--import",
        "./tests/helpers/network-guard.mjs",
        "-e",
        source,
        file,
      ],
      stdio: "ignore",
      env: { RJR_DATA_DIR: temp, RJR_DISABLE_LOCAL_CREDENTIALS: "0" },
    });
    assert.equal(result.status, "passed");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      disabled: "1",
      data: temp,
      blocked: true,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("nested test timeout keeps its classification through the real wrapper process", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rjr-test-nested-proof-"));
  try {
    const helper = pathToFileURL(
      path.resolve("tools/lib/test-process.mjs"),
    ).href;
    const script = path.join(temp, "child.mjs");
    fs.writeFileSync(
      script,
      `import {runTestProcess,publishTestResult} from ${JSON.stringify(helper)}; const result=runTestProcess({name:'nested',args:['-e','setInterval(() => {},1000)'],timeoutMs:150,stdio:'ignore'}); publishTestResult(result); process.exitCode=result.code;`,
    );
    const result = runTestProcess({
      name: "wrapper",
      args: [script],
      stdio: "ignore",
      resultFile: path.join(temp, "suite-nested.json"),
      env: { RJR_DATA_DIR: temp },
    });
    assert.equal(result.status, "timeout");
    assert.equal(result.errorCode, "ETIMEDOUT");
    assert.equal(result.timeoutMs, 150);
    assert.notEqual(result.code, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("missing or contradicting child result cannot turn a failed wrapper green", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rjr-test-result-proof-"));
  try {
    const file = path.join(temp, "suite-child.json");
    const missing = runTestProcess({
      name: "missing report",
      args: ["-e", "process.exit(1)"],
      stdio: "ignore",
      resultFile: file,
      env: { RJR_DATA_DIR: temp },
    });
    assert.equal(missing.status, "runner_error");
    assert.notEqual(missing.code, 0);
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, status: "passed", code: 0 }),
    );
    const contradictory = runTestProcess({
      name: "contradicting",
      args: ["-e", "process.exit(1)"],
      stdio: "ignore",
      resultFile: file,
      env: { RJR_DATA_DIR: temp },
    });
    assert.equal(contradictory.status, "runner_error");
    assert.notEqual(contradictory.code, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
