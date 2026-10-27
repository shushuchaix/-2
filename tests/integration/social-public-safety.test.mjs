import test from "node:test";
import assert from "node:assert/strict";
import { createContentReadService } from "../../src/application/content-read-service.mjs";
import { isOperationControlError } from "../../src/domain/operation-control.mjs";
import { parseSocialResponse, weiboPostIdentity } from "../../src/sources/social-content.mjs";
import { safeSourceIssues, normalizeSourceStatus } from "../../src/sources/source-status.mjs";
import wechat from "../../src/sources/adapters/wechat-public.mjs";
import weibo from "../../src/sources/adapters/weibo-public.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { readProviderPage } from "../../src/sources/collection-page.mjs";

const article = "https://mp.weixin.qq.com/s/synthetic-public-article";
const input = { providerId: "wechat", url: article, ref: { scope: { packageId: "synthetic", targetRevisionId: "synthetic-r1" }, activityId: "synthetic-root" }, token: {} };
const shell = { status: 200, text: "<main>公开空壳</main>" };
const postUrl = id => "https://m.weibo.cn/detail/" + id;
const postRecord = id => ({ sourceId: "weibo", siteId: "weibo", sourceRecordId: id, url: postUrl(id) });
const body = "合成企业招聘消防工程师，岗位职责为消防检查、维护与培训，要求本科消防工程专业。";
const reply = data => ({ status: 200, text: JSON.stringify({ ok: 1, data }) });

test("production control predicate uses finite lifecycle codes, AbortError and runFatal only", () => {
  for (const error of [{ runFatal: true }, { name: "AbortError" }, { code: "invalid_operation_lease" }, { code: "workspace_fence_closed" }, { code: "package_expired" }, { code: "version_disabled" }])
    assert.equal(isOperationControlError(error), true);
  for (const code of ["campaign_arbitrary_private_value", "continuation_arbitrary_private_value", "workspace_arbitrary", "package_arbitrary", "ECONNRESET", "parse_error", "collection_probe_unavailable"])
    assert.equal(isOperationControlError({ code }), false);
});

for (const channel of ["http", "browser", "worker"]) {
  for (const failure of [Object.assign(Error("synthetic private text"), { runFatal: true, code: "ENOSPC" }),
    Object.assign(Error("synthetic private text"), { code: "invalid_operation_lease" }),
    Object.assign(Error("synthetic private text"), { name: "AbortError" }),
    Object.assign(Error("synthetic private text"), { code: "package_scope_mismatch" })]) {
    test(`reader preserves the same trusted error at ${channel}: ${failure.code || failure.name}`, async () => {
      const calls = { http: 0, browser: 0, worker: 0 };
      const service = createContentReadService({
        request: async () => { calls.http++; if (channel === "http") throw failure; return shell; },
        ...(channel === "browser" ? { browser: { read: async () => { calls.browser++; throw failure; } } } : {}),
        anonymousWorker: { probe: () => ({ capabilities: { enhanced: true } }), read: async () => { calls.worker++; throw failure; } },
      });
      await assert.rejects(service.read(input), error => error === failure);
      assert.equal(calls.http, 1);
      assert.equal(calls.browser, Number(channel === "browser"));
      assert.equal(calls.worker, Number(channel === "worker"));
    });
  }
}

