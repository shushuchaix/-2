import test from "node:test";
import assert from "node:assert/strict";
import { within } from "@testing-library/react";
import { renderApp } from "../helpers/react-fixture";
import { safeDiagnostic } from "../../ui/src/features/logs/DiagnosticDetails";

test("storage display keeps fixed counts and committed state while rejecting unsafe resource and metric values", () => {
  const safe = safeDiagnostic({
    operation: "storage.transaction",
    resource: "workspace.sqlite",
    committed: true,
    sqlTransactions: 2,
    sqlCommits: 1,
    sqlRollbacks: 1,
    errorNumber: 13,
    lockMs: 50,
    storeMs: 9,
    statements: 40,
    prepares: 2,
    statementCacheHits: 38,
    readBytes: 1024,
    metaReadBytes: 20,
    writeBytes: 4096,
    transactionRefsMs: 1,
    transactionCommitMs: 2,
    sql: "PRIVATE_SQL",
    filename: "C:/PRIVATE_PATH",
    body: "PRIVATE_BODY",
  });
  assert.equal(safe.resource, "workspace.sqlite");
  assert.equal(safe.committed, true);
  assert.equal(safe.sqlTransactions, 2);
  assert.equal(safe.sqlCommits, 1);
  assert.equal(safe.sqlRollbacks, 1);
  assert.equal(safe.errorNumber, 13);
  assert.equal(safe.transactionRefsMs, 1);
  assert.equal(safe.transactionCommitMs, 2);
  assert.equal(JSON.stringify(safe).includes("PRIVATE"), false);
  assert.deepEqual(
    safeDiagnostic({
      sqlCommits: -1,
      prepares: Infinity,
      readBytes: "PRIVATE",
      lockMs: 0.5,
      resource: "C:/PRIVATE/workspace.sqlite",
    }),
    {},
  );
  assert.equal(
    safeDiagnostic({ resource: "control/state.json" }).resource,
    "control/state.json",
  );
  assert.equal(
    safeDiagnostic({ resource: "control/initialized.json" }).resource,
    "control/initialized.json",
  );
});

test("storage detail explains logical work, lock wait and real commit counts without exposing SQL or private paths", async (t) => {
  const f = await renderApp(t, {
    route: "#/logs?packageId=A&targetRevisionId=t1%401&tab=system",
    apiHandler: (path) =>
      path.startsWith("/diagnostics/logs")
        ? {
            entries: [
              {
                operation: "storage.transaction",
                resource: "workspace.sqlite",
                level: "error",
                at: "2026-10-16T00:00:00Z",
                diagnosticId: "d-00000000-0000-4000-8000-000000000012",
                code: "sqlite_post_commit",
                committed: true,
                errorNumber: 13,
                queueMs: 25,
                lockMs: 80,
                storeMs: 20,
                sqlTransactions: 2,
                sqlCommits: 1,
                sqlRollbacks: 1,
                statements: 40,
                prepares: 2,
                statementCacheHits: 38,
                readRows: 4,
                writeRows: 3,
                readBytes: 1024,
                writeBytes: 4096,
                sql: "PRIVATE_SQL",
                path: "C:/PRIVATE_PATH",
                message: "PRIVATE_MESSAGE",
              },
            ],
            summary: { returned: 1, total: 1, errors: 1, warnings: 0 },
          }
        : undefined,
  });
  await f.user.click(await f.screen.findByRole("button", { name: /查看诊断/ }));
  const region = f.screen.getByRole("region", { name: "存储事务计数" });
  assert.ok(within(region).getByText("实际 SQL 写事务数"));
  assert.ok(within(region).getByText("已提交 SQL 事务数"));
  assert.ok(within(region).getByText("已回滚 SQL 事务数"));
  assert.ok(within(region).getByText("同步存储处理（含回调，毫秒）"));
  assert.ok(within(region).getByText("1,024"));
  assert.match(region.textContent || "", /逻辑处理计数/);
  assert.doesNotMatch(document.body.textContent || "", /PRIVATE_/);
  await f.user.click(f.screen.getByRole("button", { name: "技术详情" }));
  assert.match(document.body.textContent || "", /"committed": true/);
  assert.doesNotMatch(document.body.textContent || "", /PRIVATE_/);
});
