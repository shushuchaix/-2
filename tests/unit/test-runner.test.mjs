import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
