import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createActivityBudgets } from "../../src/application/collection-ledger.mjs";
import { createJobVerificationService } from "../../src/application/job-verification-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";

const now = Date.parse("2026-10-12T00:00:00Z"),
  clock = { now: () => now },
  site = loadSiteCatalog().find(
    (s) => s.siteId === "official-2ea9828ffe1d2682",
  ),
  applyUrl = "https://www.hzairport.com/talent/detail/id/37.html";
const read = (name) =>
  fs.readFileSync(
    new URL("../fixtures/official-template-repair/" + name, import.meta.url),
    "utf8",
  );
const list = read("hzairport-inline.html"),
  challengedForm = read("hzairport-application-37.html"),
  form = challengedForm.replace(
    '<label>验证码<input type="text" name="verifyCode"></label>',
    "",
  );

async function fixture(
  t,
  {
    provider = true,
    application = form,
    status = 200,
    seedPatch = () => ({}),
    afterResponse,
    signal,
  } = {},
) {
  const f = await collectionFixture(t, {
    clock,
    limits: { maxRequests: 6, maxDetails: 2, maxBytes: 262144 },
  });
  const c = await f.openCommit();
  const seed = (
    await announcements.collectPage({
      site,
      query: { keyword: "机场" },
      context: {
        sites: [site],
        clock,
        request: async (url) => {
          assert.equal(url, site.template.listUrl);
          return { status: 200, url, text: list, headers: {} };
        },
      },
    })
  ).records[0];
  const saved = await c.commit({
    pageKey: "native-seed",
    records: [{ ...seed, ...seedPatch(c) }],
    done: false,
    nextCursor: { page: 2 },
  });
  c.token.expectedRevision = saved.revision;
  const budgets = await createActivityBudgets({
    ledger: f.ledger,
    ref: c.ref,
    token: c.token,
    operationLease: c.lease,
  });
  const calls = [];
  let successes = 0,
    fixtureErrors = 0,
    activityCalls = 0;
  const request = async (url, options = {}) => {
    let response;
    try {
      assert.ok([site.template.listUrl, applyUrl].includes(url));
      assert.ok(!options.method || options.method === "GET");
      response = {
        status: url === applyUrl ? status : 200,
        url,
        text: url === applyUrl ? application : list,
        headers: {},
      };
    } catch (error) {
      fixtureErrors++;
      throw error;
    }
    const bytes = Buffer.byteLength(response.text);
    const reservation = await budgets.sources.claimRequest(
      url === applyUrl ? "application" : "list",
      { bytesUpperBound: bytes },
    );
    calls.push(url);
    successes++;
    await budgets.sources.settleRequest(reservation, { bytes });
    if (url === applyUrl) await afterResponse?.(f, c);
    return response;
  };
  const service = createJobVerificationService({
    repository: f.repository,
    clock,
    registry: createSourceRegistry(provider ? [announcements] : []),
    activityContext: async (ref, callback) => {
      activityCalls++;
      return callback({
        ref,
        token: c.token,
        operationLease: c.lease,
        collectionGuard: { ref, token: c.token },
        budget: budgets.sources,
        request,
        signal,
      });
    },
  });
  const observationCount = async () =>
    Object.keys((await f.repository.read()).observations).length;
  const verification = () =>
    service.verifyJob({ scope: f.scope, jobId: saved.jobIds[0], ref: c.ref });
  return {
    ...f,
    c,
    service,
    collectionService: f.service,
    jobId: saved.jobIds[0],
    calls,
    verification,
    observationCount,
    transportState: () => ({ successes, fixtureErrors, activityCalls }),
  };
}

test("manual native verification reuses the current provider response instead of a second application GET", async (t) => {
  const f = await fixture(t),
    before = await f.observationCount();
  const result = await f.verification();
  assert.equal(result.recruitmentEvidence.applicationStatus, "available");
  assert.deepEqual(f.calls, [site.template.listUrl, applyUrl]);
  assert.deepEqual(f.transportState(), {
    successes: 2,
    fixtureErrors: 0,
    activityCalls: 1,
  });
  assert.equal(await f.observationCount(), before + 1);
  const usage = await f.ledger.snapshot(f.c.ref);
  assert.equal(usage.usedRequests, 2);
  assert.equal(usage.usedDetails, 1);
});

