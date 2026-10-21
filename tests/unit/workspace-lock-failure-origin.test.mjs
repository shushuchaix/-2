import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { withWorkspaceLock } from "../../src/infrastructure/storage/lock.mjs";
import { createRecordEnrichment } from "../../src/application/record-enrichment.mjs";

const missing = () => Object.assign(Error("synthetic missing file"), { code: "ENOENT" });
function memoryLock({ stage, failure } = {}) {
  const directory = path.resolve("synthetic-workspace-lock"),
    main = path.join(directory, ".workspace.lock"),
    files = new Map(),
    calls = [];
  const reach = (name) => {
    calls.push(name);
    if (stage === name) throw failure;
  };
  const adapter = {
    async mkdir() { reach("mkdir"); },
    async stat(file) {
      if (!files.has(file)) throw missing();
      return {};
    },
    async open(file) {
      reach("open");
      assert.equal(files.has(file), false);
      files.set(file, "");
      return {
        async writeFile(data) { reach("write"); files.set(file, data); },
        async sync() { reach("sync"); },
        async close() { reach("close"); },
      };
    },
    async link(from, to) {
      reach("link");
      assert.equal(files.has(to), false);
      assert.equal(typeof files.get(from), "string");
      files.set(to, files.get(from));
    },
    async readFile(file) {
      if (file === main) reach("ownerread");
      if (!files.has(file)) throw missing();
      return files.get(file);
    },
    async unlink(file) {
      if (file === main) reach("unlink");
      if (!files.delete(file)) throw missing();
    },
  };
  return { directory, main, files, calls, adapter };
}

for (const stage of ["mkdir", "open", "write", "sync", "close", "link", "ownerread", "unlink"]) {
  test(`workspace lock marks only the final ${stage} coordination failure`, async () => {
    const cause = Error("synthetic original cause"),
      failure = Object.assign(Error("synthetic coordination failure", { cause }), { code: "EIO" }),
      fixture = memoryLock({ stage, failure });
    let entered = 0;
    await assert.rejects(
      withWorkspaceLock(fixture.directory, () => { entered++; }, {
        fsAdapter: fixture.adapter,
        platform: "win32",
      }),
      (error) => {
        assert.equal(error, failure);
        assert.equal(error.cause, cause);
        assert.equal(error.code, "EIO");
        assert.equal(error.runFatal, true);
        assert.equal(error.storageOperation, "workspace.lock." +
          (["ownerread", "unlink"].includes(stage) ? "release" : "acquire"));
        return true;
      },
    );
    assert.equal(entered, ["ownerread", "unlink"].includes(stage) ? 1 : 0);
  });
}

test("workspace lock timeout is a fatal coordination result, not a callback error", async () => {
  const collision = Object.assign(Error("synthetic occupied lock"), { code: "EEXIST" }),
    fixture = memoryLock({ stage: "link", failure: collision });
  let entered = false;
  await assert.rejects(withWorkspaceLock(fixture.directory, () => { entered = true; }, {
    timeoutMs: 0,
    fsAdapter: fixture.adapter,
  }), (error) => {
    assert.match(error.message, /Workspace busy/);
    assert.equal(error.runFatal, true);
    assert.equal(error.storageOperation, "workspace.lock.acquire");
    return true;
  });
  assert.equal(entered, false);
  // A retryable collision itself is not misclassified as a terminal failure.
  assert.equal(collision.runFatal, undefined);
});

for (const code of ["ECONNRESET", "EIO", "ordinary_business_error"]) {
  test(`workspace lock does not mark callback ${code} as storage failure`, async () => {
    const fixture = memoryLock(), failure = Object.assign(Error("synthetic callback failure"), { code });
    await assert.rejects(withWorkspaceLock(fixture.directory, async () => { throw failure; }, {
      fsAdapter: fixture.adapter,
    }), (error) => error === failure);
    assert.equal(failure.runFatal, undefined);
    assert.equal(failure.storageOperation, undefined);
    assert.equal(fixture.files.has(fixture.main), false);
  });
}

