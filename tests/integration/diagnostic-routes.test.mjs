import test from "node:test";
import assert from "node:assert/strict";
import { handleV2Request } from "../../src/server/routes-v2.mjs";

function routeFixture(diagnostics) {
  let result;
  return {
    context: {
      diagnostics,
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
      url: "/api/v2/diagnostics/logs/export?level=problem&category=storage",
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
    { url: "/api/v2/diagnostics/logs/export?limit=5000", method: "GET" },
    f.res,
    f.context,
  );
  assert.equal(f.result().body, "5000");
  for (const query of [
    "limit=201",
    "level=private",
    "category=private",
    "diagnosticId=private",
    "requestId=private",
    "path=private",
  ])
    await assert.rejects(
      handleV2Request(
        { url: "/api/v2/diagnostics/logs?" + query, method: "GET" },
        f.res,
        f.context,
      ),
    );
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
