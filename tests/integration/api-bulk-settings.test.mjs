import { namedTargetInput } from "../helpers/fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { profile, target, job } from "../helpers/fixtures.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createApplicationContext } from "../../src/application/context.mjs";
import { DEFAULT_CONFIG } from "../../src/config.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";

async function settingsFixture(t, { existingConfig = true } = {}) {
  const cacheRoot = path.resolve(".cache");
  await fs.mkdir(cacheRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(
    path.join(cacheRoot, "settings-commit-test-"),
  );
  assert.ok(dataDir.startsWith(cacheRoot + path.sep));
  const filename = path.join(dataDir, "config.json");
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.deepseek.apiKey = "synthetic-old-settings-key";
  const oldModel = structuredClone(cfg.deepseek);
  const oldConfig = {
    deepseek: structuredClone(oldModel),
    sources: { synthetic: { enabled: true } },
  };
  if (existingConfig)
    await fs.writeFile(filename, JSON.stringify(oldConfig, null, 2), "utf8");
  const faults = {
    workspaceFailures: 0,
    configReplacements: 0,
    rejectRollback: false,
    rejectConfigRemoval: false,
    beforeWorkspaceRename: null,
  };
  const fsAdapter = {
    ...fs,
    async rename(from, to) {
      if (to === path.join(dataDir, "workspace.v2.json")) {
        if (faults.workspaceFailures > 0) {
          faults.workspaceFailures--;
          throw Object.assign(Error("synthetic workspace write failed"), {
            code: "ENOSPC",
          });
        }
        await faults.beforeWorkspaceRename?.();
      }
      if (
        to === filename &&
        ++faults.configReplacements === 2 &&
        faults.rejectRollback
      )
        throw Object.assign(Error("synthetic config restore failed"), {
          code: "EIO",
        });
      return fs.rename(from, to);
    },
    async unlink(file) {
      if (file === filename && faults.rejectConfigRemoval)
        throw Object.assign(Error("synthetic config removal failed"), {
          code: "EIO",
        });
      return fs.unlink(file);
    },
  };
  const context = await createApplicationContext({
    cfg,
    dataDir,
    dependencies: {
      legacySchema: true,
      startScheduler: false,
      fsAdapter,
      registry: createSourceRegistry([]),
      catalog: [],
      requestFactory: () => async () => {
        throw Error("Unexpected network");
      },
    },
  });
  t.after(async () => {
    await context.close();
    const entry = await fs.lstat(dataDir);
    assert.equal(entry.isSymbolicLink(), false);
    assert.ok(path.resolve(dataDir).startsWith(cacheRoot + path.sep));
    await fs.rm(dataDir, { recursive: true });
  });
  return { context, cfg, faults, filename, dataDir, oldModel, oldConfig };
}

const settingsChange = () => ({
  model: {
    baseUrl: "https://compatible.example/v1",
    model: "synthetic-next-model",
    apiKey: "synthetic-next-settings-key",
  },
  budgets: { maxModelRequests: 7 },
});

test("workspace write failure restores an existing config and leaves the runtime model unchanged", async (t) => {
  const f = await settingsFixture(t);
  const before = await f.context.repository.read();
  f.faults.workspaceFailures = 1;
  await assert.rejects(f.context.saveSettings(settingsChange()), {
    code: "ENOSPC",
  });
  assert.deepEqual(
    JSON.parse(await fs.readFile(f.filename, "utf8")),
    f.oldConfig,
  );
  assert.deepEqual(f.cfg.deepseek, f.oldModel);
  assert.deepEqual(
    (await f.context.repository.read()).settings,
    before.settings,
  );
});

test("workspace write failure removes a newly created config", async (t) => {
  const f = await settingsFixture(t, { existingConfig: false });
  const before = await f.context.repository.read();
  f.faults.workspaceFailures = 1;
  await assert.rejects(f.context.saveSettings(settingsChange()), {
    code: "ENOSPC",
  });
  await assert.rejects(fs.access(f.filename), { code: "ENOENT" });
  assert.deepEqual(f.cfg.deepseek, f.oldModel);
  assert.deepEqual(
    (await f.context.repository.read()).settings,
    before.settings,
  );
});

test("the runtime model is published only after the workspace settings commit", async (t) => {
  const f = await settingsFixture(t);
  let entered, release;
  const atCommit = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.faults.beforeWorkspaceRename = async () => {
    entered();
    await held;
  };
  const pending = f.context.saveSettings(settingsChange());
  await atCommit;
  try {
    assert.deepEqual(f.cfg.deepseek, f.oldModel);
  } finally {
    release();
  }
  const saved = await pending;
  assert.equal(saved.model.model, "synthetic-next-model");
  assert.equal(saved.budgets.maxModelRequests, 7);
  assert.equal(f.cfg.deepseek.apiKey, "synthetic-next-settings-key");
  const privateFree = JSON.stringify({
    saved,
    workspace: await f.context.repository.read(),
    backup: await f.context.backup(),
    diagnostics: await f.context.diagnostics.list(),
  });
  assert.equal(privateFree.includes("synthetic-next-settings-key"), false);
  assert.equal(privateFree.includes("synthetic-old-settings-key"), false);
  assert.equal(privateFree.includes('"apiKey"'), false);
});

test("a failed settings patch is fully compensated before the next queued patch", async (t) => {
  const f = await settingsFixture(t);
  const before = await f.context.repository.read();
  f.faults.workspaceFailures = 1;
  const results = await Promise.allSettled([
    f.context.saveSettings(settingsChange()),
    f.context.saveSettings({
      model: { model: "synthetic-final-model" },
      budgets: { maxDetails: 7 },
    }),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.deepEqual(f.cfg.deepseek, {
    ...f.oldModel,
    model: "synthetic-final-model",
  });
  assert.deepEqual(JSON.parse(await fs.readFile(f.filename, "utf8")), {
    ...f.oldConfig,
    deepseek: { ...f.oldModel, model: "synthetic-final-model" },
  });
  assert.deepEqual((await f.context.repository.read()).settings.budgets, {
    ...before.settings.budgets,
    maxDetails: 7,
  });
});

for (const existingConfig of [true, false]) {
  test(`failed compensation reports a safe error and blocks later saves (${existingConfig ? "existing" : "new"} config)`, async (t) => {
    const f = await settingsFixture(t, { existingConfig });
    const before = await f.context.repository.read();
    f.faults.workspaceFailures = 1;
    f.faults.rejectRollback = existingConfig;
    f.faults.rejectConfigRemoval = !existingConfig;
    await assert.rejects(f.context.saveSettings(settingsChange()), (error) => {
      assert.equal(error.code, "settings_rollback_failed");
      assert.equal(error.message.includes("synthetic-"), false);
      assert.equal(error.message.includes(f.dataDir), false);
      return true;
    });
    await assert.rejects(
      f.context.saveSettings({ budgets: { maxDetails: 8 } }),
      {
        code: "settings_rollback_failed",
      },
    );
    assert.deepEqual(f.cfg.deepseek, f.oldModel);
    assert.deepEqual(
      (await f.context.repository.read()).settings,
      before.settings,
    );
    assert.equal(
      JSON.parse(await fs.readFile(f.filename, "utf8")).deepseek.model,
      "synthetic-next-model",
    );
    const diagnostics = JSON.stringify(await f.context.diagnostics.list());
    assert.equal(diagnostics.includes("synthetic-next-settings-key"), false);
    assert.equal(diagnostics.includes("synthetic-old-settings-key"), false);
  });
}
test("bulk saved-job rescore and bounded settings are available", async (t) => {
  const f = await apiFixture(t),
    context = await f.ctx.ready,
    p = await context.workspaceService.saveProfile({ profile: profile() }),
    tar = await context.workspaceService.saveTarget(
      namedTargetInput({
        ...target(),
        profileRevisionId: p.revisionId,
      }),
    ),
    ingested = await context.jobService.ingestRecords({
      runId: "manual",
      targetRevisionId: tar.revisionId,
      records: [job()],
    });
  const res = await f.call("/api/v2/jobs/evaluations", {
    jobIds: ingested.jobIds,
    profileRevisionId: p.revisionId,
    targetRevisionId: tar.revisionId,
    mode: "rules",
  });
  assert.equal(res.response.status, 200);
  assert.equal(res.data.evaluations.length, 1);
  const invalid = await f.call(
    "/api/v2/settings",
    { budgets: { maxModelRequests: 21 } },
    "PUT",
  );
  assert.equal(invalid.response.status, 400);
  const valid = await f.call(
    "/api/v2/settings",
    { budgets: { maxModelRequests: 10 } },
    "PUT",
  );
  assert.equal(valid.data.budgets.maxModelRequests, 10);
});

test("target creation API accepts a verified currency budget", async (t) => {
  const f = await apiFixture(t),
    context = await f.ctx.ready,
    p = await context.workspaceService.saveProfile({ profile: profile() });
  await context.saveSettings({
    model: { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
    budgets: { maxCostCny: 10 },
  });
  const response = await f.call(
    "/api/v2/targets",
    namedTargetInput({
      ...target(),
      profileRevisionId: p.revisionId,
      budgets: { maxCostCny: 10 },
    }),
  );
  assert.equal(response.response.status, 201);
  assert.equal(response.data.budgets.maxCostCny, 10);
});