for (const [name, application, status, expected] of [
  ["captcha", challengedForm, 200, "unknown"],
  ["login", "<html><p>请先登录后报名。</p></html>", 401, "login_required"],
])
  test(
    "manual native verification preserves a completed " +
      name +
      " response without repeating GET",
    async (t) => {
      const f = await fixture(t, { application, status });
      const result = await f.verification();
      assert.equal(result.recruitmentEvidence.applicationStatus, expected);
      assert.deepEqual(f.calls, [site.template.listUrl, applyUrl]);
      assert.equal(f.transportState().fixtureErrors, 0);
      assert.equal(f.transportState().successes, 2);
    },
  );

for (const [name, application] of [
  ["wrong ID", form.replace('value="37"', 'value="58"')],
  [
    "wrong title",
    form.replace('value="合成勤务观察员"', 'value="合成其他岗位"'),
  ],
])
  test(
    "manual native response with " +
      name +
      " rejects without persisting available evidence",
    async (t) => {
      const f = await fixture(t, { provider: false, application }),
        before = await f.observationCount();
      await assert.rejects(f.verification(), {
        code: "detail_identity_mismatch",
      });
      assert.deepEqual(f.calls, [applyUrl]);
      assert.equal(f.transportState().successes, 1);
      assert.equal(f.transportState().fixtureErrors, 0);
      assert.equal(await f.observationCount(), before);
    },
  );

test("manual native verification cannot borrow an unrelated form or old generic same-run proof", async (t) => {
  const f = await fixture(t, {
    provider: false,
    application: "<html><form><button>提交申请</button></form></html>",
    seedPatch: (c) => ({
      applicationVerification: {
        status: 200,
        formVerified: true,
        checkedAt: new Date(now).toISOString(),
        checkedUrl: applyUrl,
        checkedInRunId: c.token.sliceRunId,
      },
    }),
  });
  const result = await f.verification();
  assert.equal(result.recruitmentEvidence.applicationStatus, "unknown");
  assert.deepEqual(f.calls, [applyUrl]);
  assert.equal(f.transportState().successes, 1);
  assert.equal(f.transportState().fixtureErrors, 0);
});

test("manual explicit native verification rereads proof left by an earlier call when no provider read occurs now", async (t) => {
  const f = await fixture(t, {
    provider: false,
    seedPatch: (c) => ({
      applicationVerification: {
        status: 200,
        formVerified: true,
        checkedAt: new Date(now).toISOString(),
        checkedUrl: applyUrl,
        checkedInRunId: c.token.sliceRunId,
        nativeJobBinding: {
          contract: "inline-native-job-1",
          siteId: site.siteId,
          sourceRecordId: "37",
          title: "合成勤务观察员",
          applyUrl,
        },
      },
    }),
  });
  const result = await f.verification();
  assert.equal(result.recruitmentEvidence.applicationStatus, "available");
  assert.deepEqual(f.calls, [applyUrl]);
  assert.equal(f.transportState().successes, 1);
  assert.equal(f.transportState().fixtureErrors, 0);
});

test("manual native verification rejects foreign ownership before opening an activity or requesting", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.verifyJob({
      scope: f.otherScope,
      jobId: f.jobId,
      ref: { ...f.c.ref, scope: f.otherScope },
    }),
    { code: "package_scope_mismatch" },
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.transportState(), {
    successes: 0,
    fixtureErrors: 0,
    activityCalls: 0,
  });
});

test("manual native verification cannot commit a late response after the original activity is paused", async (t) => {
  const f = await fixture(t, {
      provider: false,
      afterResponse: (f, c) => f.service.pause(c.ref),
    }),
    before = await f.observationCount();
  await assert.rejects(f.verification(), { code: "collection_stale_epoch" });
  assert.equal(await f.observationCount(), before);
  assert.deepEqual(f.calls, [applyUrl]);
  assert.equal(f.transportState().successes, 1);
  assert.equal(f.transportState().fixtureErrors, 0);
  assert.equal(
    (await f.collectionService.get(f.c.ref)).collectionProgress.status,
    "paused",
  );
});

test("manual native verification cannot persist a reused response after cancellation", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, {
      signal: controller.signal,
      afterResponse: () => controller.abort(),
    }),
    before = await f.observationCount();
  await assert.rejects(f.verification(), { name: "AbortError" });
  assert.equal(await f.observationCount(), before);
  assert.deepEqual(f.calls, [site.template.listUrl, applyUrl]);
  assert.deepEqual(f.transportState(), {
    successes: 2,
    fixtureErrors: 0,
    activityCalls: 1,
  });
  assert.equal((await f.ledger.snapshot(f.c.ref)).usedRequests, 2);
});
