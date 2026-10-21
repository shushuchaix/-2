import test from "node:test";
import assert from "node:assert/strict";
import { handleCollectionRequest } from "../../src/server/collection-routes.mjs";
const scope = {
  packageId: "00000000-0000-4000-8000-000000000001",
  targetRevisionId: "t1@1",
};

function fixture(input = {}) {
  const calls = [],
    sent = [];
  const context = {
    collectionService: {
      resume: async (value) => {
        calls.push(value);
        return { status: "paused", skipped: true };
      },
    },
    http: {
      readJson: async () => ({
        ...scope,
        requestId: "startup-synthetic",
        mode: "rules",
        ...input,
      }),
      json: (_req, _res, status, data) => sent.push({ status, data }),
    },
  };
  return {
    context,
    calls,
    sent,
    req: { url: "/api/v2/collections/activity-A/resume", method: "POST" },
  };
}
test("startup continuation passes automatic=true to the existing service without credentials", async () => {
  const f = fixture({ automatic: true });
  await handleCollectionRequest(f.req, {}, f.context);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].automatic, true);
  assert.equal(f.calls[0].mode, "rules");
  assert.deepEqual(f.calls[0].credentials, {});
  assert.deepEqual(f.calls[0].ref.scope, scope);
  assert.equal(f.sent[0].data.skipped, true);
});
test("existing explicit continuation remains manual", async () => {
  const f = fixture();
  await handleCollectionRequest(f.req, {}, f.context);
  assert.equal(f.calls[0].automatic, false);
});
for (const value of ["true", 1, null, {}])
  test(
    "invalid automatic flag is rejected before collection mutation " +
      JSON.stringify(value),
    async () => {
      const f = fixture({ automatic: value });
      await assert.rejects(handleCollectionRequest(f.req, {}, f.context), {
        code: "validation_failed",
      });
      assert.equal(f.calls.length, 0);
    },
  );
