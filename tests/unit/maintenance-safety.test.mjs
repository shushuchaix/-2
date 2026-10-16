import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTempDir } from "../helpers/fixtures.mjs";

async function copiedCleaner(t) {
  const root = await createTempDir(t),
    tools = path.join(root, "tools"),
    data = path.join(root, "data");
  await fs.mkdir(tools);
  await fs.mkdir(path.join(data, "uploads"), { recursive: true });
  const script = path.join(tools, "clean-data.mjs");
  await fs.copyFile(
    new URL("../../tools/clean-data.mjs", import.meta.url),
    script,
  );
  await fs.writeFile(
    path.join(data, "config.json"),
    '{"auth":{"passwordHash":"synthetic-secret"}}',
  );
  await fs.writeFile(path.join(data, "e2e-test.json"), "synthetic-test");
  await fs.writeFile(
    path.join(data, "uploads", "saved-resume.pdf"),
    "synthetic-resume",
  );
  await fs.utimes(path.join(data, "uploads", "saved-resume.pdf"), 1, 1);
  return { root, data, script };
}

test("maintenance cleaner defaults to dry mode and preserves live config and resume files", async (t) => {
  const f = await copiedCleaner(t);
  const result = spawnSync(process.execPath, [f.script], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await fs.readFile(path.join(f.data, "config.json"), "utf8"),
    '{"auth":{"passwordHash":"synthetic-secret"}}',
  );
  assert.equal(
    await fs.readFile(path.join(f.data, "e2e-test.json"), "utf8"),
    "synthetic-test",
  );
  assert.equal(
    await fs.readFile(path.join(f.data, "uploads", "saved-resume.pdf"), "utf8"),
    "synthetic-resume",
  );
});

test("maintenance apply only removes test artifacts", async (t) => {
  const f = await copiedCleaner(t);
  const result = spawnSync(process.execPath, [f.script, "--apply"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(fs.stat(path.join(f.data, "e2e-test.json")), {
    code: "ENOENT",
  });
  assert.ok(await fs.stat(path.join(f.data, "config.json")));
  assert.ok(await fs.stat(path.join(f.data, "uploads", "saved-resume.pdf")));
});

test("recovery resolves path boundaries and refuses overwriting existing content", async (t) => {
  const source = await fs.readFile(
    new URL("../../tools/recover-recycle.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /export function isRecoveryPath/);
  const { isRecoveryPath, restoreEntry } = await import(
    "../../tools/recover-recycle.mjs"
  );
  assert.equal(
    isRecoveryPath("E:\\简历脚本", "E:\\简历脚本\\data\\one.json"),
    true,
  );
  for (const candidate of [
    "E:\\简历脚本2\\one.json",
    "E:\\简历脚本\\..\\outside.json",
    "F:\\简历脚本\\one.json",
  ])
    assert.equal(isRecoveryPath("E:\\简历脚本", candidate), false);
  const root = await createTempDir(t),
    content = path.join(root, "content"),
    target = path.join(root, "target");
  await fs.mkdir(content);
  await fs.mkdir(target);
  await fs.writeFile(path.join(content, "one.json"), "old");
  await fs.writeFile(path.join(target, "one.json"), "current");
  assert.throws(
    () =>
      restoreEntry({
        source: content,
        destination: target,
        targetRoot: target,
      }),
    { code: "recovery_conflict" },
  );
  assert.equal(
    await fs.readFile(path.join(target, "one.json"), "utf8"),
    "current",
  );
  assert.throws(
    () =>
      restoreEntry({
        source: content,
        destination: path.join(root, "target-sibling"),
        targetRoot: target,
      }),
    { code: "recovery_outside_root" },
  );
});

test("deployment summary exposes configuration state without password hashes", async () => {
  const source = await fs.readFile(
    new URL("../../tools/check-deploy-env.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /export function deploymentConfigSummary/);
  const { deploymentConfigSummary } = await import(
    "../../tools/check-deploy-env.mjs"
  );
  const summary = deploymentConfigSummary({
    auth: {
      mode: "password",
      passwordHash: "synthetic-secret",
      secret: "synthetic-private",
      sessionHours: 8,
    },
    server: { host: "127.0.0.1", port: 3210 },
  });
  assert.deepEqual(summary.auth, {
    enabled: true,
    passwordConfigured: true,
    sessionHours: 8,
  });
  assert.equal(JSON.stringify(summary).includes("synthetic-"), false);
});
