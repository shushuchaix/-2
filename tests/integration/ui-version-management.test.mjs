import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { submit } from "../helpers/dom.mjs";
import { mountProfilesPage } from "../../public/js/pages/profiles.js";
import { mountWorkbenchPage } from "../../public/js/pages/workbench.js";
import { mountShell } from "../../public/js/components/shell.js";
import { feedback } from "../../public/js/components/feedback.js";
import { applicationForm } from "../../public/js/components/application-form.js";
const profile = {
  profileId: "p1",
  revisionId: "p1@1",
  versionName: "基础简历",
  profile: { name: "合成" },
  text: "合成简历正文".repeat(8),
};
const base = {
  targetId: "t1",
  profileRevisionId: "p1@1",
  roles: ["消防"],
  cities: [],
  cityMode: "any",
  jobTypes: ["campus"],
  degreePolicy: "eligibility",
  coverageMode: "standard",
  enabled: true,
};
const model = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
};
function row(f, id) {
  return f.root.querySelector('[data-revision-id="' + id + '"]');
}
function clickText(node, text) {
  const b = [...node.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  assert.ok(b, text);
  b.click();
}
test("restoring a profile recomputes its target rescore action despite stale server availability", async () => {
  let current = {
    ...profile,
    archivedAt: "2026-10-08",
    availability: {
      canCollect: false,
      canRescore: false,
      reasonCode: "profile_archived",
    },
  };
  const t = {
    ...base,
    revisionId: "t1@1",
    revision: 1,
    versionName: "消防",
    availability: {
      canCollect: false,
      canRescore: false,
      reasonCode: "profile_archived",
    },
  };
  const f = uiFixture((path, options) => {
    if (path === "/profiles") return { profiles: [current] };
    if (path === "/targets") return { targets: [t] };
    if (path === "/sources") return { sources: [] };
    if (path === "/settings") return { settings: { model } };
    if (path.endsWith("/restore"))
      return (current = { ...profile, archivedAt: null });
    if (options.method === "DELETE")
      return (current = { ...profile, archivedAt: "2026-10-08" });
    return {};
  });
  const page = mountProfilesPage(f);
  await page.ready;
  const rescore = () =>
    [...row(f, "t1@1").querySelectorAll("button")].find((b) =>
      b.textContent.includes("重新评分"),
    );
  assert.equal(rescore().disabled, true);
  clickText(row(f, "p1@1"), "恢复");
  await f.settle();
  assert.equal(rescore().disabled, false);
  clickText(row(f, "p1@1"), "移入回收站");
  await f.settle();
  assert.equal(rescore().disabled, true);
  page.destroy();
});
test("all versions stay visible; toggle uses exact revision, editing creates a clean named version once", async () => {
  let release;
  const pending = new Promise((r) => (release = r));
  const targets = [
    {
      ...base,
      revisionId: "t1@1",
      revision: 1,
      versionName: "消防初版",
      budgets: { maxCostCny: 10, maxModelRequests: 1000 },
      siteIds: ["school"],
    },
    { ...base, revisionId: "t1@2", revision: 2, versionName: "机场方向" },
  ];
  const f = uiFixture((p, o) => {
    if (p === "/profiles") return { profiles: [profile] };
    if (p === "/targets" && !o.method) return { targets };
    if (p === "/settings") return { settings: { model } };
    if (p === "/sources") return { sources: [] };
    if (o.method === "PATCH") return { ...targets[0], ...o.body };
    if (o.method === "PUT")
      return pending.then(() => ({
        ...o.body,
        targetId: "t1",
        revisionId: "t1@3",
        revision: 3,
        enabled: true,
      }));
    return {};
  });
  f.store.dispatch({ type: "target", id: "t1", revisionId: "t1@1" });
  const shell = mountShell({ root: f.root, store: f.store, router: {} });
  const page = mountProfilesPage({ ...f, root: shell.content });
  await page.ready;
  assert.ok(row(f, "t1@1"));
  assert.ok(row(f, "t1@2"));
  clickText(row(f, "t1@1"), "新建版本");
  await f.settle();
  assert.equal(f.root.querySelector("#targetVersionName").value, "");
  clickText(row(f, "t1@1"), "停用");
  await f.settle();
  const toggle = f.calls.find((c) => c.method === "PATCH");
  assert.match(toggle.path, /t1\/revisions\/t1%401$/);
  assert.equal(f.store.getState().targetRevisionId, "t1@1");
  assert.match(f.root.querySelector(".shell-feedback").textContent, /已停用/);
  feedback(f.document).show("");
  assert.match(f.root.querySelector(".shell-feedback").textContent, /已停用/);
  f.root.querySelector("#targetVersionName").value = "消防升级";
  submit(f.document, f.root.querySelector("#targetForm"));
  submit(f.document, f.root.querySelector("#targetForm"));
  await f.settle();
  const creates = f.calls.filter((c) => c.method === "PUT");
  assert.equal(creates.length, 1);
  assert.equal(Object.hasOwn(creates[0].body, "enabled"), false);
  assert.equal(Object.hasOwn(creates[0].body, "revisionId"), false);
  assert.deepEqual(creates[0].body.budgets, {
    maxCostCny: 10,
    maxModelRequests: 1000,
  });
  assert.deepEqual(creates[0].body.siteIds, ["school"]);
  release();
  await f.settle();
  assert.equal(f.root.querySelectorAll('[data-revision-id="t1@3"]').length, 1);
  page.destroy();
  shell.destroy();
});
test("rename keeps job and run state; archive and restore retain original ID, references are visible", async () => {
  let t = {
    ...base,
    revisionId: "t1@1",
    revision: 1,
    versionName: "消防",
    references: { members: 4 },
  };
  const f = uiFixture((p, o) => {
    if (p === "/profiles") return { profiles: [profile] };
    if (p === "/targets") return { targets: [t] };
    if (p === "/sources") return { sources: [] };
    if (p === "/settings") return { settings: { model } };
    if (p.endsWith("/restore")) return (t = { ...t, archivedAt: null });
    if (o.method === "DELETE") return (t = { ...t, archivedAt: "2026-10-08" });
    if (o.method === "PATCH") return (t = { ...t, ...o.body });
    return {};
  });
  f.store.dispatch({ type: "target", id: "t1", revisionId: t.revisionId });
  f.store.dispatch({ type: "run-start", runId: "r1" });
  const before = f.store.getState();
  const page = mountProfilesPage(f);
  await page.ready;
  const input = row(f, t.revisionId).querySelector("input[data-version-name]");
  input.value = "新方向";
  clickText(row(f, t.revisionId), "重命名");
  await f.settle();
  assert.equal(f.store.getState().run, before.run);
  assert.equal(f.store.getState().jobs, before.jobs);
  assert.match(row(f, t.revisionId).textContent, /members.*4/);
  clickText(row(f, t.revisionId), "移入回收站");
  await f.settle();
  clickText(row(f, t.revisionId), "恢复");
  await f.settle();
  assert.equal(f.root.querySelectorAll('[data-revision-id="t1@1"]').length, 1);
  page.destroy();
});
test("failed unique name save preserves content and reuses submission nonce on retry", async () => {
  const f = uiFixture((p, o) => {
    if (p === "/profiles") return { profiles: [profile] };
    if (p === "/targets" && !o.method) return { targets: [] };
    if (p === "/sources") return { sources: [] };
    if (p === "/settings") return { settings: { model } };
    if (o.method)
      throw Object.assign(Error("名称重复"), {
        fieldErrors: { versionName: "名称已存在" },
        diagnosticId: "d-test",
      });
  });
  const page = mountProfilesPage(f);
  await page.ready;
  f.root.querySelector("#targetRoles").value = "消防";
  f.root.querySelector("#targetVersionName").value = "消防版本";
  submit(f.document, f.root.querySelector("#targetForm"));
  await f.settle();
  assert.match(f.root.textContent, /名称已存在/);
  assert.match(f.root.textContent, /d-test/);
  submit(f.document, f.root.querySelector("#targetForm"));
  await f.settle();
  const posts = f.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  assert.ok(posts[0].body.submissionId);
  assert.equal(posts[0].body.submissionId, posts[1].body.submissionId);
  assert.equal(f.root.querySelector("#targetRoles").value, "消防");
  page.destroy();
});
test("workbench preserves exact selected revision and archived profile blocks every start restoration path", async () => {
  const targets = [
    { ...base, revisionId: "t1@1", versionName: "旧版" },
    { ...base, revisionId: "t1@2", versionName: "新版" },
  ];
  const f = uiFixture((p) =>
    p === "/targets"
      ? { targets }
      : p === "/profiles"
        ? { profiles: [{ ...profile, archivedAt: "2026-10-08" }] }
        : p.startsWith("/jobs")
          ? { items: [], total: 0 }
          : { runs: [] },
  );
  f.store.dispatch({ type: "target", id: "t1", revisionId: "t1@1" });
  const page = mountWorkbenchPage(f);
  await page.ready;
  assert.equal(f.root.querySelector("#workbenchTarget").value, "t1@1");
  assert.equal(f.root.querySelector("#startRun").disabled, true);
  const select = f.root.querySelector("#workbenchTarget");
  select.value = "t1@2";
  select.dispatchEvent(new f.document.defaultView.Event("change"));
  await f.settle();
  assert.equal(f.root.querySelector("#startRun").disabled, true);
  f.store.dispatch({ type: "run-start", runId: "r1" });
  f.store.dispatch({
    type: "run-event",
    event: {
      runId: "r1",
      seq: 1,
      type: "done",
      payload: { status: "completed" },
    },
  });
  assert.equal(f.root.querySelector("#startRun").disabled, true);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  page.destroy();
});
test("archived application resume stays labelled for existing record but is not offered to new records", () => {
  const f = uiFixture(() => ({})),
    archived = { ...profile, archivedAt: "2026-10-08" };
  const old = applicationForm({
    ...f,
    application: { status: "new", resumeRevisionId: profile.revisionId },
    profiles: [archived],
    onSave: () => {},
  });
  assert.match(old.querySelector("#applicationResume").textContent, /回收站/);
  const fresh = applicationForm({
    ...f,
    application: { status: "new" },
    profiles: [archived],
    onSave: () => {},
  });
  assert.equal(
    fresh.querySelector('#applicationResume option[value="p1@1"]'),
    null,
  );
});