test("a frozen coordination error is explicitly wrapped with its original code and cause", async () => {
  const failure = Object.freeze(Object.assign(Error("synthetic frozen failure"), { code: "ENOSPC" })),
    fixture = memoryLock({ stage: "sync", failure });
  await assert.rejects(withWorkspaceLock(fixture.directory, () => assert.fail("must not enter"), {
    fsAdapter: fixture.adapter,
  }), (error) => {
    assert.notEqual(error, failure);
    assert.equal(error.cause, failure);
    assert.equal(error.code, "ENOSPC");
    assert.equal(error.runFatal, true);
    assert.equal(error.storageOperation, "workspace.lock.acquire");
    return true;
  });
  assert.equal(failure.runFatal, undefined);
});

test("a frozen callback error retains its identity without storage classification", async () => {
  const fixture = memoryLock(), failure = Object.freeze(Object.assign(Error("synthetic callback"), { code: "EIO" }));
  await assert.rejects(withWorkspaceLock(fixture.directory, () => { throw failure; }, {
    fsAdapter: fixture.adapter,
  }), (error) => error === failure);
  assert.equal(fixture.files.has(fixture.main), false);
});

test("an error with a non-writable classification is wrapped instead of losing fatal origin", async () => {
  const failure = Object.assign(Error("synthetic non-writable classification"), { code: "EIO" });
  Object.defineProperty(failure, "runFatal", { value: false, writable: false });
  const fixture = memoryLock({ stage: "ownerread", failure });
  await assert.rejects(withWorkspaceLock(fixture.directory, () => {}, {
    fsAdapter: fixture.adapter,
  }), (error) => {
    assert.equal(error.cause, failure);
    assert.equal(error.code, "EIO");
    assert.equal(error.runFatal, true);
    assert.equal(error.storageOperation, "workspace.lock.release");
    return true;
  });
  assert.equal(failure.runFatal, false);
});

test("workspace lock success retains the callback result and sync-before-publication order", async () => {
  const fixture = memoryLock(), result = { synthetic: true };
  assert.equal(await withWorkspaceLock(fixture.directory, () => result, {
    fsAdapter: fixture.adapter,
  }), result);
  assert.ok(fixture.calls.indexOf("sync") < fixture.calls.indexOf("link"));
  assert.equal(fixture.files.size, 0);
});

test("application enrichment propagates a real lock coordination failure without degrading it to unknown", async () => {
  const failure = Object.assign(Error("synthetic coordination has no disk space"), { code: "ENOSPC" }),
    fixture = memoryLock({ stage: "mkdir", failure }),
    now = Date.parse("2026-10-21T00:00:00Z"),
    input = {
      sourceId: "synthetic",
      siteId: "synthetic-site",
      kind: "job",
      sourceRecordId: "one",
      title: "机场消防工程师",
      url: "https://jobs.example.org/jobs/one",
      applyUrl: "https://jobs.example.org/apply/one",
      description: "消防工程师负责机场消防设施检测维护。要求消防工程专业、本科。报名截止：2026年12月31日。",
      bodyStatus: "complete",
      detailStatus: "complete",
    };
  let requests = 0, callbacks = 0;
  await assert.rejects(createRecordEnrichment({ clock: { now: () => now } })(input, {
    runId: "synthetic-lock-failure-run",
    request: async (url) => {
      requests++;
      assert.equal(url, input.applyUrl);
      return withWorkspaceLock(fixture.directory, () => {
        callbacks++;
        assert.fail("failed coordination must not enter the request callback");
      }, { fsAdapter: fixture.adapter });
    },
  }), (error) => {
    assert.equal(error, failure);
    assert.equal(error.code, "ENOSPC");
    assert.equal(error.runFatal, true);
    assert.equal(error.storageOperation, "workspace.lock.acquire");
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(callbacks, 0);
  assert.deepEqual(fixture.calls, ["mkdir"]);
  assert.equal(input.applicationVerification, undefined);
});