test("ordinary request failures stay incomplete and never forward arbitrary private codes", async () => {
  for (const code of ["ECONNRESET", "campaign_private_text", "continuation_private_text", "workspace_unknown_private_text"]) {
    const reader = createContentReadService({ request: async () => { throw Object.assign(Error("synthetic-private-body"), { code }); } });
    const result = await reader.read({ providerId: "wechat", url: article });
    assert.equal(result.bodyStatus, "incomplete");
    assert.equal(result.code, code === "ECONNRESET" ? "network_error" : "body_unverified");
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test("reader control failures survive shared social collect and probe without replacement", async () => {
  const failure = Object.assign(Error("synthetic fatal"), { runFatal: true, code: "ENOSPC" });
  const reader = createContentReadService({ request: async () => { throw failure; } });
  const context = { sites: [{ siteId: "wechat" }], config: { wechat: { articleUrls: [article] } }, readService: reader };
  await assert.rejects(wechat.probe(context), error => error === failure);
  await assert.rejects(wechat.collect({ sites: [{ siteId: "wechat" }],
    config: { wechat: { accountIds: ["syntheticBiz="] } }, request: async () => reader.read(input) }), error => error === failure);
});

test("missing public social seeds are configuration gaps, never authentication failures", async () => {
  for (const provider of [wechat, weibo]) {
    let calls = 0;
    const context = { sites: [{ siteId: provider.id }], config: { [provider.id]: {} }, request: async () => { calls++; throw Error("must not call"); } };
    const page = await provider.collectPage({ site: context.sites[0], context });
    const issues = safeSourceIssues(page.issues, provider.id, provider.id);
    assert.deepEqual(issues, [{ code: "not_configured", sourceId: provider.id, siteId: provider.id, retryable: false, configurationReason: "public_seeds_required" }]);
    assert.equal(normalizeSourceStatus({ status: "unavailable", issues }), "not_configured");
    const probe = await provider.probe(context);
    assert.equal(probe.status, "not_configured");
    assert.equal(probe.issues[0].configurationReason, "public_seeds_required");
    assert.equal(calls, 0);
  }
});

test("Weibo authority IDs prefer idstr and never manufacture a rounded number identity", () => {
  assert.equal(weiboPostIdentity({ idstr: "9007199254740993", id: 9007199254740992 }), "9007199254740993");
  assert.equal(weiboPostIdentity({ id: 123 }), "123");
  for (const post of [{ id: 9007199254740992 }, { id: -1 }, { id: 1.5 }, { idstr: "bid" }, { idstr: "123", id: "124" }, { id: "00123" }])
    assert.equal(weiboPostIdentity(post), null);
});

test("Weibo show must bind a returned native post ID to the seed before accepting its body", async () => {
  for (const data of [{ idstr: "124", text: body }, { id: 9007199254740992, text: body }, { text: body }]) {
    let calls = 0;
    await assert.rejects(weibo.fetchDetail(postRecord("123"), { request: async () => { calls++; return reply(data); } }), { code: "detail_identity_mismatch" });
    assert.equal(calls, 1);
  }
  const result = await weibo.fetchDetail(postRecord("9007199254740993"), { request: async () => reply({ idstr: "9007199254740993", id: 9007199254740992, text: body }) });
  assert.equal(result.bodyStatus, "complete");
  assert.equal(result.sourceRecordId, "9007199254740993");
  await assert.rejects(weibo.fetchDetail(postRecord("123"), { request: async () => ({ status: 200, text: JSON.stringify({ ok: 0, data: { id: "123", text: body } }) }) }), { code: "parse_error" });
});

test("unsupported bid and conflicting seed URL cannot cause an anonymous request", async () => {
  let calls = 0;
  const context = { request: async () => { calls++; throw Error("must not request"); } };
  await assert.rejects(weibo.fetchDetail(postRecord("AbCd123"), context), { code: "detail_identity_unsupported" });
  await assert.rejects(weibo.fetchDetail({ ...postRecord("123"), url: postUrl("124") }, context), { code: "detail_identity_mismatch" });
  assert.equal(calls, 0);
});
test("the real Weibo public article seed survives page normalization as discovery notice without requesting body", async () => {
  let requests = 0;
  const page = await readProviderPage(weibo, { site: { siteId: "weibo", providerId: "weibo" }, query: { keyword: "消防" },
    context: { config: { weibo: { articleUrls: [postUrl("123")] } }, request: async () => { requests++; assert.fail("seed collection is not a body request"); } } });
  assert.equal(page.records.length, 1); assert.equal(page.records[0].evidenceLevel, "discovery");
  assert.equal(page.records[0].kind, "recruitment_notice"); assert.equal(page.records[0].bodyStatus, "incomplete");
  assert.equal(requests, 0);
});

test("Weibo extend missing native identity stays incomplete; a different ID fails and matching full body succeeds", async () => {
  for (const [data, expected] of [[{ longTextContent: body }, "incomplete"], [{ idstr: "123", longTextContent: body }, "complete"],
    [{ idstr: "123", longTextContent: "公司招聘……" }, "incomplete"]]) {
    const result = await weibo.fetchDetail({ ...postRecord("123"), post: { idstr: "123", isLongText: true, text: "公司招聘……" } }, { request: async () => reply(data) });
    assert.equal(result.bodyStatus, expected);
  }
  await assert.rejects(weibo.fetchDetail({ ...postRecord("123"), post: { id: "123", isLongText: true, text: "公司招聘……" } },
    { request: async () => reply({ idstr: "124", longTextContent: body }) }), { code: "detail_identity_mismatch" });
});

test("public reader JSON binding and redirect identity protect the same Weibo seed", async () => {
  assert.throws(() => parseSocialResponse({ platform: "weibo", url: postUrl("123"), status: 200, text: JSON.stringify({ data: { idstr: "124", text: body } }) }), { code: "detail_identity_mismatch" });
  const missing = parseSocialResponse({ platform: "weibo", url: postUrl("123"), status: 200, text: JSON.stringify({ data: { longTextContent: body } }) });
  assert.equal(missing.bodyStatus, "incomplete");
  const reader = createContentReadService({ request: async () => ({ status: 200, url: postUrl("124"), text: '<div class="weibo-text">' + body + '</div>' }) });
  const result = await reader.read({ providerId: "weibo", url: postUrl("123") });
  assert.equal(result.bodyStatus, "incomplete");
  assert.equal(result.code, "detail_identity_mismatch");
  assert.equal(result.description, undefined);
});

test("schema3 source probe preserves reader/shared lifecycle errors and releases its real lease", async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets();
  const scope = { packageId: a.packageId, targetRevisionId: a.revisionId };
  let failure, calls = 0;
  const reader = createContentReadService({ request: async () => { calls++; throw failure; } });
  const service = createSourceService({ repository: f.repository, operationGate: f.operationGate,
    registry: createSourceRegistry([wechat]), catalog: [{ siteId: "wechat", providerId: "wechat", name: "合成公开来源", origin: "https://mp.weixin.qq.com" }],
    clock: f.clock, requestFactory: () => async () => reader.read(input) });
  await service.saveScopedConfig({ scope, sourceId: "wechat", config: { accountIds: ["syntheticBiz="] } });
  for (const code of ["invalid_operation_lease", "package_expired", "collection_cancelled"]) {
    failure = Object.assign(Error("synthetic lifecycle failure"), { code });
    await assert.rejects(service.probeScopedSource({ scope, sourceId: "wechat", siteId: "wechat" }), error => error === failure);
  }
  assert.equal(calls, 3);
  const leases = await f.repository.queryRows({ collection: "operationLeases", ownerPackageId: scope.packageId, limit: 200 }, { scope });
  assert.equal(leases.rows.length, 0);
});

test("legacy source probe preserves reader/shared lifecycle errors without saving false source failure", async () => {
  const failure = Object.assign(Error("synthetic lifecycle failure"), { code: "package_expired" });
  let calls = 0, released = 0;
  const scope = { packageId: "synthetic-package", targetRevisionId: "synthetic-r1" };
  const state = { schemaVersion: 2, packages: { [scope.packageId]: { packageId: scope.packageId, kind: "target", versionId: scope.targetRevisionId,
    state: "active", collectionSettings: { sourceOverrides: { wechat: { accountIds: ["syntheticBiz="] } } } } }, settings: { sourceOverrides: {}, customSites: [] } };
  const reader = createContentReadService({ request: async () => { calls++; throw failure; } });
  const repository = { clock: { now: () => 0 }, read: async () => state,
    mutateWorkspace: async () => assert.fail("a lifecycle failure must not become saved source health") };
  const service = createSourceService({ repository, registry: createSourceRegistry([wechat]),
    operationGate: { acquire: async () => ({ release: async () => { released++; } }) },
    catalog: [{ siteId: "wechat", providerId: "wechat", origin: "https://mp.weixin.qq.com" }], requestFactory: () => async () => reader.read(input) });
  await assert.rejects(service.probeScopedSource({ scope, sourceId: "wechat", siteId: "wechat" }), error => error === failure);
  assert.equal(calls, 1); assert.equal(released, 1);
});
