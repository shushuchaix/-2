import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";

test("public lifecycle failures keep the safe error code and hide internal messages", async (t) => {
  const f = await apiFixture(t, {
    legacySchema: false,
    dependencies: { startScheduler: false },
  });
  const ctx = await f.ctx.ready;
  ctx.purgeService.execute = async () => {
    throw Object.assign(Error("PRIVATE-BODY-AND-PATH"), {
      status: 503,
      code: "purge_file_failed",
    });
  };
  const result = await f.call("/api/v2/trash/purge", { preview: {} });
  assert.equal(result.response.status, 503);
  assert.equal(result.data.code, "purge_file_failed");
  assert.ok(!JSON.stringify(result.data).includes("PRIVATE-BODY-AND-PATH"));
  assert.match(result.data.diagnosticId, /^d-/);
});

test("login stylesheet is self-contained when legacy renderer resources are unavailable", async (t) => {
  const f = await apiFixture(t);
  const response = await fetch(f.origin + "/style.css");
  const css = await response.text();
  assert.equal(response.status, 200);
  assert.match(css, /\.login-card\s*\{/);
  assert.match(css, /:root\s*\{/);
  for (const match of css.matchAll(/@import\s+url\(["']([^"']+)["']\)/g))
    assert.equal((await fetch(f.origin + match[1])).status, 200);
});
test("root serves built React shell, old destinations redirect, unknown resources stay 404 under CSP", async (t) => {
  const f = await apiFixture(t, {
      legacySchema: false,
      dependencies: { startScheduler: false },
    }),
    root = await fetch(f.origin + "/"),
    html = await root.text();
  assert.equal(root.status, 200);
  assert.ok(/src="\/app\/assets\//.test(html));
  assert.ok(!/<script(?![^>]*src=)/.test(html));
  assert.ok(
    root.headers.get("content-security-policy").includes("style-src 'self'"),
  );
  for (const page of [
    "workbench",
    "jobs",
    "applications",
    "profiles",
    "targets",
    "sources",
    "logs",
    "trash",
    "settings",
  ]) {
    const r = await fetch(f.origin + "/" + page, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/#/" + page);
  }
  const missing = await fetch(f.origin + "/app/assets/no-such-resource.js");
  assert.equal(missing.status, 404);
  const login = await fetch(f.origin + "/login.html");
  assert.equal(login.status, 200);
  const oldIndex = await fetch(f.origin + "/index.html", {
    redirect: "manual",
  });
  assert.equal(oldIndex.status, 302);
  assert.equal(oldIndex.headers.get("location"), "/");
  for (const asset of [
    "/js/main.js",
    "/js/pages/workbench.js",
    "/styles/layout.css",
  ])
    assert.equal((await fetch(f.origin + asset)).status, 404);
  for (const asset of [
    "/login.js",
    "/style.css",
    "/js/components/form-validation.js",
    "/js/validation-rules.js",
  ])
    assert.equal((await fetch(f.origin + asset)).status, 200);
});
test("modern version buttons enforce package, persist enable and archive, and reject wrong scope", async (t) => {
  const f = await apiFixture(t, {
      legacySchema: false,
      dependencies: { startScheduler: false },
    }),
    ctx = await f.ctx.ready,
    p = await ctx.workspaceService.saveProfile({
      text: "合成本科消防工程简历，具有消防安全项目经历和机场岗位求职意向。",
      profile: { education: "本科" },
      versionName: "按钮简历",
    }),
    target = await ctx.workspaceService.saveTarget({
      versionName: "按钮目标",
      profileRevisionId: p.revisionId,
      roles: ["消防"],
      cityMode: "any",
      cities: [],
      jobTypes: ["campus", "social"],
      sourceIds: ["synthetic"],
      siteIds: [],
      budgets: {},
    }),
    url =
      "/api/v2/targets/" +
      target.targetId +
      "/revisions/" +
      encodeURIComponent(target.revisionId);
  const wrong = await f.call(
    url + "?packageId=" + p.packageId,
    { enabled: false },
    "PATCH",
  );
  assert.equal(wrong.response.status, 409);
  assert.equal(wrong.data.code, "package_scope_mismatch");
  const updated = await f.call(
    url + "?packageId=" + target.packageId,
    { enabled: false },
    "PATCH",
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.enabled, false);
  const archived = await f.call(
    url + "?packageId=" + target.packageId,
    undefined,
    "DELETE",
  );
  assert.equal(archived.response.status, 200);
  assert.equal(archived.data.state, "trashed");
  const list = await f.call("/api/v2/trash");
  assert.equal(list.data.items[0].packageId, target.packageId);
  const restored = await f.call("/api/v2/trash/restore", {
    packageId: target.packageId,
    archiveId: archived.data.archiveId,
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.data.enabled, false);
});
