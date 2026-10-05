import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.throws(() => assertWorkspace({ schemaVersion: 3 }), /schema/i);
  const w = createEmptyWorkspace();
  assert.equal(assertWorkspace(w).revision, 0);
  assert.throws(() => assertWorkspace({ ...w, jobs: [] }), /jobs/i);
  assert.throws(
    () => assertSourceRecord({ title: "标题", url: "javascript:alert(1)" }),
    /source|url/i,
  );
});
