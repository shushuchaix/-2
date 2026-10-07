import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "../helpers/fixtures.mjs";
import { writeAtomicJson } from "../../src/infrastructure/storage/atomic.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import { spawn } from "node:child_process";

test("Windows transient replacement errors retry the same completed temp file", async (t) => {
  const dir = await createTempDir(t),
    filename = path.join(dir, "workspace.v2.json");
  await fs.writeFile(filename, JSON.stringify({ revision: 1 }));
  let attempts = 0,
    writes = 0,
    tempPath;
  const waits = [],
    recoveries = [];
  await writeAtomicJson(
    filename,
    { revision: 2 },
    {
      platform: "win32",
      sleep: async (ms) => waits.push(ms),
      onRenameRecovery: async (event) => recoveries.push(event),
      fsAdapter: {
        ...fs,
        open: async (...args) => {
          writes++;
          return fs.open(...args);
        },
        rename: async (from, to) => {
          tempPath ||= from;
          assert.equal(from, tempPath);
          assert.equal(JSON.parse(await fs.readFile(to, "utf8")).revision, 1);
          assert.equal(JSON.parse(await fs.readFile(from, "utf8")).revision, 2);
          if (++attempts <= 3)
            throw Object.assign(Error("busy"), {
              code: ["EPERM", "EACCES", "EBUSY"][attempts - 1],
            });
          await fs.rename(from, to);
        },
      },
    },
  );
  assert.equal(attempts, 4);
  assert.equal(writes, 1);
  assert.deepEqual(waits, [25, 50, 100]);
  assert.deepEqual(recoveries, [
    { retryCount: 3, code: "EBUSY", retryDelayMs: 175 },
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), {
    revision: 2,
  });
  assert.deepEqual(await fs.readdir(dir), ["workspace.v2.json"]);
});

test("persistent Windows replacement failure is bounded and retains valid data", async (t) => {
  const dir = await createTempDir(t),
    filename = path.join(dir, "workspace.v2.json");
  const old = JSON.stringify({ revision: 1 });
  await fs.writeFile(filename, old);
  let attempts = 0;
  const waits = [],
    primary = Object.assign(Error("still occupied"), {
      code: "EPERM",
      syscall: "rename",
      dest: filename,
    });
  await assert.rejects(
    writeAtomicJson(
      filename,
      { revision: 2 },
      {
        platform: "win32",
        sleep: async (ms) => waits.push(ms),
        fsAdapter: {
          ...fs,
          rename: async () => {
            attempts++;
            throw primary;
          },
        },
      },
    ),
    (error) =>
      error === primary &&
      error.storageOperation === "atomic.rename" &&
      error.retryCount === 6,
  );
  assert.equal(attempts, 7);
  assert.deepEqual(waits, [25, 50, 100, 200, 400, 800]);
  assert.equal(await fs.readFile(filename, "utf8"), old);
  assert.deepEqual(await fs.readdir(dir), ["workspace.v2.json"]);
});

test("non-Windows and unrelated replacement errors fail without retry", async (t) => {
  const dir = await createTempDir(t),
    filename = path.join(dir, "workspace.v2.json");
  for (const [platform, code] of [
    ["linux", "EPERM"],
    ["win32", "ENOSPC"],
    ["win32", "EINVAL"],
  ]) {
    let attempts = 0,
      waits = 0;
    await assert.rejects(
      writeAtomicJson(
        filename,
        {},
        {
          platform,
          sleep: async () => {
            waits++;
          },
          fsAdapter: {
            ...fs,
            rename: async () => {
              attempts++;
              throw Object.assign(Error(code), { code });
            },
          },
        },
      ),
      { code },
    );
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
  }
});

test("recovery observer failure cannot undo a successful atomic save", async (t) => {
  const dir = await createTempDir(t),
    filename = path.join(dir, "workspace.v2.json");
  let attempts = 0;
  await writeAtomicJson(
    filename,
    { saved: true },
    {
      platform: "win32",
      sleep: async () => {},
      onRenameRecovery: () => {
        throw Error("diagnostics unavailable");
      },
      fsAdapter: {
        ...fs,
        rename: async (...args) => {
          if (++attempts === 1)
            throw Object.assign(Error("busy"), { code: "EPERM" });
          return fs.rename(...args);
        },
      },
    },
  );
  assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), {
    saved: true,
  });
});

test(
  "Windows repository retries replacement once per transaction and logs recovery",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = await createTempDir(t),
      diagnostics = createDiagnosticsLog({ dataDir: dir });
    let attempts = 0,
      mutations = 0;
    const repo = await openWorkspaceRepository({
      dataDir: dir,
      diagnostics,
      fsAdapter: {
        ...fs,
        rename: async (...args) => {
          if (++attempts === 1)
            throw Object.assign(Error("busy"), { code: "EPERM" });
          return fs.rename(...args);
        },
      },
    });
    await repo.mutateWorkspace((w) => {
      mutations++;
      w.recoveryRecords.push({ message: "synthetic" });
    });
    assert.equal(mutations, 1);
    assert.equal((await repo.read()).revision, 1);
    const entries = (await diagnostics.list()).entries.filter(
      (entry) => entry.operation === "storage.recovered",
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].operation, "storage.recovered");
    assert.equal(entries[0].level, "info");
    assert.equal(entries[0].code, "EPERM");
    assert.equal(entries[0].retryCount, 1);
    assert.equal(entries[0].resource, "workspace.v2.json");
    assert.ok(!JSON.stringify(entries).includes(dir));
  },
);

test(
  "native Windows sharing lock recovers after its owner releases the file",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = await createTempDir(t),
      filename = path.join(dir, "workspace.v2.json");
    await fs.writeFile(filename, JSON.stringify({ revision: 1 }));
    const holder = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$taskHandle = [IO.File]::Open($env:RJR_LOCK_TEST_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)\ntry { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $taskHandle.Dispose() }",
      ],
      {
        windowsHide: true,
        env: { ...process.env, RJR_LOCK_TEST_PATH: filename },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error("Synthetic sharing lock helper failed")),
      );
    });
    // Attach a handler immediately so cleanup cannot leave an unhandled rejection.
    exited.catch(() => {});
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("Synthetic sharing lock helper timed out")),
          8000,
        );
        holder.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        holder.once("exit", () => {
          clearTimeout(timeout);
          reject(Error("Sharing lock helper exited before ready"));
        });
        let text = "";
        holder.stdout.on("data", (chunk) => {
          text += chunk;
          if (text.includes("locked")) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      const recoveries = [];
      await writeAtomicJson(
        filename,
        { revision: 2 },
        {
          sleep: async () => {
            holder.stdin.end("release\n");
            await exited;
          },
          onRenameRecovery: (event) => recoveries.push(event),
        },
      );
      assert.equal(recoveries.length, 1);
      assert.equal(recoveries[0].retryCount, 1);
      assert.ok(["EPERM", "EACCES", "EBUSY"].includes(recoveries[0].code));
      assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), {
        revision: 2,
      });
    } finally {
      if (holder.exitCode === null) {
        holder.stdin.end("release\n");
        await exited.catch(() => {});
      }
    }
  },
);
