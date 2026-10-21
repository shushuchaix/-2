import test from "node:test";
import assert from "node:assert/strict";
import { createTestDocument } from "../helpers/dom.mjs";
import { bindValidation } from "../../public/js/components/form-validation.js";
import { el, field } from "../../public/js/components/dom.js";
import { createApiClient } from "../../public/js/api.js";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { backupPanel } from "../../public/js/components/backup-panel.js";
import { jobImport } from "../../public/js/components/job-import.js";
import { applicationForm } from "../../public/js/components/application-form.js";
import { modelSettings } from "../../public/js/components/model-settings.js";
import { submit } from "../helpers/dom.mjs";
test("import, application and settings writes emit visible success only after writes complete", async () => {
  const f = uiFixture(() => ({ jobIds: ["j1"], issues: [] })),
    events = [];
  f.document.addEventListener("rjr-notification", (e) =>
    events.push(e.detail.text),
  );
  const imported = jobImport({ ...f, onImported: () => {} });
  f.root.append(imported);
  imported.querySelector("textarea").value = "合成消防招聘正文";
  submit(f.document, imported);
  await f.settle();
  assert.match(events.at(-1), /已导入/);
  const applied = applicationForm({
    ...f,
    application: { status: "new" },
    onSave: async (body) => ({ ...body, events: [] }),
  });
  f.root.append(applied);
  submit(f.document, applied);
  await f.settle();
  assert.match(events.at(-1), /投递记录已保存/);
  const settings = modelSettings({
    ...f,
    settings: {
      model: { baseUrl: "https://example.com/v1", model: "synthetic" },
      budgets: {},
    },
  });
  f.root.append(settings.node);
  submit(f.document, settings.node);
  await f.settle();
  assert.match(events.at(-1), /模型与预算设置已保存/);
  settings.destroy();
});

test("exports report generated and download initiated, backup and restore send visible successful operation notifications", async () => {
  const f = uiFixture(() => ({ manifest: { version: 2 } })),
    events = [];
  f.api.download = async () => new Blob(["synthetic"]);
  f.document.addEventListener("rjr-notification", (e) =>
    events.push(e.detail.text),
  );
  const root = backupPanel({ ...f });
  f.root.append(root);
  const find = (text) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  find("导出岗位与投递记录").click();
  await f.settle();
  assert.match(events.at(-1), /导出已生成，已开始下载/);
  find("下载工作区备份").click();
  await f.settle();
  assert.match(events.at(-1), /备份.*生成.*下载/);
  Object.defineProperty(root.querySelector("input[type=file]"), "files", {
    value: [
      {
        name: "synthetic.json",
        size: 50,
        text: async () => JSON.stringify({ manifest: { version: 2 } }),
      },
    ],
  });
  find("校验并恢复").click();
  await f.settle();
  assert.match(events.at(-1), /工作区已恢复/);
});
test("desktop locations expose fixed buttons only; web gets download guidance without private path requests", async () => {
  const { dataLocations } = await import(
    "../../public/js/components/data-locations.js"
  );
  const f = uiFixture(() => ({}));
  const web = dataLocations(f.document, {});
  f.root.append(web);
  assert.match(web.textContent, /浏览器|Web/);
  assert.equal(f.calls.length, 0);
  const calls = [],
    bridge = {
      getDataLocations: async () => ({
        data: "C:/synthetic/data",
        history: "C:/synthetic/data/runs-v2",
        backups: "C:/synthetic/data/backups",
        cache: "C:/synthetic/data/cache",
        logs: "C:/synthetic/data/logs",
      }),
      openDataLocation: async (kind) => calls.push(kind),
      copyDataLocation: async (kind) => calls.push("copy:" + kind),
    };
  const desktop = dataLocations(f.document, { bridge });
  f.root.append(desktop);
  await f.settle();
  desktop.querySelector('[data-open-location="history"]').click();
  await f.settle();
  assert.deepEqual(calls, ["history"]);
  assert.match(desktop.textContent, /已打开/);
  bridge.openDataLocation = async () => {
    throw Error("权限不足");
  };
  desktop.querySelector('[data-open-location="history"]').click();
  await f.settle();
  assert.match(desktop.textContent, /权限不足/);
});

test("blur feedback clears related errors after changing city mode and retains input", () => {
  const d = createTestDocument(),
    form = el(d, "form"),
    cities = el(d, "input", { value: "" }),
    mode = el(
      d,
      "select",
      {},
      el(d, "option", { value: "selected" }, "指定"),
      el(d, "option", { value: "any" }, "不限"),
    );
  form.append(field(d, "城市", cities, "选填说明"), field(d, "范围", mode));
  d.body.append(form);
  const controller = bindValidation(form, {
    kind: "target",
    fields: { cities, cityMode: mode },
    values: () => ({
      profileRevisionId: "p1@1",
      roles: ["合成"],
      cityMode: mode.value,
      cities: [],
      jobTypes: ["campus"],
    }),
  });
  assert.equal(controller.check(), false);
  assert.equal(cities.getAttribute("aria-invalid"), "true");
  mode.value = "any";
  mode.dispatchEvent(new d.defaultView.Event("change"));
  assert.equal(cities.getAttribute("aria-invalid"), null);
  assert.equal(form.querySelector(".validation-summary").hidden, true);
  assert.match(cities.getAttribute("aria-describedby"), /field-hint/);
});
test("a shared select retains any mapped field error and malformed date input is not a clear request", () => {
  const d = createTestDocument(),
    form = el(d, "form"),
    select = el(d, "select"),
    date = el(d, "input", { type: "date", value: "" });
  form.append(select, date);
  d.body.append(form);
  Object.defineProperty(date, "validity", { value: { badInput: true } });
  const controller = bindValidation(form, {
    kind: "filters",
    fields: { kind: select, recommendation: select, since: date },
    values: () => ({ recommendation: "invalid", since: "" }),
  });
  assert.equal(controller.check(), false);
  assert.equal(select.getAttribute("aria-invalid"), "true");
  assert.equal(date.getAttribute("aria-invalid"), "true");
});
test("API carries field failures and describes network failure without exposing details", async () => {
  const api = createApiClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: "检查未通过",
          code: "invalid_input",
          fieldErrors: { note: "备注过长" },
        }),
        { status: 400 },
      ),
  });
  await assert.rejects(
    api.request("/imports"),
    (e) => e.code === "invalid_input" && e.fieldErrors.note === "备注过长",
  );
  const network = createApiClient({
    fetchImpl: async () => {
      throw Error("sensitive internal path");
    },
  });
  await assert.rejects(
    network.request("/imports"),
    (e) =>
      e.code === "network_error" &&
      /连接失败/.test(e.message) &&
      !e.message.includes("sensitive"),
  );
});
