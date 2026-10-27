import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createDiagnosticsLog,
  withDiagnosticContext,
} from "../../src/infrastructure/diagnostics/log.mjs";

async function fixture() {
  const base = path.resolve(
    ".cache/phase2-storage-observability/runtime-globals",
  );
  await fs.mkdir(base, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(base, "logs-"));
  return { dataDir, log: createDiagnosticsLog({ dataDir }) };
}
const globals = [
  "application.start",
  "application.migration",
  "application.recovery",
  "application.shutdown",
  "desktop.start",
  "desktop.ready",
  "desktop.load",
  "desktop.failure",
];
const allTargets = { runIds: [], includeRuntimeGlobals: true };

test("empty authorized run list can include only fixed runtime globals and explicitly global storage across restart and export", async () => {
  const f = await fixture();
  for (const operation of globals) await f.log.record({ operation });
  const storage = await f.log.record({
    operation: "storage.transaction",
    runtimeGlobal: true,
    sqlTransactions: 1,
  });
  await f.log.record({ operation: "storage.transaction" });
  await f.log.record({
    operation: "storage.recovered",
    resource: "control/state.json",
  });
  await f.log.record({ operation: "source.probe", runtimeGlobal: true });
  await f.log.record({ operation: "desktop.credentials", runtimeGlobal: true });
  const log = createDiagnosticsLog({ dataDir: f.dataDir });
  const list = await log.list(allTargets);
  assert.equal(list.entries.length, globals.length + 1);
  for (const operation of globals)
    assert.ok(list.entries.some((entry) => entry.operation === operation));
  assert.equal(
    list.entries.find((entry) => entry.diagnosticId === storage.diagnosticId)
      .runtimeGlobal,
    true,
  );
  assert.equal(
    list.entries.filter((entry) => entry.operation.startsWith("storage."))
      .length,
    1,
  );
  const exported = await log.exportText(allTargets);
  assert.ok(exported.includes(storage.diagnosticId));
  assert.equal((await log.list({ runIds: [] })).entries.length, 0);
  assert.equal(
    (await log.list({ runIds: "invalid", includeRuntimeGlobals: true })).entries
      .length,
    0,
  );
});

test("run allowlist plus globals excludes archived runs and no-run private source or ownership context before and after cleaning", async () => {
  const f = await fixture();
  const active = await f.log.record({
    operation: "run.finished",
    runId: "r-active",
  });
  const archived = await f.log.record({
    operation: "run.finished",
    runId: "r-archived",
  });
  const privateEntries = [];
  for (const event of [
    { operation: "source.probe", sourceId: "boss", runtimeGlobal: true },
    { operation: "application.migration", packageId: "PRIVATE_PACKAGE" },
    { operation: "application.start", targetRevisionId: "PRIVATE_TARGET" },
    {
      operation: "desktop.failure",
      scope: { packageId: "PRIVATE_SCOPE" },
      runtimeGlobal: true,
    },
    { operation: "desktop.ready", sessionRef: "PRIVATE_SESSION" },
    { operation: "desktop.load", sessionId: "PRIVATE_SESSION_ID" },
    {
      operation: "desktop.start",
      sessionId: "s-00000000-0000-4000-8000-000000000099",
    },
    {
      operation: "storage.transaction",
      runtimeGlobal: true,
      ownerPackageId: "PRIVATE_OWNER",
    },
    { operation: "application.recovery", sourceId: "boss" },
    {
      operation: "application.shutdown",
      activityId: "collection-00000000-0000-4000-8000-000000000001",
    },
  ])
    privateEntries.push(await f.log.record(event));
  const publicEntry = await f.log.record({
    operation: "application.migration",
  });
  const log = createDiagnosticsLog({ dataDir: f.dataDir });
  const entries = (
    await log.list({ runIds: ["r-active"], includeRuntimeGlobals: true })
  ).entries;
  assert.deepEqual(
    new Set(entries.map((entry) => entry.diagnosticId)),
    new Set([active.diagnosticId, publicEntry.diagnosticId]),
  );
  const exported = await log.exportText({
    runIds: ["r-active"],
    includeRuntimeGlobals: true,
  });
  for (const hidden of [archived, ...privateEntries])
    assert.equal(exported.includes(hidden.diagnosticId), false);
  assert.equal(exported.includes("PRIVATE_"), false);
  const scoped = await log.list({ runIds: ["r-active"] });
  assert.deepEqual(
    scoped.entries.map((entry) => entry.diagnosticId),
    [active.diagnosticId],
  );
  const explicit = await log.list({
    runIds: ["r-active"],
    runId: "r-active",
    includeRuntimeGlobals: true,
  });
  assert.deepEqual(
    explicit.entries.map((entry) => entry.diagnosticId),
    [active.diagnosticId],
  );
});

