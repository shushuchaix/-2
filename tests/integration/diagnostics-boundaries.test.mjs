import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";

test("failed API requests identify a route template, request ID and final status without raw inputs", async (t) => {
  const f = await apiFixture(t),
    app = await f.ctx.ready;
  const response = await f.call(
    "/api/v2/jobs/private-person/application?secret=private-key",
    { note: "private-resume" },
    "PUT",
  );
  assert.equal(response.response.status, 404);
  const requestId = response.response.headers.get("x-rjr-request-id");
  assert.match(requestId || "", /^q-[a-f0-9-]{36}$/);
  const result = await app.diagnostics.list({ requestId });
  assert.ok(
    result.entries.some(
      (e) =>
        e.route === "/api/v2/jobs/:id/application" &&
        e.httpStatus === 404 &&
        e.method === "PUT",
    ),
  );
  assert.ok(
    result.entries.some(
      (e) => e.parentDiagnosticId === response.data.diagnosticId,
    ),
  );
  assert.equal(
    (await app.diagnostics.list({ diagnosticId: response.data.diagnosticId }))
      .entries.length,
    1,
  );
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("successful writes are traced but diagnostic polling never fills its own history", async (t) => {
  const f = await apiFixture(t),
    app = await f.ctx.ready;
  const saved = await f.call(
    "/api/v2/settings",
    { budgets: { maxRequests: 12 } },
    "PUT",
  );
  assert.equal(saved.response.status, 200);
  const requestId = saved.response.headers.get("x-rjr-request-id");
  assert.ok(
    (await app.diagnostics.list({ requestId })).entries.some(
      (e) => e.outcome === "success" && e.route === "/api/v2/settings",
    ),
  );
  const count = (await app.diagnostics.list()).summary.total;
  await f.call("/api/v2/diagnostics/logs");
  await f.call("/api/v2/diagnostics/logs/export");
  assert.equal((await app.diagnostics.list()).summary.total, count);
});

test("transaction failures keep the failed storage step and do not commit private data", async (t) => {
  const dataDir = await createTempDir(t),
    diagnostics = createDiagnosticsLog({ dataDir });
  const repository = await openWorkspaceRepository({allowLegacy:true,
    dataDir,
    diagnostics,
    fsAdapter: {
      ...fs,
      rename: async (from, to) => {
        if (to === path.join(dataDir, "workspace.v2.json"))
          throw Object.assign(Error("private-path"), {
            code: "ENOSPC",
            syscall: "rename",
            dest: to,
          });
        return fs.rename(from, to);
      },
    },
  });
  await assert.rejects(
    repository.mutateWorkspace((w) => {
      w.settings.privateNote = "private-resume";
    }),
    { code: "ENOSPC" },
  );
  const result = await diagnostics.list({ category: "storage" });
  const failed = result.entries.find((e) => e.outcome === "failed");
  assert.ok(failed);
  assert.equal(failed.phase, "current");
  assert.equal(failed.error.storageOperation, "atomic.rename");
  assert.equal(failed.resource, "workspace.v2.json");
  assert.equal(JSON.stringify(result).includes("private-"), false);
  assert.equal((await repository.read()).revision, 0);
});

test("startup and settings boundaries leave safe environment and completion metadata", async (t) => {
  const f = await apiFixture(t),
    app = await f.ctx.ready;
  await app.saveSettings({ budgets: { maxRequests: 15 } });
  const result = await app.diagnostics.list({ category: "application" });
  assert.ok(
    result.entries.some(
      (e) => e.operation === "application.start" && e.runtime.platform,
    ),
  );
  assert.ok(
    result.entries.some(
      (e) =>
        e.operation === "application.recovery" && e.counts.interrupted === 0,
    ),
  );
  assert.ok(
    result.entries.some(
      (e) => e.operation === "application.settings" && e.outcome === "success",
    ),
  );
});
