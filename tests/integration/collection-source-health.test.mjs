import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createFakeClock } from "../helpers/clock.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";
import wechat from "../../src/sources/adapters/wechat-public.mjs";

const checkedAt = "2026-10-11T00:00:00.000Z";
const previousAt = "2026-10-08T00:00:00.000Z";
const description =
  "消防工程师负责消防设施维护、定期检测、隐患排查和设备运行保障，要求本科及以上学历。";
const verifiedRecord = (overrides = {}) =>
  job({
    siteId: "site-0",
    description,
    detailStatus: "complete",
    bodyStatus: "complete",
    retryEligible: false,
    ...overrides,
  });
const providerFor = (
  records,
  { id = "synthetic", category = "job_board" } = {},
) =>
  createPagedProvider({
    id,
    name: "合成来源",
    capabilities: { category },
    listPage: async () => ({ records, hasMore: false }),
  });
async function collect(f, scope = f.scope) {
  const started = await f.service.start({ scope });
  const ref = { scope, activityId: started.activityId };
  await f.service.wait(ref);
  return ref;
}

test("modern page commit replaces stale public source health with body reading proof", async (t) => {
  const f = await collectionFixture(t, {
    clock: createFakeClock(checkedAt),
    providers: [providerFor([verifiedRecord()])],
  });
  await f.repository.mutateWorkspace((w) => {
    w.sourceHealth["synthetic/site-0"] = {
      sourceId: "synthetic",
      siteId: "site-0",
      status: "unavailable",
      checkedAt: previousAt,
      issues: [{ code: "source_budget_exhausted" }],
    };
  });
  await collect(f);
  const w = await f.repository.read();
  const health = w.sourceHealth["synthetic/site-0"];
  assert.equal(health.status, "ready");
  assert.equal(health.checkedAt, checkedAt);
  assert.equal(health.lastAttemptAt, checkedAt);
  assert.equal(health.lastSuccessAt, checkedAt);
  assert.equal(health.sampleCount, 1);
  assert.equal(health.capabilities.list, "verified");
  assert.equal(health.capabilities.body, "verified");
  assert.deepEqual(health.issues, []);
  assert.equal(
    w.packages[f.scope.packageId].collectionSettings?.sourceVerification,
    undefined,
  );
});

test("page health is atomic with records and replay does not invent a new source attempt", async (t) => {
  const f = await collectionFixture(t, { clock: createFakeClock(checkedAt) });
  const c = await f.openCommit();
  const page = {
    pageKey: "page-1",
    records: [verifiedRecord({ siteId: "s" })],
    done: true,
    nextCursor: null,
    issues: [],
  };
  f.armFailure("workspace_commit");
  await assert.rejects(c.commit(page), /storage|write/i);
  assert.equal(
    (await f.repository.read()).sourceHealth["synthetic/s"],
    undefined,
  );
  await c.commit(page);
  const health = (await f.repository.read()).sourceHealth["synthetic/s"];
  assert.equal(health.status, "ready");
  f.clock.advance(60000);
  assert.equal((await c.commit(page)).duplicate, true);
  assert.equal(
    (await f.repository.read()).sourceHealth["synthetic/s"].checkedAt,
    checkedAt,
  );
});

for (const [name, overrides] of [
  ["description only", { bodyStatus: undefined, detailStatus: undefined }],
  ["discovery only", { detailStatus: "discovery_only" }],
  ["incomplete", { bodyStatus: "incomplete", detailStatus: "incomplete" }],
]) {
  test(`modern collection does not claim verified body for ${name}`, async (t) => {
    const f = await collectionFixture(t, {
      clock: createFakeClock(checkedAt),
      providers: [providerFor([verifiedRecord(overrides)])],
    });
    await collect(f);
    const health = (await f.repository.read()).sourceHealth["synthetic/site-0"];
    assert.equal(health.status, "parse_error");
    assert.equal(health.capabilities.list, "verified");
    assert.equal(health.capabilities.body, "unverified");
    assert.equal(health.lastSuccessAt, null);
    assert.equal(health.checkedAt, checkedAt);
  });
}

test("historical reading proof does not grant an expired job a verified application capability", async (t) => {
  const f = await collectionFixture(t, {
    clock: createFakeClock(checkedAt),
    providers: [
      providerFor([
        verifiedRecord({
          deadlineAt: "2026-10-10T00:00:00.000Z",
          applyUrl: "https://jobs.example.org/apply",
          applicationVerification: {
            status: 200,
            formVerified: true,
            checkedAt,
          },
        }),
      ]),
    ],
  });
  await collect(f);
  const w = await f.repository.read();
  const health = w.sourceHealth["synthetic/site-0"];
  assert.equal(health.status, "ready");
  assert.equal(health.capabilities.body, "verified");
  assert.equal(health.capabilities.apply, "unverified");
  assert.equal(
    assessRecruitmentEvidence({
      record: Object.values(w.observations)[0].fields,
      now: f.clock.now(),
    }).openingStatus,
    "expired",
  );
});

