import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { createTestDocument, settle, submit } from "../helpers/dom.mjs";
import { applicationForm } from "../../public/js/components/application-form.js";
import { duplicateCompare } from "../../public/js/components/duplicate-compare.js";
import { sourceTable } from "../../public/js/components/source-table.js";
import { feedback } from "../../public/js/components/feedback.js";
import { jobFilters } from "../../public/js/components/job-filters.js";

const application = () => ({
  jobId: "j1",
  status: "new",
  note: "原备注",
  resumeRevisionId: null,
  appliedAt: null,
  followUpAt: null,
  events: [],
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fieldError(document, node, pattern) {
  assert.equal(node.getAttribute("aria-invalid"), "true");
  const descriptions = (node.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent || "")
    .join(" ");
  assert.match(descriptions, pattern);
}
function submitLink(document, section) {
  const form = section.querySelector("form");
  if (form) submit(document, form);
  else
    [...section.querySelectorAll("button")]
      .find((b) => b.textContent === "关联记录")
      .click();
}

test("application rejects an oversized note locally and keeps the complete draft", async () => {
  const f = uiFixture(() => ({}));
  let calls = 0;
  const form = applicationForm({
    document: f.document,
    application: application(),
    onSave: async (patch) => {
      calls++;
      return { ...application(), ...patch };
    },
  });
  f.root.append(form);
  const note = form.querySelector("#applicationNote");
  note.value = "备注".repeat(10001);
  submit(f.document, form);
  await settle();
  assert.equal(calls, 0, "invalid notes must never reach persistence");
  assert.equal(note.value.length, 20002);
  fieldError(f.document, note, /备注|20000|20,000|2万/);
});

test("application calendar errors are field-specific while optional dates may clear", async () => {
  const f = uiFixture(() => ({}));
  const patches = [];
  const form = applicationForm({
    document: f.document,
    application: application(),
    onSave: async (patch) => {
      patches.push(patch);
      return { ...application(), ...patch };
    },
  });
  f.root.append(form);
  const applied = form.querySelector("#appliedAt");
  applied.value = "2026-02-30";
  submit(f.document, form);
  await settle();
  assert.equal(patches.length, 0);
  fieldError(f.document, applied, /日期|日历/);
  applied.value = "2030-12-30";
  form.querySelector("#followUpAt").value = "2020-01-02";
  submit(f.document, form);
  await settle();
  assert.equal(
    patches.length,
    1,
    "valid past/future dates have no invented ordering restriction",
  );
  applied.value = "";
  form.querySelector("#followUpAt").value = "";
  submit(f.document, form);
  await settle();
  assert.equal(patches[1].appliedAt, null);
  assert.equal(patches[1].followUpAt, null);
});

test("failed application saves preserve status and distinguish network failure from invalid fields", async () => {
  const f = uiFixture(() => ({}));
  const form = applicationForm({
    document: f.document,
    application: application(),
    onSave: async () => {
      throw Error("网络连接已断开");
    },
  });
  f.root.append(form);
  form.querySelector("#applicationStatus").value = "applied";
  form.querySelector("#applicationNote").value = "稍后再保存";
  submit(f.document, form);
  await settle();
  assert.equal(form.querySelector("#applicationStatus").value, "applied");
  assert.equal(form.querySelector("#applicationNote").value, "稍后再保存");
  assert.match(form.textContent, /网络连接已断开/);
  assert.equal(form.querySelectorAll('[aria-invalid="true"]').length, 0);
});

test("application submission cannot duplicate an in-flight write", async () => {
  const f = uiFixture(() => ({})),
    pending = deferred();
  let calls = 0;
  const form = applicationForm({
    document: f.document,
    application: application(),
    onSave: async (patch) => {
      calls++;
      await pending.promise;
      return { ...application(), ...patch };
    },
  });
  f.root.append(form);
  submit(f.document, form);
  submit(f.document, form);
  assert.equal(calls, 1);
  pending.resolve();
  await settle();
});

test("invalid job filters retain loaded results and never issue a replacement query", async () => {
  const f = uiFixture(() => ({})),
    results = f.document.createElement("div");
  results.textContent = "保留的合成岗位";
  let queries = 0;
  const filter = jobFilters({
    document: f.document,
    targets: [],
    onChange: () => {
      queries++;
      results.replaceChildren();
    },
  });
  f.root.append(filter.node, results);
  const search = f.root.querySelector("#jobSearch");
  search.value = "词".repeat(2001);
  submit(f.document, search.closest("form"));
  await settle();
  assert.equal(queries, 0);
  assert.match(f.root.textContent, /保留的合成岗位/);
  assert.equal(search.value.length, 2001);
  fieldError(f.document, search, /搜索|关键词|2000|2,000/);
});

test("link form rejects blank and self IDs locally and accepts a normal submit", async () => {
  const f = uiFixture(() => ({ linked: ["j1", "j2"] }));
  const status = feedback(f.document);
  let changed = 0;
  const section = duplicateCompare({
    document: f.document,
    job: { jobId: "j1" },
    api: f.api,
    status,
    onChanged: async () => {
      changed++;
    },
  });
  f.root.append(section, status.node);
  const input = section.querySelector("input");
  submitLink(f.document, section);
  await settle();
  assert.equal(f.calls.length, 0);
  fieldError(f.document, input, /岗位|ID|标识/);
  input.value = "j1";
  submitLink(f.document, section);
  await settle();
  assert.equal(f.calls.length, 0);
  fieldError(f.document, input, /自身|自己|同一|相同/);
  input.value = "j2";
  assert.ok(
    input.closest("form"),
    "a submit form makes Enter submission available",
  );
  submit(f.document, input.closest("form"));
  await settle();
  assert.equal(f.calls[0].body.jobId, "j2");
  assert.equal(changed, 1);
});

test("server link field errors preserve the ID for correction", async () => {
  const f = uiFixture(() => {
    const e = Error("找不到关联岗位");
    e.status = 404;
    e.fieldErrors = { jobId: "未找到这条岗位，请核对岗位 ID" };
    throw e;
  });
  const status = feedback(f.document);
  const section = duplicateCompare({
    document: f.document,
    job: { jobId: "j1" },
    api: f.api,
    status,
    onChanged: async () => {},
  });
  f.root.append(section, status.node);
  const input = section.querySelector("input");
  input.value = "missing-id";
  submitLink(f.document, section);
  await settle();
  assert.equal(input.value, "missing-id");
  fieldError(f.document, input, /未找到|核对/);
});

test("failed source settings retain the intended checkbox and explicitly report unsaved state", async () => {
  const f = uiFixture(() => {
      throw Error("存储写入失败");
    }),
    status = feedback(f.document);
  const root = sourceTable({
    document: f.document,
    sources: [
      {
        sourceId: "synthetic",
        name: "合成来源",
        config: { enabled: true },
        capabilities: {},
        health: [],
      },
    ],
    sites: [],
    api: f.api,
    status,
  });
  f.root.append(root, status.node);
  const checkbox = root.querySelector('input[type="checkbox"]');
  checkbox.checked = false;
  checkbox.dispatchEvent(new f.document.defaultView.Event("change"));
  await settle();
  assert.equal(checkbox.checked, false);
  assert.match(f.root.textContent, /未保存/);
  assert.match(f.root.textContent, /存储写入失败/);
  assert.equal(checkbox.getAttribute("aria-invalid"), null);
});

test("login reports an empty password on its field without sending a request", async (t) => {
  const html = await fs.readFile(
    new URL("../../public/login.html", import.meta.url),
    "utf8",
  );
  const document = createTestDocument(html),
    calls = [],
    previous = {
      document: globalThis.document,
      location: globalThis.location,
      fetch: globalThis.fetch,
    };
  globalThis.document = document;
  globalThis.location = { search: "", href: "/login" };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    return {
      ok: true,
      json: async () => ({ authRequired: true, authenticated: false }),
    };
  };
  t.after(() => Object.assign(globalThis, previous));
  await import("../../public/login.js?validation-empty");
  await settle();
  const password = document.querySelector("#password");
  submit(document, document.querySelector("#loginForm"));
  await settle();
  assert.equal(calls.filter((c) => c.path === "/api/login").length, 0);
  fieldError(document, password, /密码|填写|输入/);
});

test("login sends the exact non-empty password and retains it after an authentication failure", async (t) => {
  const html = await fs.readFile(
    new URL("../../public/login.html", import.meta.url),
    "utf8",
  );
  const document = createTestDocument(html),
    calls = [],
    previous = {
      document: globalThis.document,
      location: globalThis.location,
      fetch: globalThis.fetch,
    };
  globalThis.document = document;
  globalThis.location = { search: "", href: "/login" };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    return path === "/api/session"
      ? {
          ok: true,
          json: async () => ({ authRequired: true, authenticated: false }),
        }
      : {
          ok: false,
          status: 401,
          json: async () => ({ error: "访问密码不正确" }),
        };
  };
  t.after(() => Object.assign(globalThis, previous));
  await import("../../public/login.js?validation-exact");
  await settle();
  const password = document.querySelector("#password");
  password.select = () => {};
  password.value = "  synthetic password  ";
  submit(document, document.querySelector("#loginForm"));
  await settle();
  assert.equal(
    JSON.parse(calls.find((c) => c.path === "/api/login").options.body)
      .password,
    "  synthetic password  ",
  );
  assert.equal(password.value, "  synthetic password  ");
  assert.match(
    document.querySelector("#loginForm").textContent,
    /访问密码不正确/,
  );
});
