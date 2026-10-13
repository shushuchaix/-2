import test from "node:test";
import assert from "node:assert/strict";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { createConditionalCache } from "../../src/infrastructure/http/conditional-cache.mjs";
async function setup(t) {
  const f = await packageBusinessFixture(t),
    { a, b } = await f.twoTargets();
  const scope = { packageId: a.packageId, targetRevisionId: a.revisionId },
    other = { packageId: b.packageId, targetRevisionId: b.revisionId };
  const lease = await f.operationGate.acquire("collect", { scope });
  t.after(() => lease.release().catch(() => {}));
  return {
    ...f,
    scope,
    other,
    lease,
    cache: createConditionalCache({ repository: f.repository }),
  };
}
test("304_and_unchanged_body_reuse_owned_evidence_without_reparsing", async (t) => {
  const f = await setup(t);
  let parses = 0,
    calls = 0;
  const input = {
    scope: f.scope,
    resourceKey: "public-document",
    url: "https://jobs.example.com/one",
    operationLease: f.lease,
    parserVersion: "v1",
    parse: async () => {
      parses++;
      return { title: "合成岗位", modelCalls: 0 };
    },
  };
  const request = async (_url, options) => {
    calls++;
    if (calls === 2) {
      assert.equal(options.headers["If-None-Match"], '"v1"');
      return { status: 304, headers: {}, text: "" };
    }
    return { status: 200, headers: { etag: '"v1"' }, text: "synthetic body" };
  };
  await f.cache.read({ ...input, request });
  f.clock.advance(1000);
  const after304 = await f.cache.read({ ...input, request });
  assert.equal(after304.reused, true);
  assert.equal(after304.evidence.modelCalls, 0);
  assert.equal(after304.checkedAt, new Date(f.clock.now()).toISOString());
  await f.cache.read({ ...input, request });
  assert.equal(parses, 1);
  assert.equal(
    await f.cache.get({ scope: f.other, resourceKey: input.resourceKey }),
    null,
  );
  await f.reopen();
  assert.ok(
    await createConditionalCache({ repository: f.repository }).get(input),
  );
  assert.equal(
    Object.keys((await f.repository.read()).settings).some((k) =>
      /cache/i.test(k),
    ),
    false,
  );
});
test("304_without_matching_parser_evidence_is_pending_and_cannot_cross_scope", async (t) => {
  const f = await setup(t),
    base = {
      scope: f.scope,
      resourceKey: "one",
      operationLease: f.lease,
      url: "https://jobs.example.com/one",
    };
  const missing = await f.cache.read({
    ...base,
    parserVersion: "v1",
    request: async () => ({ status: 304, headers: {} }),
  });
  assert.equal(missing.needsBody, true);
  await f.cache.read({
    ...base,
    parserVersion: "v1",
    request: async () => ({
      status: 200,
      headers: { etag: "x" },
      text: "body",
    }),
    parse: async () => ({ title: "test" }),
  });
  const changed = await f.cache.read({
    ...base,
    parserVersion: "v2",
    request: async (_url, options) => {
      assert.deepEqual(options.headers, {});
      return { status: 304, headers: {} };
    },
  });
  assert.equal(changed.needsBody, true);
  await assert.rejects(
    f.cache.put({
      ...base,
      scope: f.other,
      bodyHash: "a".repeat(64),
      parsedEvidence: {},
    }),
    { code: "invalid_operation_lease" },
  );
});

test("declining cached evidence forces a full body before reparse without changing the parser version", async (t) => {
  const f = await setup(t);
  let calls = 0,
    parses = 0;
  const input = {
    scope: f.scope,
    resourceKey: "synthetic-pending-conversion",
    url: "https://jobs.example.com/pending.doc",
    operationLease: f.lease,
    parserVersion: "attachment-v1",
    request: async (_url, options) => {
      calls++;
      if (calls > 1) assert.deepEqual(options.headers, {});
      return options.headers["If-None-Match"]
        ? { status: 304, headers: {} }
        : {
            status: 200,
            headers: { etag: '"same-bytes"' },
            text: "unchanged public bytes",
          };
    },
    parse: async () => ({ status: ++parses === 1 ? "pending" : "extracted" }),
  };
  await f.cache.read(input);
  const retried = await f.cache.read({
    ...input,
    canReuseEvidence: async (evidence) => evidence.status === "extracted",
  });
  assert.equal(retried.evidence.status, "extracted");
  assert.equal(retried.reused, false);
  assert.equal(parses, 2);
  assert.equal(calls, 2);
  assert.equal((await f.cache.get(input)).parserVersion, "attachment-v1");
});

test("an unsolicited 304 cannot restore evidence rejected by a reuse policy", async (t) => {
  const f = await setup(t);
  const input = {
    scope: f.scope,
    resourceKey: "synthetic-unexpected-304",
    url: "https://jobs.example.com/pending.doc",
    operationLease: f.lease,
    parserVersion: "attachment-v1",
  };
  await f.cache.read({
    ...input,
    request: async () => ({
      status: 200,
      headers: { etag: '"same-bytes"' },
      text: "public bytes",
    }),
    parse: async () => ({ status: "pending" }),
  });
  const retry = await f.cache.read({
    ...input,
    canReuseEvidence: () => false,
    request: async (_url, options) => {
      assert.deepEqual(options.headers, {});
      return { status: 304, headers: {} };
    },
    parse: () => {
      throw Error("A 304 has no document bytes to parse");
    },
  });
  assert.equal(retry.needsBody, true);
  assert.equal(retry.reused, false);
  assert.equal(retry.evidence, undefined);
});