test("business context remains conservative through nested diagnostic contexts and false global markers", async () => {
  const f = await fixture();
  const entry = await withDiagnosticContext(
    { scope: { packageId: "PRIVATE_CONTEXT" } },
    () =>
      withDiagnosticContext({ businessContext: false }, () =>
        f.log.record({
          operation: "application.migration",
          businessContext: false,
          runtimeGlobal: true,
        }),
      ),
  );
  assert.equal(entry.businessContext, true);
  const reopened = createDiagnosticsLog({ dataDir: f.dataDir });
  assert.equal((await reopened.list(allTargets)).entries.length, 0);
  assert.equal(
    (await reopened.exportText()).includes("PRIVATE_CONTEXT"),
    false,
  );
});

test("legacy stored ownership is checked before unknown fields are removed and invalid explicit global operations cannot opt in", async () => {
  const f = await fixture();
  const seed = await f.log.record({ operation: "application.migration" });
  const injected = [
    {
      ...seed,
      diagnosticId: "d-" + randomUUID(),
      packageId: "PRIVATE_RAW_PACKAGE",
      runtimeGlobal: true,
    },
    {
      ...seed,
      diagnosticId: "d-" + randomUUID(),
      scope: { targetRevisionId: "PRIVATE_RAW_SCOPE" },
      businessContext: false,
      runtimeGlobal: true,
    },
    {
      ...seed,
      diagnosticId: "d-" + randomUUID(),
      sessionId: "PRIVATE_RAW_SESSION",
      runtimeGlobal: true,
    },
    {
      ...seed,
      diagnosticId: "d-" + randomUUID(),
      operation: "source.probe",
      runtimeGlobal: true,
    },
  ];
  await fs.appendFile(
    path.join(f.dataDir, "logs", "application.log"),
    injected.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const reopened = createDiagnosticsLog({ dataDir: f.dataDir });
  const entries = (await reopened.list(allTargets)).entries;
  assert.deepEqual(
    entries.map((entry) => entry.diagnosticId),
    [seed.diagnosticId],
  );
  assert.equal((await reopened.exportText()).includes("PRIVATE_RAW_"), false);
});

test("one closed read snapshot supplies candidate run IDs and reuses the same retained view for authorized list and export", async () => {
  const f = await fixture();
  let readOpens = 0;
  const log = createDiagnosticsLog({
    dataDir: f.dataDir,
    fsAdapter: {
      ...fs,
      async open(file, mode, ...args) {
        if (
          mode === "r" &&
          /^application(?:\.fatal)?(?:\.previous)?\.log$/.test(
            path.basename(file),
          )
        )
          readOpens++;
        return fs.open(file, mode, ...args);
      },
    },
  });
  const active = await log.record({
    operation: "run.finished",
    runId: "r-active",
  });
  const archived = await log.record({
    operation: "run.finished",
    runId: "r-archived",
  });
  const runtime = await log.record({ operation: "application.migration" });
  readOpens = 0;
  const readSnapshot = await log.captureReadSnapshot();
  assert.equal(readOpens, 4);
  assert.equal(Object.isFrozen(readSnapshot), true);
  assert.equal(Object.isFrozen(readSnapshot.runIds), true);
  assert.deepEqual(
    new Set(readSnapshot.runIds),
    new Set(["r-active", "r-archived"]),
  );
  assert.throws(() => readSnapshot.runIds.push("r-unauthorized"), TypeError);
  const late = await log.record({
    operation: "run.finished",
    runId: "r-active",
  });
  const options = {
    readSnapshot,
    runIds: ["r-active"],
    includeRuntimeGlobals: true,
  };
  const entries = (await log.list(options)).entries;
  assert.deepEqual(
    new Set(entries.map((entry) => entry.diagnosticId)),
    new Set([active.diagnosticId, runtime.diagnosticId]),
  );
  const exported = await log.exportText(options);
  assert.equal(exported.includes(active.diagnosticId), true);
  assert.equal(exported.includes(runtime.diagnosticId), true);
  assert.equal(exported.includes(archived.diagnosticId), false);
  assert.equal(exported.includes(late.diagnosticId), false);
  assert.equal(readOpens, 4);
});

test("foreign or invalid read snapshot tokens fail closed without reading the filesystem", async () => {
  const f = await fixture();
  const snapshot = await f.log.captureReadSnapshot();
  let reads = 0;
  const other = createDiagnosticsLog({
    dataDir: f.dataDir,
    fsAdapter: {
      ...fs,
      open() {
        reads++;
        throw Error("Unexpected read");
      },
    },
  });
  for (const readSnapshot of [snapshot, {}, "invalid", null]) {
    await assert.rejects(
      other.list({ readSnapshot, runIds: [], includeRuntimeGlobals: true }),
      { code: "diagnostic_snapshot_invalid" },
    );
    await assert.rejects(
      other.exportText({
        readSnapshot,
        runIds: [],
        includeRuntimeGlobals: true,
      }),
      { code: "diagnostic_snapshot_invalid" },
    );
  }
  assert.equal(reads, 0);
});
