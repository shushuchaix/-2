import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { packageFixture } from "../helpers/package-fixture.mjs";
import { createTrashScheduler } from "../../src/application/trash-scheduler.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { seedUnassignedClosure } from "../helpers/legacy-business-fixture.mjs";
import { legacyClosure } from "../../src/application/legacy-assignment-service.mjs";
import { createServer } from "../../src/server.mjs";
import { loadConfig } from "../../src/config.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { hashPassword } from "../../src/auth.mjs";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";
import { registerTestResource, createTempDir } from "../helpers/fixtures.mjs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

async function failedStartupServer(t, seed) {
  const cfg = loadConfig({ quiet: true, dataDir: seed.dataDir }),
    password = "synthetic-maintenance-password";
  cfg.auth.mode = "password";
  cfg.auth.passwordHash = hashPassword(password);
  cfg.__envAuthPassword = "";
  cfg.__authSecret = "synthetic-maintenance-session-secret";
  cfg.deepseek.apiKey = "";
  const ctx = createServer(cfg, {
    dataDir: seed.dataDir,
    dependencies: {
      clock: seed.clock,
      legacySchema: false,
      startScheduler: false,
      requestFactory: () => async () => {
        throw Error("Unexpected network");
      },
    },
  });
  ctx.server.listen(0, "127.0.0.1");
  await once(ctx.server, "listening");
  const origin = "http://127.0.0.1:" + ctx.server.address().port;
  allowLocalOrigin(origin);
  registerTestResource(t, async () => {
    await ctx.ready.then(
      (app) => app.close(),
      () => {},
    );
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
    await ctx.diagnostics.list({ limit: 1 });
  });
  let cookie;
  async function call(url, body, { authenticated = false, method } = {}) {
    if (authenticated && !cookie) {
      const login = await fetch(origin + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      assert.equal(login.status, 200);
      cookie = login.headers.get("set-cookie").split(";")[0];
    }
    const response = await fetch(origin + url, {
        method: method || (body === undefined ? "GET" : "POST"),
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(authenticated ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { response, text, data };
  }
  return { ctx, call };
}
test("production context upgrades ownership, purges expired archives and preserves young trash", async (t) => {
  const seed = await packageFixture(t);
  const { a, b } = await seed.twoTargets();
  await seed.trash.archive({ packageId: a.packageId });
  seed.clock.advance(72 * 3600000);
  const young = await seed.trash.archive({ packageId: b.packageId });
  const f = await apiFixture(t, {
      dataDir: seed.dataDir,
      legacySchema: false,
      dependencies: { clock: seed.clock, startScheduler: false },
    }),
    ctx = await f.ctx.ready,
    w = await ctx.repository.read();
  assert.equal(w.schemaVersion, 3);
  assert.ok(!w.packages[a.packageId]);
  assert.equal(w.packages[b.packageId].archiveId, young.archiveId);
  assert.equal((await ctx.trashService.list()).length, 1);
  await ctx.close();
});
test("modern business HTTP requires scope and context exports trash/assignment/purge", async (t) => {
  const f = await apiFixture(t, {
      legacySchema: false,
      dependencies: { startScheduler: false },
    }),
    ctx = await f.ctx.ready;
  assert.equal((await ctx.repository.read()).schemaVersion, 3);
  assert.equal(typeof ctx.assignmentService.recoverPending, "function");
  assert.equal(typeof ctx.purgeService.resumePending, "function");
  const r = await f.call("/api/v2/jobs");
  assert.equal(r.response.status, 409);
  assert.equal(r.data.code, "version_scope_required");
});
test("five-minute scheduler does not overlap and stop waits for current sweep", async () => {
  let callback,
    delay,
    cleared = false,
    resolve,
    started = 0;
  const block = new Promise((r) => (resolve = r));
  const scheduler = createTrashScheduler({
    trash: {
      preview: async (input) => {
        assert.deepEqual(input, { expiredOnly: true });
        return { candidates: [] };
      },
    },
    purge: {
      resumePending: async () => {
        started++;
        await block;
        return { pending: [] };
      },
    },
    timers: {
      setInterval(fn, ms) {
        callback = fn;
        delay = ms;
        return 7;
      },
      clearInterval(id) {
        assert.equal(id, 7);
        cleared = true;
      },
    },
  });
  scheduler.start();
  assert.equal(delay, 300000);
  callback();
  callback();
  assert.equal(started, 1);
  let stopped = false;
  const wait = scheduler.stop().then(() => (stopped = true));
  await Promise.resolve();
  assert.equal(stopped, false);
  resolve();
  await wait;
  assert.equal(cleared, true);
  assert.equal(started, 1);
});
test("an incomplete ownership-transfer ledger blocks startup ready and exposes only maintenance reads", async (t) => {
  const seed = await packageBusinessFixture(t),
    { a } = await seed.twoTargets(),
    legacy = await seedUnassignedClosure(seed);
  await seed.trash.archive({ packageId: a.packageId });
  await seed.repository.withMaintenanceTransaction(async (tx) => {
    const c = structuredClone(tx.control),
      closure = legacyClosure(tx.workspace, legacy.recordId, seed.clock.now()),
      pkg = tx.workspace.packages[a.packageId],
      intent = {
        operationId: "transfer-" + randomUUID(),
        from: legacy.packageId,
        to: a.packageId,
        recordIds: closure.recordIds,
        phase: "prepared",
        createdAt: new Date(seed.clock.now()).toISOString(),
      };
    for (const id of closure.recordIds) c.ownershipTransfers[id] = intent;
    c.deletionLedger[a.packageId] = {
      phase: "purge_pending",
      recordIds: [],
      archiveId: pkg.archiveId,
      archivedAt: pkg.archivedAt,
      purgeAt: pkg.purgeAt,
    };
    await tx.commitControl(c);
  });
  const f = await failedStartupServer(t, seed);
  await assert.rejects(f.ctx.ready, {
    code: "ownership_transfer_pending",
    status: 503,
  });
  const health = await f.call("/api/health");
  assert.equal(health.data.ok, false);
  assert.equal(health.data.status, "maintenance");
  assert.equal((await f.call("/api/v2/jobs")).response.status, 401);
  const business = await f.call("/api/v2/jobs", undefined, {
    authenticated: true,
  });
  assert.equal(business.response.status, 503);
  assert.equal(business.data.code, "ownership_transfer_pending");
  const logs = await f.call("/api/v2/diagnostics/logs", undefined, {
    authenticated: true,
  });
  assert.equal(logs.response.status, 200);
  assert.doesNotMatch(logs.text, /合成历史投递|合成历史事件/);
});
test("missing or corrupt initialized control preserves main bytes and permits authenticated safe diagnostics only", async (t) => {
  for (const corruption of ["missing", "corrupt"]) {
    const seed = await packageFixture(t);
    await seed.twoTargets();
    const main = path.join(seed.dataDir, "workspace.v2.json"),
      before = await fs.readFile(main, "utf8"),
      state = path.join(seed.dataDir, "control", "state.json");
    if (corruption === "missing") await fs.unlink(state);
    else
      await fs.writeFile(
        state,
        '{"private":"SYNTHETIC-PERSONAL-BODY C:\\\\SYNTHETIC_PRIVATE_PATH\\\\resume.pdf"}',
      );
    const f = await failedStartupServer(t, seed);
    await assert.rejects(f.ctx.ready, { code: "control_state_invalid" });
    const health = await f.call("/api/health");
    assert.equal(health.data.status, "maintenance");
    assert.equal(health.data.ok, false);
    assert.equal(
      (await f.call("/api/v2/diagnostics/logs")).response.status,
      401,
    );
    for (const [url, body] of [
      ["/api/v2/jobs", undefined],
      ["/api/v2/runs", {}],
      ["/api/v2/workspace/restore", {}],
      ["/api/tracking/jobs", undefined],
    ]) {
      const result = await f.call(url, body, { authenticated: true });
      assert.equal(result.response.status, 503);
      assert.equal(result.data.code, "control_state_invalid");
      assert.doesNotMatch(
        result.text,
        /SYNTHETIC-PERSONAL-BODY|SYNTHETIC_PRIVATE_PATH|简历画像|消防工程/,
      );
    }
    const logs = await f.call("/api/v2/diagnostics/logs", undefined, {
      authenticated: true,
    });
    assert.equal(logs.response.status, 200);
    assert.ok(Array.isArray(logs.data.entries));
    const exported = await f.call(
      "/api/v2/diagnostics/logs/export",
      undefined,
      { authenticated: true },
    );
    assert.equal(exported.response.status, 200);
    const prompt = await f.call("/api/maintenance", undefined, {
      authenticated: true,
    });
    assert.equal(prompt.response.status, 200);
    assert.equal(prompt.data.code, "control_state_invalid");
    assert.equal(prompt.data.status, "maintenance");
    for (const query of ["limit=201", "diagnosticId=private", "path=private"]) {
      const invalid = await f.call(
        "/api/v2/diagnostics/logs?" + query,
        undefined,
        { authenticated: true },
      );
      assert.equal(invalid.response.status, 400);
      assert.equal(invalid.data.code, "invalid_input");
    }
    assert.doesNotMatch(
      logs.text + exported.text + prompt.text,
      /SYNTHETIC-PERSONAL-BODY|SYNTHETIC_PRIVATE_PATH|消防工程/,
    );
    assert.equal(await fs.readFile(main, "utf8"), before);
    if (corruption === "missing")
      await assert.rejects(() => fs.access(state), { code: "ENOENT" });
  }
});
test("expiry scheduler failure retains a supported cleanup phase and safe error code in the actual log", async (t) => {
  const dataDir = await createTempDir(t),
    diagnostics = createDiagnosticsLog({ dataDir }),
    scheduler = createTrashScheduler({
      diagnostics,
      purge: {
        async resumePending() {
          throw Object.assign(Error("SYNTHETIC-PRIVATE-BODY"), {
            code: "control_state_invalid",
          });
        },
      },
      trash: {},
    });
  await assert.rejects(() => scheduler.sweep(), {
    code: "control_state_invalid",
  });
  const entry = (await diagnostics.list()).entries.find(
    (e) => e.outcome === "failed",
  );
  assert.equal(entry.phase, "cleanup");
  assert.equal(entry.stage, "finished");
  assert.equal(entry.code, "control_state_invalid");
  assert.doesNotMatch(await diagnostics.exportText(), /SYNTHETIC-PRIVATE-BODY/);
});
