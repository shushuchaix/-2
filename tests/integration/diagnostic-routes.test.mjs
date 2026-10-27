import test from "node:test";
import assert from "node:assert/strict";
import { handleV2Request } from "../../src/server/routes-v2.mjs";
import { createModelBudget } from "../../src/llm/budget.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";

function routeFixture(diagnostics) {
  let result;
  const readSnapshot = Object.freeze({ runIds: Object.freeze([]) });
  return {
    context: {
      repository:{
        getMeta:async(key)=>{ assert.equal(key,"schemaVersion"); return 3; },
        queryDiagnosticRunScopes:async(query)=>{ assert.deepEqual(query,{runIds:[]}); return {items:[]}; },
      },
      diagnostics: {
        captureReadSnapshot: async () => readSnapshot,
        ...Object.fromEntries(Object.entries(diagnostics).map(([method, handler]) => [method,
          ["list", "exportText"].includes(method) ? (options) => {
            assert.equal(options.readSnapshot, readSnapshot);
            assert.deepEqual(options.runIds, []);
            assert.equal(options.includeRuntimeGlobals, true);
            return handler(options);
          } : handler])),
      },
      http: {
        json: (_req, _res, status, data) => {
          result = { status, data };
        },
      },
    },
    res: {
      writeHead() {},
      end(body) {
        result = { body };
      },
    },
    result: () => result,
  };
}

test("export leaves the retained record limit to the logger and honors safe filters", async () => {
  const f = routeFixture({
    exportText: async (options) => {
      assert.equal(options.limit, undefined);
      assert.equal(options.level, "problem");
      assert.equal(options.category, "storage");
      return "complete retained log";
    },
  });
  await handleV2Request(
    {
      url: "/api/v2/diagnostics/logs/export?allTargets=true&level=problem&category=storage",
      method: "GET",
    },
    f.res,
    f.context,
  );
  assert.equal(f.result().body, "complete retained log");
});

test("diagnostic route validates view and export limits separately", async () => {
  const f = routeFixture({
    exportText: async (options) => String(options.limit),
    list: async () => ({ entries: [] }),
  });
  await handleV2Request(
    { url: "/api/v2/diagnostics/logs/export?allTargets=true&limit=5000", method: "GET" },
    f.res,
    f.context,
  );
  assert.equal(f.result().body, "5000");
  await assert.rejects(handleV2Request(
    { url: "/api/v2/diagnostics/logs/export?allTargets=true&limit=5001", method: "GET" }, f.res, f.context,
  ));
  for (const query of [
    "limit=201",
    "level=private",
    "category=private",
    "diagnosticId=private",
    "requestId=private",
    "path=private",
    "readSnapshot=private",
    "includeRuntimeGlobals=true",
    "runIds=private",
    "limit=5001",
  ])
    await assert.rejects(
      handleV2Request(
        { url: "/api/v2/diagnostics/logs?allTargets=true&" + query, method: "GET" },
        f.res,
        f.context,
      ),
    );
});

test("retained snapshot ownership is filtered before limit and revoked access is checked after logger IO", async (t) => {
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  await diagnostics.record({ operation: "storage.write", runId: "active-run", level: "error" },
    Object.assign(Error("private body password=private-secret"), { code: "ENOSPC", path: "C:/Users/private-person/workspace.sqlite" }));
  await diagnostics.record({ operation: "storage.write", runId: "archived-run", level: "error" });
  const scope = { packageId: "00000000-0000-4000-8000-000000000001", targetRevisionId: "target@1" };
  let response, revoked = false, revokeAfterRead = false, snapshots = 0;
  const context = {
    repository: {
      getMeta: async (key) => { assert.equal(key, "schemaVersion"); return 3; },
      readView: async (query, options) => {
        assert.deepEqual(query, { select: [] });
        assert.deepEqual(options.scope, scope);
        if (revoked) throw Object.assign(Error("expired scope"), { code: "package_expired" });
        return { rows: {} };
      },
      queryDiagnosticRunScopes: async (query, options) => {
        assert.deepEqual(new Set(query.runIds), new Set(["active-run", "archived-run"]));
        assert.ok(query.runIds.length <= 200);
        assert.deepEqual(options.scope, scope);
        return { items: [{ runId: "active-run", ownerPackageId: scope.packageId, targetRevisionId: scope.targetRevisionId }] };
      },
    },
    diagnostics: {
      captureReadSnapshot: async () => { snapshots++; return diagnostics.captureReadSnapshot(); },
      list: async (options) => {
        assert.deepEqual(options.runIds, ["active-run"]);
        assert.equal(options.includeRuntimeGlobals, undefined);
        assert.equal(options.limit, 1);
        const result = await diagnostics.list(options);
        if (revokeAfterRead) revoked = true;
        return result;
      },
    },
    http: { json: (_req, _res, status, data) => { response = { status, data }; } },
  };
  const req = { method: "GET", url: `/api/v2/diagnostics/logs?packageId=${scope.packageId}&targetRevisionId=${scope.targetRevisionId}&limit=1` };
  await handleV2Request(req, {}, context);
  assert.equal(snapshots, 1);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.entries.map((entry) => entry.runId), ["active-run"]);
  assert.equal(response.data.entries[0].error.code, "ENOSPC");
  assert.doesNotMatch(JSON.stringify(response), /private-secret|private-person|private body|archived-run/);
  response = undefined;
  revokeAfterRead = true;
  await assert.rejects(handleV2Request(req, {}, context), { code: "package_expired" });
  assert.equal(snapshots, 2);
  assert.equal(response, undefined);
});

test("resume AI preview fallback has a safe diagnostic linked to its warning", async () => {
  const recorded = [];
  const f = routeFixture({
    record: async (event, error) => {
      recorded.push({ event, error });
      return { diagnosticId: "d-00000000-0000-4000-8000-000000000001" };
    },
  });
  f.context.cfg = { deepseek: { apiKey: "" } };
  f.context.createModelBudget = async () => createModelBudget();
  f.context.modelFactory = () => ({
    available: true,
    chatJson: async () => {
      throw Object.assign(Error("private model text"), { code: "ETIMEDOUT" });
    },
  });
  f.context.http.readJson = async () => ({
    resumeText:
      "张三 Java 软件工程 本科 项目研发经历 MySQL Spring Boot 开发软件五年工作经验",
    mode: "ai",
  });
  await handleV2Request(
    { url: "/api/v2/profiles/import-preview", method: "POST" },
    f.res,
    f.context,
  );
  assert.equal(recorded[0]?.event.operation, "model.fallback");
  assert.equal(recorded[0]?.event.phase, "parse");
  assert.match(f.result().data.warnings.join(" "), /错误编号.*d-/);
});