test("a fresh verified application form proves application capability separately from body reading", async (t) => {
  const f = await collectionFixture(t, {
    clock: createFakeClock(checkedAt),
    providers: [
      providerFor([
        verifiedRecord({
          deadlineAt: "2026-11-10T00:00:00.000Z",
          applyUrl: "https://jobs.example.org/apply",
          applicationVerification: {
            status: 200,
            formVerified: true,
            checkedAt,
          },
        }),
      ]),
    ],
  });
  await collect(f);
  const health = (await f.repository.read()).sourceHealth["synthetic/site-0"];
  assert.equal(health.capabilities.apply, "verified");
});

test("a challenged page does not promote its returned records to verified body capability", async (t) => {
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成来源",
    capabilities: { category: "job_board" },
    listPage: async () => ({
      records: [verifiedRecord()],
      hasMore: false,
      issues: [{ code: "captcha", message: "private challenge body" }],
    }),
  });
  const f = await collectionFixture(t, {
    clock: createFakeClock(checkedAt),
    providers: [provider],
  });
  await collect(f);
  const health = (await f.repository.read()).sourceHealth["synthetic/site-0"];
  assert.equal(health.status, "restricted");
  assert.equal(health.capabilities.list, "unverified");
  assert.equal(health.capabilities.body, "unverified");
  assert.equal(health.lastSuccessAt, null);
  assert.doesNotMatch(JSON.stringify(health), /private challenge body/);
});

for (const [code, status] of [
  ["restricted", "restricted"],
  ["source_budget_exhausted", "budget_exhausted"],
]) {
  test(`modern list ${code} records its attempt while preserving historical success`, async (t) => {
    const provider = createPagedProvider({
      id: "synthetic",
      name: "合成来源",
      capabilities: { category: "job_board" },
      listPage: async () => {
        throw Object.assign(Error("private error text"), { code });
      },
    });
    const f = await collectionFixture(t, {
      clock: createFakeClock(checkedAt),
      providers: [provider],
    });
    await f.repository.mutateWorkspace((w) => {
      w.sourceHealth["synthetic/site-0"] = {
        sourceId: "synthetic",
        siteId: "site-0",
        status: "ready",
        checkedAt: previousAt,
        lastSuccessAt: previousAt,
        capabilities: { body: "verified" },
      };
    });
    await collect(f);
    const health = (await f.repository.read()).sourceHealth["synthetic/site-0"];
    assert.equal(health.status, status);
    assert.equal(health.checkedAt, checkedAt);
    assert.equal(health.lastSuccessAt, previousAt);
    assert.equal(health.issues[0].code, code);
    assert.doesNotMatch(JSON.stringify(health), /private error text/);
    if (status === "budget_exhausted") assert.equal(health.backoffUntil, null);
  });
}

for (const [id, category] of [
  ["boss", "job_board"],
  ["social-feed", "social"],
  ["social-discovery", "social_discovery"],
]) {
  test(`${id} collection health is persisted only for its owning version`, async (t) => {
    const f = await collectionFixture(t, {
      clock: createFakeClock(checkedAt),
      providers: [
        providerFor([verifiedRecord({ sourceId: id })], { id, category }),
      ],
    });
    await collect(f);
    const w = await f.repository.read();
    const health =
      w.packages[f.scope.packageId].collectionSettings.sourceVerification[
        `${id}/site-0`
      ];
    assert.equal(health.status, "ready");
    assert.equal(health.capabilities.body, "verified");
    assert.equal(health.checkedAt, checkedAt);
    assert.equal(w.sourceHealth[`${id}/site-0`], undefined);
    assert.equal(
      w.packages[f.otherScope.packageId].collectionSettings?.sourceVerification,
      undefined,
    );
  });
}

test("extending the request budget resumes a healthy source without introducing failure cooldown", async (t) => {
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成来源",
    capabilities: { category: "job_board" },
    listPage: async (_site, _query, page, context) => {
      await context.request("https://jobs.example.org/list");
      return {
        records: [
          verifiedRecord({
            sourceRecordId: String(page),
            url: `https://jobs.example.org/${page}`,
          }),
        ],
        hasMore: page < 2,
      };
    },
  });
  const f = await collectionFixture(t, {
    clock: createFakeClock(checkedAt),
    providers: [provider],
    limits: { maxRequests: 1 },
  });
  const ref = await collect(f);
  const exhausted = await f.service.get(ref);
  assert.equal(exhausted.collectionProgress.status, "budget_exhausted");
  await f.service.adjustLimits({
    ref,
    limits: { maxRequests: 2 },
    expectedRevision: exhausted.collectionProgress.revision,
  });
  await f.service.resume({ ref, requestId: "extended-budget" });
  await f.service.wait(ref);
  assert.equal(f.networkCalls, 2);
  const health = (await f.repository.read()).sourceHealth["synthetic/site-0"];
  assert.equal(health.status, "ready");
  assert.equal(health.capabilities.body, "verified");
});

