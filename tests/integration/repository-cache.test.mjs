import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createTempDir } from "../helpers/fixtures.mjs";
import { packageFixture } from "../helpers/package-fixture.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";

async function fixture(t) {
  const dataDir = await createTempDir(t);
  let reads = 0, failure = false;
  const fsAdapter = { ...fs,
    async readFile(file, ...args) {
      if (String(file).endsWith("workspace.v2.json")) reads++;
      return fs.readFile(file, ...args);
    },
    async rename(from, to) {
      if (failure && String(to).endsWith("workspace.v2.json")) {
        failure = false;
        throw Error("synthetic main replacement failure");
      }
      return fs.rename(from, to);
    },
  };
  const repository = await openWorkspaceRepository({ dataDir, fsAdapter, allowLegacy: true });
  await repository.mutateWorkspace(w => { w.settings.cacheProbe = "first"; });
  return { repository, dataDir, main: path.join(dataDir, "workspace.v2.json"),
    reads: () => reads, fail: () => { failure = true; } };
}

test("unchanged public reads reuse validated disk data and return isolated nested values", async t => {
  const f = await fixture(t);
  await f.repository.read();
  const before = f.reads();
  const a = await f.repository.read();
  a.settings.cacheProbe = "mutated";
  a.recoveryRecords.push({ message: "must not escape" });
  const b = await f.repository.read();
  assert.equal(b.settings.cacheProbe, "first");
  assert.deepEqual(b.recoveryRecords, []);
  assert.equal(f.reads(), before, "unchanged reads must not reread the entire JSON");
});

test("a successful Windows save seeds the cache without a subsequent full read", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), before = f.reads();
  await f.repository.read();
  assert.equal(f.reads(), before);
});

test("same-size external replacement and same-size in-place change invalidate the cache", async t => {
  const f = await fixture(t);
  await f.repository.read();
  const original = await fs.readFile(f.main, "utf8");
  await fs.writeFile(f.main + ".replacement", original.replace('"first"', '"other"'));
  await fs.rename(f.main + ".replacement", f.main);
  assert.equal((await fs.stat(f.main)).size, Buffer.byteLength(original));
  assert.equal((await f.repository.read()).settings.cacheProbe, "other");
  const before = await fs.stat(f.main);
  const raw = await fs.readFile(f.main, "utf8");
  await fs.writeFile(f.main, raw.replace('"other"', '"third"'));
  await fs.utimes(f.main, before.atime, before.mtime);
  assert.equal((await f.repository.read()).settings.cacheProbe, "third");
});

test("failed mutation and failed replacement never publish uncommitted values", async t => {
  const f = await fixture(t);
  await assert.rejects(f.repository.mutateWorkspace(w => {
    w.settings.cacheProbe = "failed callback";
    throw Error("synthetic mutation failure");
  }), /synthetic mutation/);
  assert.equal((await f.repository.read()).settings.cacheProbe, "first");
  f.fail();
  await assert.rejects(f.repository.mutateWorkspace(w => {
    w.settings.cacheProbe = "failed write";
  }), /synthetic main replacement/);
  assert.equal((await f.repository.read()).settings.cacheProbe, "first");
  await f.repository.mutateWorkspace(w => { w.settings.cacheProbe = "saved"; });
  assert.equal((await f.repository.read()).settings.cacheProbe, "saved");
});

test("external corruption fails closed and a repaired file is read afresh", async t => {
  const f = await fixture(t);
  const good = await fs.readFile(f.main, "utf8");
  await fs.writeFile(f.main, "{broken");
  await assert.rejects(f.repository.read(), /corrupt/i);
  await fs.writeFile(f.main, good);
  assert.equal((await f.repository.read()).settings.cacheProbe, "first");
  await fs.writeFile(f.main, JSON.stringify({ schemaVersion: 99 }));
  await assert.rejects(f.repository.read(), /schema/i);
});

test("two cached repository instances observe every serialized commit", async t => {
  const f = await fixture(t);
  const other = await openWorkspaceRepository({ dataDir: f.dataDir, allowLegacy: true });
  await Promise.all(Array.from({ length: 16 }, (_, i) =>
    (i % 2 ? f.repository : other).mutateWorkspace(w => {
      w.recoveryRecords.push({ message: String(i) });
    })));
  for (const repository of [f.repository, other]) {
    const w = await repository.read();
    assert.equal(w.recoveryRecords.length, 16);
    assert.equal(w.revision, 17);
  }
});

test("retaining a mutation or maintenance reference cannot change a committed cache", async t => {
  const f = await fixture(t);
  let retained;
  await f.repository.mutateWorkspace(w => { retained = w; w.settings.cacheProbe = "saved"; });
  retained.settings.cacheProbe = "outside";
  const tx = await f.repository.withMaintenanceTransaction(tx => tx);
  tx.workspace.settings.cacheProbe = "maintenance outside";
  assert.equal((await f.repository.read()).settings.cacheProbe, "saved");
});

test("a mutation draft remains separate from the transaction's committed view", async t => {
  const f = await fixture(t);
  await f.repository.mutateWorkspace((draft, tx) => {
    draft.settings.cacheProbe = "changed";
    assert.equal(tx.workspace.settings.cacheProbe, "first");
    tx.workspace.recoveryRecords.push({ message: "separate transaction view" });
    assert.deepEqual(draft.recoveryRecords, []);
  });
  assert.equal((await f.repository.read()).settings.cacheProbe, "changed");
  assert.deepEqual((await f.repository.read()).recoveryRecords, []);
});

