import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { submit } from "../helpers/dom.mjs";
import { mountJobsPage } from "../../public/js/pages/jobs.js";
const plan = {
  workspaceRevision: 10,
  planHash: "a".repeat(64),
  groups: [
    {
      groupId: "g1",
      keepJobId: "main",
      removeJobIds: ["old"],
      reasons: ["同一岗位详情链接"],
      targetRevisionIds: ["t1@1", "t1@2"],
    },
    {
      groupId: "g2",
      keepJobId: "p1",
      removeJobIds: ["p2"],
      protected: true,
      protectedReason: "多个独立人工投递记录",
    },
  ],
  possiblePairs: [{ jobIds: ["x", "y"], reasons: ["相似标题"] }],
  counts: {
    confirmedGroups: 2,
    possiblePairs: 1,
    protectedGroups: 1,
    removedEntities: 1,
    collapsedVersionEntries: 1,
    affectedVersions: 2,
  },
};
function button(node, text) {
  const b = [...node.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  assert.ok(b, text);
  return b;
}
test("global cleanup previews all versions, protects manual records and requires explicit confirmation once", async () => {
  let release;
  const waiting = new Promise((r) => (release = r));
  const f = uiFixture((p, o) => {
    if (p === "/targets")
      return {
        targets: [
          {
            targetId: "t1",
            revisionId: "t1@1",
            roles: ["消防"],
            versionName: "消防",
          },
          {
            targetId: "t1",
            revisionId: "t1@2",
            roles: ["机场"],
            versionName: "机场",
          },
        ],
      };
    if (p.startsWith("/jobs?")) return { items: [], total: 0 };
    if (p === "/jobs/duplicates/preview") return plan;
    if (p === "/jobs/duplicates/apply")
      return waiting.then(() => ({
        counts: {
          removedEntities: 1,
          collapsedVersionEntries: 1,
          affectedVersions: 2,
        },
        backupId: "backup-synthetic",
      }));
    if (p.startsWith("/jobs/"))
      return {
        job: {
          jobId: p.split("/").at(-1),
          canonical: {
            title: "合成消防岗位",
            company: "合成单位",
            cities: ["广州"],
          },
        },
      };
    return {};
  });
  f.store.dispatch({ type: "target", id: "t1", revisionId: "t1@1" });
  const page = mountJobsPage(f);
  await page.ready;
  const query = f.calls.find((c) => c.path.startsWith("/jobs?"));
  assert.equal(
    new URLSearchParams(query.path.split("?")[1]).get("kind"),
    "job",
  );
  assert.equal(
    f.root.querySelectorAll('#jobsTarget option[value^="t1@"] ').length,
    2,
  );
  button(f.root, "清理所有版本重复岗位").click();
  await f.settle();
  const preview = f.calls.find((c) => c.path === "/jobs/duplicates/preview");
  assert.equal(preview.body?.targetRevisionId, undefined);
  assert.equal(f.calls.filter((c) => c.path.endsWith("/apply")).length, 0);
  assert.deepEqual(
    [...f.root.querySelectorAll("input[data-cleanup-group]")]
      .filter((x) => x.checked && !x.disabled)
      .map((x) => x.value),
    ["g1"],
  );
  assert.match(f.root.textContent, /人工|保护/);
  assert.match(f.root.textContent, /疑似/);
  assert.match(f.root.textContent, /备份/);
  button(f.root, "确认清理所选重复岗位").click();
  button(f.root, "确认清理所选重复岗位").click();
  await f.settle();
  assert.equal(f.calls.filter((c) => c.path.endsWith("/apply")).length, 1);
  assert.deepEqual(
    f.calls.find((c) => c.path.endsWith("/apply")).body.selectedGroupIds,
    ["g1"],
  );
  release();
  await f.settle();
  assert.match(f.root.textContent, /重复实体.*1.*版本.*2.*备份/s);
  assert.match(f.root.querySelector(".cleanup-result").textContent, /备份/);
  page.destroy();
});
test("stale preview remains visible but cannot be applied again until refreshed", async () => {
  const { duplicateCleanup } = await import(
    "../../public/js/components/duplicate-cleanup.js"
  );
  let previews = 0;
  const f = uiFixture((p) =>
    p.endsWith("/preview")
      ? (previews++, plan)
      : p.endsWith("/apply")
        ? Promise.reject(
            Object.assign(Error("预览已过期"), {
              code: "duplicate_plan_stale",
            }),
          )
        : { job: { canonical: { title: "合成岗位" } } },
  );
  const c = duplicateCleanup(f.document, { api: f.api, onApplied: () => {} });
  f.root.append(c.node);
  await c.open();
  button(f.root, "确认清理所选重复岗位").click();
  await f.settle();
  assert.match(f.root.textContent, /预览已过期/);
  assert.ok(f.root.querySelector("[data-cleanup-group]"));
  assert.equal(button(f.root, "确认清理所选重复岗位").disabled, true);
  button(f.root, "重新预览").click();
  await f.settle();
  assert.equal(previews, 2);
  assert.equal(button(f.root, "确认清理所选重复岗位").disabled, false);
  c.dispose();
});
test("independent filters include every recommendation and qualification without mixing record kinds", async () => {
  const f = uiFixture((p) =>
      p === "/targets"
        ? { targets: [] }
        : p.startsWith("/jobs?")
          ? { items: [], total: 0 }
          : {},
    ),
    page = mountJobsPage(f);
  await page.ready;
  for (const v of [
    "high",
    "consider",
    "low",
    "insufficient",
    "not_recommended",
    "unevaluated",
    "all",
  ])
    assert.ok(
      f.root.querySelector('#jobRecommendation option[value="' + v + '"]'),
    );
  f.root.querySelector("#jobKind").value = "company_campaign";
  f.root.querySelector("#jobRecommendation").value = "unevaluated";
  f.root.querySelector("#jobQualification").value = "unknown";
  submit(f.document, f.root.querySelector(".toolbar"));
  await f.settle();
  const params = new URLSearchParams(
    f.calls
      .filter((c) => c.path.startsWith("/jobs?"))
      .at(-1)
      .path.split("?")[1],
  );
  assert.equal(params.get("kind"), "company_campaign");
  assert.equal(params.get("recommendation"), "unevaluated");
  assert.equal(params.get("qualification"), "unknown");
  page.destroy();
});
test("old detail ID resolves to one canonical row and preserves selected version facts", async () => {
  const r = {
    jobId: "old",
    title: "合成消防岗位",
    kind: "job",
    cities: [],
    sourceId: "synthetic",
    application: { status: "new" },
  };
  let refreshed = false;
  const f = uiFixture((p) =>
    p === "/targets"
      ? {
          targets: [
            {
              targetId: "t1",
              revisionId: "t1@1",
              versionName: "消防",
              roles: ["消防"],
            },
          ],
        }
      : p.startsWith("/jobs?")
        ? { items: [refreshed ? { ...r, jobId: "main" } : r], total: 1 }
        : p.startsWith("/jobs/old")
          ? ((refreshed = true),
            {
              jobId: "main",
              requestedJobId: "old",
              targetRevisionId: "t1@1",
              job: { jobId: "main", canonical: r },
              fact: { status: "missing", observationIds: [] },
              evaluations: [
                {
                  evaluationId: "old-e",
                  score: 91,
                  factBasis: { status: "missing" },
                  profileRevisionId: "p1@1",
                  targetRevisionId: "t1@1",
                },
              ],
              observations: [],
              relatedJobs: [],
            })
          : {},
  );
  f.store.dispatch({ type: "target", id: "t1", revisionId: "t1@1" });
  const page = mountJobsPage(f);
  await page.ready;
  f.root.querySelector('[data-job-id="old"]').click();
  await f.settle();
  assert.ok(
    f.calls.find((c) => c.path === "/jobs/old?targetRevisionId=t1%401"),
  );
  assert.equal(f.store.getState().selectedJobId, "main");
  assert.equal(f.root.querySelectorAll('[data-job-id="main"]').length, 1);
  assert.equal(f.root.querySelector('[data-job-id="old"]'), null);
  assert.match(
    f.root.querySelector('[role="dialog"]').textContent,
    /当前版本尚未评价/,
  );
  assert.match(
    f.root.querySelector('[role="dialog"]').textContent,
    /历史匹配分.*依据未验证/,
  );
  page.destroy();
});
