import test from "node:test";
import assert from "node:assert/strict";
import { discoverSourceCandidates } from "../../src/sources/discovery.mjs";
import { assessSourceProbe } from "../../src/sources/source-quality.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { validatePublicSeeds } from "../../src/sources/discovery.mjs";
import { importPublicSeeds } from "../../tools/discover-recruitment-sources.mjs";
import { summarizeSocialValidation } from "../../tools/pilot-recruitment-coverage.mjs";

test("social validation separates login restrictions, body evidence and unmeasured recall", () => {
  const result = summarizeSocialValidation({
    sources: [
      {
        sourceId: "wechat",
        units: [{ reason: "auth_required", committedPages: 0 }],
      },
      { sourceId: "weibo", units: [{ reason: null, committedPages: 1 }] },
    ],
    facts: [
      {
        record: { sourceId: "weibo" },
        evidence: { bodyVerified: true, applicationStatus: "unknown" },
      },
    ],
  });
  assert.equal(result[0].status, "login_required");
  assert.equal(result[1].status, "body_extracted");
  assert.equal(result[1].verifiedApplication, 0);
  assert.equal(result[1].recall, null);
  const blocked = summarizeSocialValidation({
    sources: [
      {
        sourceId: "weibo",
        units: [{ reason: "restricted", committedPages: 0 }],
      },
    ],
    facts: [],
  });
  assert.equal(blocked[0].status, "not_measured");
  assert.equal(blocked[1].status, "restricted");
});

const publicSeed = {
  institutionName: "合成消防企业",
  homepage: "https://official.example.org/",
  evidenceUrl: "https://official.example.org/about",
  channel: "official_employer_careers",
};
test("public seed import validates the entire whitelist before any request", async () => {
  let calls = 0;
  for (const patch of [
    { homepage: "http://127.0.0.1/" },
    { homepage: "https://user:pass@official.example.org/" },
    { evidenceUrl: "https://official.example.org/private/resume.pdf" },
    { evidenceUrl: "https://official.example.org/recruit?signature=abc" },
    { evidenceUrl: "https://official.example.org/recruit?session=abc" },
    { keywords: ["private-term"] },
    { installedTool: "ready" },
    { channel: "arbitrary" },
  ]) {
    await assert.rejects(
      importPublicSeeds({
        seeds: [publicSeed, { ...publicSeed, ...patch }],
        request: async () => {
          calls++;
        },
      }),
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(validatePublicSeeds([publicSeed]), [publicSeed]);
});
test("bulk public seeds only create candidates; tool installation and identity evidence do not prove body", async () => {
  const result = await importPublicSeeds({
    seeds: [publicSeed],
    request: async () => ({
      status: 200,
      text: '<a href="/careers">消防企业招聘</a>',
    }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].status, "candidate");
  assert.equal(result.candidates[0].verifiedAt, null);
  assert.equal(result.candidates[0].capabilities.body, "unverified");
  assert.equal(result.candidates[0].seedEvidenceUrl, publicSeed.evidenceUrl);
});
test("archived discovery clues still require a current original body and never imply recruiting", async () => {
  const candidates = await discoverSourceCandidates({
    seed: publicSeed.homepage,
    archiveLookup: async () => ["https://official.example.org/old"],
    request: async (url) => ({
      status: 200,
      text: url.endsWith("/old") ? '<a href="/jobs/old">招聘结果</a>' : "",
    }),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].discoveredFromArchive, true);
  assert.equal(candidates[0].status, "candidate");
  assert.equal(candidates[0].verifiedAt, null);
});
test("discovery_is_bounded_and_only_follows_public_official_or_linked_known_ats", async () => {
  const calls = [],
    request = async (url) => {
      calls.push(url);
      return {
        status: 200,
        text:
          '<a href="/jobs/next' +
          calls.length +
          '">人才招聘</a><a href="https://school.91job.org.cn/sub-station/home/10290">就业平台</a><a href="http://127.0.0.1/private">招聘</a><a href="https://unrelated.example.org/careers">人才招聘</a>',
      };
    };
  const candidates = await discoverSourceCandidates({
    seed: { url: "https://official.example.org/", name: "合成官方" },
    request,
    maxDepth: 2,
    maxUrls: 5,
  });
  assert.ok(calls.length <= 5);
  assert.ok(
    candidates.every(
      (c) => c.depth <= 2 && c.status === "candidate" && c.verifiedAt === null,
    ),
  );
  assert.ok(
    !calls.some(
      (url) => url.includes("127.0.0.1") || url.includes("unrelated"),
    ),
  );
  assert.ok(
    candidates.some(
      (c) => c.providerId === "university-91job" && c.tenantId === "10290",
    ),
  );
});
test("probe_distinguishes_capabilities_and_never_promotes_empty_search_or_blocked_pages", () => {
  const site = { siteId: "s", providerId: "p" };
  const empty = assessSourceProbe({
    site,
    listSample: { status: 200, records: [] },
    detailSample: [],
    now: Date.now(),
  });
  assert.equal(empty.capabilities.body, "unverified");
  const search = assessSourceProbe({
    site,
    listSample: {
      status: 200,
      records: [
        {
          title: "线索",
          kind: "recruitment_notice",
          detailStatus: "discovery_only",
        },
      ],
    },
    detailSample: [],
    now: Date.now(),
  });
  assert.equal(search.verification, "candidate");
  const blocked = assessSourceProbe({
    site,
    listSample: { status: 403, records: [] },
    detailSample: [],
    now: Date.now(),
  });
  assert.equal(blocked.verification, "restricted");
});
test("source_settings_are_owned_and_private_account_options_cannot_enter_global_settings", async (t) => {
  const f = await packageBusinessFixture(t),
    { a, b } = await f.twoTargets(),
    scope = { packageId: a.packageId, targetRevisionId: a.revisionId },
    other = { packageId: b.packageId, targetRevisionId: b.revisionId };
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({ records: [], hasMore: false }),
  });
  provider.configSchema = { enabled: "boolean", accountIds: "array" };
  const service = createSourceService({
    repository: f.repository,
    operationGate: f.operationGate,
    registry: createSourceRegistry([provider]),
    requestFactory: () => async () => {
      throw Error("No network");
    },
  });
  await service.saveScopedConfig({
    scope,
    sourceId: "synthetic",
    config: { enabled: true, accountIds: ["public-account"] },
  });
  assert.deepEqual(
    (await service.listScopedSources({ scope }))[0].config.accountIds,
    ["public-account"],
  );
  assert.equal(
    (await service.listScopedSources({ scope: other }))[0].config.accountIds,
    undefined,
  );
  assert.equal(
    (await f.repository.read()).settings.sourceOverrides.synthetic,
    undefined,
  );
  await assert.rejects(
    service.saveSourceConfig({
      sourceId: "synthetic",
      config: { accountIds: ["public-account"] },
    }),
    (e) => e.code === "invalid_input" && /全局/.test(e.fieldErrors.config),
  );
  await assert.rejects(
    service.saveScopedConfig({
      scope,
      sourceId: "synthetic",
      config: { authorization: "secret" },
    }),
    (e) =>
      e.code === "invalid_input" && /凭据/.test(e.fieldErrors.authorization),
  );
});