test("maintenance edits preserve the actual prior committed revision in previous.json", async t => {
  const f = await fixture(t);
  await f.repository.withMaintenanceTransaction(async tx => {
    tx.workspace.settings.cacheProbe = "changed";
    await tx.commitWorkspace(tx.workspace);
  });
  const previous = JSON.parse(await fs.readFile(path.join(f.dataDir, "workspace.v2.previous.json"), "utf8"));
  assert.equal(previous.revision, 1);
  assert.equal(previous.settings.cacheProbe, "first");
  assert.equal((await f.repository.read()).settings.cacheProbe, "changed");
});

test("adapters without stat keep the uncached read path", async t => {
  const f = await fixture(t);
  const repository = await openWorkspaceRepository({ dataDir: f.dataDir,
    fsAdapter: { ...fs, stat: undefined }, allowLegacy: true });
  await fs.writeFile(f.main, (await fs.readFile(f.main, "utf8")).replace('"first"', '"other"'));
  assert.equal((await repository.read()).settings.cacheProbe, "other");
});

test("a post-save cache stat failure does not report a failed durable save", async t => {
  const dataDir = await createTempDir(t);
  let failStat = false;
  const repository = await openWorkspaceRepository({ dataDir, allowLegacy: true,
    fsAdapter: { ...fs,
      async stat(...args) {
        if (failStat) { failStat = false; throw Object.assign(Error("synthetic cache stat"), { code: "EACCES" }); }
        return fs.stat(...args);
      },
      async rename(...args) {
        await fs.rename(...args);
        if (String(args[1]).endsWith("workspace.v2.json")) failStat = true;
      },
    },
  });
  await repository.mutateWorkspace(w => { w.settings.cacheProbe = "durable"; });
  assert.equal((await repository.read()).settings.cacheProbe, "durable");
});

test("internal main and previous snapshots use compact JSON without changing their data", async t => {
  const f = await fixture(t);
  const before = await f.repository.read();
  await f.repository.mutateWorkspace(w => { w.settings.multiline = "line one\nline two"; });
  for (const name of ["workspace.v2.json", "workspace.v2.previous.json"]) {
    const raw = await fs.readFile(path.join(f.dataDir, name), "utf8");
    assert.equal(raw, JSON.stringify(JSON.parse(raw)));
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir, "workspace.v2.previous.json"), "utf8")), before);
  assert.equal((await f.repository.read()).settings.multiline, "line one\nline two");
});

test("cached reads preserve JSON round-trip behavior for dates, omissions and numeric values", async t => {
  const sparseWithExtra = [, "value"];
  sparseWithExtra.extra = "ignored by JSON";
  for (const [name, value] of Object.entries({ date: new Date("2026-10-16T00:00:00.000Z"),
    omitted: undefined, numeric: NaN, negativeZero: -0, sparse: [, "value"], sparseWithExtra })) {
    await t.test(name, async t => {
      const f = await fixture(t);
      await f.repository.mutateWorkspace(w => { w.settings.jsonValues = { value }; });
      const persisted = JSON.parse(await fs.readFile(f.main, "utf8"));
      assert.deepEqual(await f.repository.read(), persisted);
    });
  }
});

test("an external main replacement between save and stat is never bound to the saved cache", async t => {
  const f = await fixture(t);
  let inject = false;
  const repository = await openWorkspaceRepository({ dataDir: f.dataDir, allowLegacy: true,
    fsAdapter: { ...fs,
      async rename(...args) { await fs.rename(...args); if (String(args[1]) === f.main) inject = true; },
      async stat(file, ...args) {
        if (inject && String(file) === f.main) {
          inject = false;
          const raw = (await fs.readFile(f.main, "utf8")).replace('"saved"', '"other"');
          await fs.writeFile(f.main + ".external", raw);
          await fs.rename(f.main + ".external", f.main);
        }
        return fs.stat(file, ...args);
      },
    },
  });
  await repository.mutateWorkspace(w => { w.settings.cacheProbe = "saved"; });
  assert.equal((await repository.read()).settings.cacheProbe, "other");
  assert.equal((await repository.read()).settings.cacheProbe, "other");
});

test("an external deletion ledger change during save cannot be hidden by a newly published cache", async t => {
  const f = await packageFixture(t), packageId = randomUUID(), recordId = randomUUID();
  await f.repository.mutateWorkspace(w => {
    w.packages[packageId] = { packageId, kind: "profile", state: "active", enabled: true,
      versionId: "p@1", versionName: "Synthetic only", archiveId: null, archivedAt: null, purgeAt: null };
    w.profiles.p = [{ recordId, ownerPackageId: packageId, revisionId: "p@1", text: "SYNTHETIC BODY" }];
  });
  const main = path.join(f.dataDir, "workspace.v2.json"), state = path.join(f.dataDir, "control/state.json");
  let inject = false;
  const repository = await openWorkspaceRepository({ dataDir: f.dataDir, allowLegacy: true,
    fsAdapter: { ...fs,
      async rename(...args) { await fs.rename(...args); if (String(args[1]) === main) inject = true; },
      async stat(file, ...args) {
        if (inject && String(file) === main) {
          inject = false;
          const { checksum: ignored, ...control } = JSON.parse(await fs.readFile(state, "utf8"));
          control.deletionLedger[packageId] = { phase: "purged", recordIds: [recordId] };
          const checksum = createHash("sha256").update(JSON.stringify(control)).digest("hex");
          await fs.writeFile(state + ".external", JSON.stringify({ ...control, checksum }));
          await fs.rename(state + ".external", state);
        }
        return fs.stat(file, ...args);
      },
    },
  });
  await repository.mutateWorkspace(w => { w.settings.cacheProbe = "saved"; });
  const next = await repository.read();
  assert.equal(next.packages[packageId], undefined);
  assert.deepEqual(next.profiles, {});
});