test("the real WeChat capability declaration keeps collection health inside its version", async (t) => {
  const provider = createPagedProvider({
    id: wechat.id,
    name: wechat.name,
    capabilities: wechat.capabilities,
    listPage: async () => ({
      records: [verifiedRecord({ sourceId: "wechat" })],
      hasMore: false,
    }),
  });
  const f = await collectionFixture(t, {
    clock: createFakeClock(checkedAt),
    providers: [provider],
  });
  await collect(f);
  const w = await f.repository.read();
  assert.equal(w.sourceHealth["wechat/site-0"], undefined);
  const owned =
    w.packages[f.scope.packageId].collectionSettings.sourceVerification[
      "wechat/site-0"
    ];
  assert.equal(owned.status, "ready");
  assert.equal(owned.capabilities.body, "verified");
  assert.equal(
    w.packages[f.otherScope.packageId].collectionSettings?.sourceVerification,
    undefined,
  );
});

test("Boss failure preserves this version's prior proof without changing another version", async (t) => {
  const requestId = "q-00000000-0000-4000-8000-000000000001";
  const diagnosticId = "d-00000000-0000-4000-8000-000000000001";
  const provider = createPagedProvider({
    id: "boss",
    name: "Boss",
    capabilities: { category: "job_board" },
    listPage: async () => {
      throw Object.assign(Error("risk"), {
        code: "boss_account_risk",
        requestId,
        diagnosticId,
      });
    },
  });
  const f = await collectionFixture(t, {
    clock: createFakeClock(checkedAt),
    providers: [provider],
  });
  await f.repository.mutateWorkspace((w) => {
    for (const scope of [f.scope, f.otherScope]) {
      w.packages[scope.packageId].collectionSettings ||= {
        sourceOverrides: {},
        sessionRefs: {},
        refreshEnabled: false,
      };
      w.packages[scope.packageId].collectionSettings.sourceVerification = {
        "boss/site-0": {
          sourceId: "boss",
          siteId: "site-0",
          status: "ready",
          checkedAt: previousAt,
          lastSuccessAt: previousAt,
          capabilities: { body: "verified" },
        },
      };
    }
  });
  await collect(f);
  const w = await f.repository.read();
  const owned =
    w.packages[f.scope.packageId].collectionSettings.sourceVerification[
      "boss/site-0"
    ];
  assert.equal(owned.status, "restricted");
  assert.equal(owned.checkedAt, checkedAt);
  assert.equal(owned.lastSuccessAt, previousAt);
  assert.equal(owned.issues[0].code, "boss_account_risk");
  assert.equal(owned.issues[0].requestId, requestId);
  assert.equal(owned.issues[0].diagnosticId, diagnosticId);
  assert.equal(
    w.packages[f.otherScope.packageId].collectionSettings.sourceVerification[
      "boss/site-0"
    ].checkedAt,
    previousAt,
  );
  assert.equal(w.sourceHealth["boss/site-0"], undefined);
});

test("successful pending body retry updates source health after its list page already committed", async (t) => {
  let details = 0;
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成来源",
    capabilities: { category: "job_board" },
    listPage: async () => ({
      records: [
        job({ siteId: "site-0", description: null, bodyStatus: "incomplete" }),
      ],
      hasMore: false,
    }),
    detail: async (r) => {
      details++;
      return details === 1
        ? { ...r, bodyStatus: "incomplete", retryEligible: true }
        : {
            ...r,
            description,
            bodyStatus: "complete",
            detailStatus: "complete",
            retryEligible: false,
          };
    },
  });
  const f = await collectionFixture(t, {
    clock: createFakeClock(checkedAt),
    providers: [provider],
  });
  const ref = await collect(f);
  assert.equal(
    (await f.repository.read()).sourceHealth["synthetic/site-0"].capabilities
      .body,
    "unverified",
  );
  f.clock.advance(60000);
  await f.service.resume({ ref, requestId: "body-retry" });
  await f.service.wait(ref);
  const health = (await f.repository.read()).sourceHealth["synthetic/site-0"];
  assert.equal(health.status, "ready");
  assert.equal(health.capabilities.body, "verified");
  assert.equal(health.checkedAt, "2026-10-11T00:01:00.000Z");
  assert.equal(health.lastSuccessAt, "2026-10-11T00:01:00.000Z");
});
