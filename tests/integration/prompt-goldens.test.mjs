import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getPromptDefinition,
  renderPrompt,
  articleCacheIdentity,
} from "../../src/llm/prompt-registry.mjs";
import { evaluationCacheKey } from "../../src/llm/validation.mjs";
import {
  queueContentDraft,
  refreshArticleQueue,
} from "../../src/sources/content-queue.mjs";
import { runGoldenValidation } from "../../tools/eval-matching.mjs";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { createModelBudget } from "../../src/llm/budget.mjs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { job } from "../helpers/fixtures.mjs";

const dataset = JSON.parse(
  fs.readFileSync(
    new URL("../../evals/fixtures/prompt-goldens.json", import.meta.url),
  ),
);
test("24 goldens cover six balanced groups and literal positive extraction without measuring offline model quality", async () => {
  assert.equal(dataset.fixtures.length, 24);
  const groups = new Map();
  for (const f of dataset.fixtures)
    groups.set(f.group, [...(groups.get(f.group) || []), f]);
  assert.equal(groups.size, 6);
  for (const group of groups.values()) assert.equal(group.length, 4);
  const report = await runGoldenValidation({
    mode: "offline-contract",
    fixtures: dataset,
  });
  assert.equal(report.mode, "offline-contract");
  assert.equal(report.modelQuality, "not_measured");
  assert.equal(
    report.passed,
    24,
    JSON.stringify(report.results.filter((r) => !r.passed)),
  );
  assert.equal(report.dangerousFalseRecommendations, 0);
  assert.ok(report.positiveSamples >= 4);
  assert.ok(report.extractedJobs > 0);
});
test("prompt registry permits only registered versions, rollback, and anonymized matching payloads", () => {
  for (const id of ["matching", "article"]) {
    const current = getPromptDefinition(id);
    assert.equal(current.state, "active");
    assert.ok(current.schemaVersion);
    assert.ok(current.parserVersion);
    const old = getPromptDefinition(id, { version: current.previousVersion });
    assert.equal(old.state, "archived");
    assert.throws(() => getPromptDefinition(id, { version: "invented" }));
    assert.throws(() => getPromptDefinition("arbitrary"));
  }
  const prompt = renderPrompt("matching", {
    profile: {
      education: "本科",
      name: "PRIVATE_NAME",
      school: "PRIVATE_SCHOOL",
      phone: "13800138000",
      skills: ["消防"],
    },
    records: dataset.fixtures[0].records,
  });
  assert.doesNotMatch(prompt.user, /PRIVATE_|13800138000/);
});
test("all cache identities include prompt, schema, parser, model and full body; old pending chunks migrate without losing tail", () => {
  const current = getPromptDefinition("article"),
    input = {
      jdHash: "jd",
      profileRevisionId: "p",
      targetRevisionId: "t",
      promptVersion: "p1",
      schemaVersion: "s1",
      ruleVersion: "r",
      modelFingerprint: "m1",
    };
  for (const field of ["promptVersion", "schemaVersion", "modelFingerprint"])
    assert.notEqual(
      evaluationCacheKey(input),
      evaluationCacheKey({ ...input, [field]: "changed" }),
    );
  const record = {
    ...dataset.fixtures[12].article,
    description: "公司招聘消防工程师：本科要求。\n".repeat(600) + "尾部岗位",
    intent: "employer_recruitment",
  };
  const a = articleCacheIdentity({
      modelConfig: { model: "model-a", baseUrl: "https://example.org" },
    }),
    p = {};
  queueContentDraft(p, "u", [record], 0, a);
  const entries = Object.entries(p.pendingArticles);
  assert.ok(entries.length > 1);
  for (const [key, value] of entries) {
    assert.equal(value.cacheIdentity.schemaVersion, current.schemaVersion);
    p.articleCache[key] = { ...value.cacheIdentity, jobIds: ["j"] };
    delete p.pendingArticles[key];
  }
  queueContentDraft(p, "u", [record], 0, a);
  assert.equal(Object.keys(p.pendingArticles).length, 0);
  const b = articleCacheIdentity({
    modelConfig: { model: "model-b", baseUrl: "https://example.org" },
  });
  queueContentDraft(p, "u", [record], 0, b);
  assert.equal(Object.keys(p.pendingArticles).length, entries.length);
  const old = structuredClone(p);
  for (const item of Object.values(old.pendingArticles))
    delete item.cacheIdentity;
  refreshArticleQueue(old, b);
  assert.equal(Object.keys(old.pendingArticles).length, entries.length);
  assert.ok(
    Object.values(old.pendingArticles).some((v) =>
      v.record.description.endsWith("尾部岗位"),
    ),
  );
  for (const field of ["promptVersion", "schemaVersion", "parserVersion"]) {
    const changed = { ...b, [field]: "changed" },
      q = { articleCache: structuredClone(p.articleCache) };
    queueContentDraft(q, "u", [record], 0, changed);
    assert.equal(Object.keys(q.pendingArticles).length, entries.length);
  }
});
test("live goldens use caller budget and zero CNY cannot send a transport", async () => {
  const config = {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
  };
  const budget = createModelBudget({ maxCostCny: 0, modelConfig: config });
  let calls = 0;
  const report = await runGoldenValidation({
    mode: "live",
    fixtures: dataset,
    budget,
    modelFactory: ({ budget }) =>
      new DeepSeek(
        { deepseek: { ...config, apiKey: "synthetic" } },
        {
          budget,
          transport: async () => {
            calls++;
            throw Error("must not send");
          },
        },
      ),
  });
  assert.equal(calls, 0);
  assert.equal(report.status, "incomplete");
  assert.equal(report.measured, 0);
  await assert.rejects(
    runGoldenValidation({ mode: "live", fixtures: dataset }),
    /same activity budget/,
  );
});
test("persisted legacy completed article cache is replayed under the new identity in the same root after restart", async (t) => {
  let calls = 0,
    lists = 0;
  const articles = Array.from({ length: 12 }, (_, i) =>
    job({
      sourceId: "synthetic",
      siteId: "site-0",
      sourceRecordId: String(i),
      kind: "recruitment_notice",
      title: "招聘公告" + i,
      url: "https://example.org/n/" + i,
      bodyStatus: "complete",
      intent: "employer_recruitment",
      description: "消防岗位" + i + "：本科要求，消防工程专业。",
    }),
  );
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => {
      lists++;
      return { records: articles, hasMore: false };
    },
  });
  const f = await collectionFixture(t, {
    providers: [provider],
    modelFactory: () => ({
      chatJson: async (_s, text) => {
        calls++;
        const title = text.match(/消防岗位\d+/)[0];
        return {
          isRecruiting: true,
          positions: [
            {
              title,
              requirementsExcerpt: title + "：本科要求，消防工程专业。",
            },
          ],
        };
      },
    }),
  });
  const start = await f.service.start({
      scope: f.scope,
      options: { mode: "ai" },
    }),
    ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  await f.repository.mutateWorkspace((w) => {
    for (const entry of Object.values(
      w.runs[ref.activityId].collectionProgress.articleCache,
    )) {
      delete entry.record;
      delete entry.promptVersion;
      delete entry.schemaVersion;
    }
  });
  await f.reopen();
  await f.service.resume({ ref, requestId: "replay" });
  await f.service.wait(ref);
  assert.equal(calls, 20);
  await f.service.resume({ ref, requestId: "tail" });
  await f.service.wait(ref);
  assert.equal(calls, 22);
  assert.equal(lists, 1);
  const root = await f.service.get(ref);
  assert.equal(root.runId, ref.activityId);
  assert.equal(root.collectionUsage.maxCostCny, 10);
});
