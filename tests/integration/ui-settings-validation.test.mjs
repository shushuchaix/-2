import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { submit } from "../helpers/dom.mjs";
import { modelSettings } from "../../public/js/components/model-settings.js";
import { jobImport } from "../../public/js/components/job-import.js";
import { backupPanel } from "../../public/js/components/backup-panel.js";
import { mountSettingsPage } from "../../public/js/pages/settings.js";
import { mountWorkbenchPage } from "../../public/js/pages/workbench.js";

const settings = {
  model: {
    baseUrl: "http://localhost:11434/v1",
    model: "local-model",
    configured: false,
  },
  budgets: { maxModelRequests: 20 },
};
function field(root, name) {
  const label = [...root.querySelectorAll("label")].find(
    (n) => n.querySelector("span")?.textContent === name,
  );
  assert.ok(label, "Field exists: " + name);
  return label.querySelector("input,textarea,select");
}
function click(root, name) {
  const button = [...root.querySelectorAll("button")].find(
    (n) => n.textContent === name,
  );
  assert.ok(button, "Button exists: " + name);
  button.click();
  return button;
}
function errorFor(node) {
  assert.equal(node.getAttribute("aria-invalid"), "true");
  const ids = (node.getAttribute("aria-describedby") || "").split(/\s+/);
  return ids
    .map((id) => node.ownerDocument.getElementById(id)?.textContent || "")
    .join(" ");
}

test("model settings rejects blank budget instead of silently saving zero", async () => {
  const f = uiFixture(() => settings),
    model = modelSettings({ ...f, settings });
  f.root.append(model.node);
  const budget = field(f.root, "每任务模型尝试上限（0–20，重试也计数）");
  budget.value = "";
  submit(f.document, model.node);
  await f.settle();
  assert.equal(f.calls.length, 0);
  assert.match(errorFor(budget), /填写|必填|整数/);
  model.destroy();
});

test("model endpoint errors are displayed beside the field before a request", async () => {
  const f = uiFixture(() => settings),
    model = modelSettings({ ...f, settings });
  f.root.append(model.node);
  const endpoint = field(f.root, "兼容 API endpoint");
  endpoint.value = "https://user:password@example.com/v1";
  submit(f.document, model.node);
  await f.settle();
  assert.equal(f.calls.length, 0);
  assert.match(errorFor(endpoint), /凭据|用户名|密码/);
  model.destroy();
});

test("model settings consumes server field errors and retains filled values", async () => {
  const failure = Object.assign(Error("输入检查未通过"), {
    fieldErrors: { "model.model": "该模型名称无效，请核对。" },
  });
  const f = uiFixture(() => {
      throw failure;
    }),
    model = modelSettings({ ...f, settings });
  f.root.append(model.node);
  submit(f.document, model.node);
  await f.settle();
  const name = field(f.root, "模型名称");
  assert.equal(name.value, "local-model");
  assert.match(errorFor(name), /模型名称/);
  model.destroy();
});

test("saving an empty desktop Key stops at its field without calling IPC", async () => {
  const f = uiFixture(() => settings),
    saves = [];
  const model = modelSettings({
    ...f,
    settings,
    desktopBridge: {
      isAvailable: async () => true,
      saveKey: async (...args) => saves.push(args),
      deleteKey: async () => {},
    },
  });
  f.root.append(model.node);
  click(f.root, "加密保存桌面 Key");
  await f.settle();
  assert.equal(saves.length, 0);
  assert.match(errorFor(f.root.querySelector("#userApiKey")), /填写|输入/);
  model.destroy();
});

test("duplicate model submits cannot send a second pending settings write", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const f = uiFixture(() => waiting),
    model = modelSettings({ ...f, settings });
  f.root.append(model.node);
  submit(f.document, model.node);
  submit(f.document, model.node);
  await f.settle();
  try {
    assert.equal(f.calls.length, 1);
  } finally {
    release(settings);
    await f.settle();
    model.destroy();
  }
});

test("empty recruitment import asks for a source or body without requesting import", async () => {
  const f = uiFixture(() => ({ jobIds: [], issues: [] })),
    form = jobImport(f);
  f.root.append(form);
  submit(f.document, form);
  await f.settle();
  assert.equal(f.calls.length, 0);
  assert.match(errorFor(field(form, "招聘正文")), /正文|链接/);
});

test("social recruitment link asks for body at the body field", async () => {
  const f = uiFixture(() => ({ jobIds: [], issues: [] })),
    form = jobImport(f);
  f.root.append(form);
  field(form, "来源链接").value = "https://mp.weixin.qq.com/s/synthetic";
  submit(f.document, form);
  await f.settle();
  assert.equal(f.calls.length, 0);
  assert.match(errorFor(field(form, "招聘正文")), /正文/);
});

test("oversized recruitment note is rejected before any job import side effect", async () => {
  const f = uiFixture(() => ({ jobIds: ["synthetic"], issues: [] })),
    form = jobImport(f);
  f.root.append(form);
  field(form, "招聘正文").value = "公开招聘公告：技术岗位，工作地点南京。";
  field(form, "备注").value = "a".repeat(20001);
  submit(f.document, form);
  await f.settle();
  assert.equal(f.calls.length, 0);
  assert.match(errorFor(field(form, "备注")), /20000|20,000|2万/);
});

test("backup file issues stay beside the file input and do not request restore", async (t) => {
  for (const [name, file, message] of [
    ["missing", undefined, /选择/],
    ["empty", { name: "empty.json", size: 0, text: async () => "" }, /空|内容/],
    [
      "extension",
      { name: "backup.txt", size: 2, text: async () => "{}" },
      /JSON|json/,
    ],
    [
      "size",
      {
        name: "large.json",
        size: 38 * 1024 * 1024 + 1,
        text: async () => "{}",
      },
      /38/,
    ],
    [
      "syntax",
      { name: "broken.json", size: 2, text: async () => "{" },
      /JSON|json/,
    ],
  ])
    await t.test(name, async () => {
      const f = uiFixture(() => ({ recovered: true })),
        panel = backupPanel(f);
      f.root.append(panel);
      const input = panel.querySelector("input[type=file]");
      Object.defineProperty(input, "files", { value: file ? [file] : [] });
      click(panel, "校验并恢复");
      await f.settle();
      assert.equal(f.calls.length, 0);
      assert.match(errorFor(input), message);
    });
});

test("custom site ID receives local format feedback without submitting a candidate", async () => {
  const f = uiFixture((p) =>
      p === "/sources"
        ? {
            sources: [
              {
                sourceId: "school",
                name: "学校",
                capabilities: {},
                config: {},
              },
            ],
            sites: [],
          }
        : settings,
    ),
    page = mountSettingsPage(f);
  await page.ready;
  const id = field(f.root, "站点 ID"),
    form = id.closest("form");
  id.value = "bad id";
  field(form, "站点名称").value = "合成学校";
  field(form, "公开站点地址").value = "https://example.com/jobs";
  field(form, "归属证据链接").value = "https://example.com/about";
  submit(f.document, form);
  await f.settle();
  assert.equal(f.calls.filter((c) => c.path === "/sources/sites").length, 0);
  assert.match(errorFor(id), /字母|数字|ID|字符/);
  page.destroy();
});

test("rules collection never transmits an unused temporary model Key", async () => {
  const f = uiFixture((p) =>
    p === "/targets"
      ? {
          targets: [
            {
              targetId: "target",
              revisionId: "target@1",
              revision: 1,
              enabled: true,
              roles: ["技术岗位"],
            },
          ],
        }
      : p.startsWith("/jobs?")
        ? { items: [], total: 0 }
        : p === "/runs"
          ? { runId: "synthetic", status: "queued" }
          : p === "/runs/synthetic"
            ? {
                runId: "synthetic",
                status: "completed",
                counts: {},
                issues: [],
              }
            : { runs: [] },
  );
  f.api.streamRun = async () => {};
  const page = mountWorkbenchPage(f);
  await page.ready;
  const key = f.root.querySelector("input[type=password]");
  key.value = "arbitrary-unused-synthetic-key";
  click(f.root, "更新招聘来源");
  await f.settle();
  const run = f.calls.find((c) => c.path === "/runs");
  assert.ok(run);
  assert.equal(Object.hasOwn(run.body, "userApiKey"), false);
  page.destroy();
});

test("saving a compatible desktop Key does not require model configuration", async () => {
  const f = uiFixture(() => settings),
    saved = [];
  const model = modelSettings({
    ...f,
    settings: { model: {}, budgets: { maxModelRequests: 20 } },
    desktopBridge: {
      isAvailable: async () => true,
      saveKey: async (provider, key) => saved.push({ provider, key }),
      deleteKey: async () => {},
    },
  });
  f.root.append(model.node);
  f.root.querySelector("#userApiKey").value = "compatible-provider-token";
  click(f.root, "加密保存桌面 Key");
  await f.settle();
  assert.deepEqual(saved, [
    { provider: "deepseek", key: "compatible-provider-token" },
  ]);
  assert.equal(f.root.querySelector("#userApiKey").value, "");
  model.destroy();
});

test("plain text import permits empty optional source title account and note", async () => {
  const f = uiFixture(() => ({ jobIds: ["synthetic"], issues: [] })),
    form = jobImport(f);
  f.root.append(form);
  field(form, "招聘正文").value = "公开招聘公告：技术岗位，工作地点南京。";
  submit(f.document, form);
  await f.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/imports");
  assert.equal(f.calls[0].body.url, undefined);
  assert.equal(f.calls[0].body.title, "");
  assert.equal(f.calls[0].body.account, "");
  assert.equal(f.calls[0].body.note, "");
  assert.match(form.textContent, /已导入/);
});

test("empty optional model Key produces no field error on blur", async () => {
  const f = uiFixture(() => settings),
    model = modelSettings({ ...f, settings });
  f.root.append(model.node);
  const key = f.root.querySelector("#userApiKey");
  key.dispatchEvent(new f.document.defaultView.Event("blur"));
  assert.notEqual(key.getAttribute("aria-invalid"), "true");
  model.destroy();
});

test("site duplicate checking remembers the submitted ID while fields are edited during saving", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = uiFixture((p, o, calls) =>
    p === "/sources"
      ? {
          sources: [
            { sourceId: "school", name: "学校", capabilities: {}, config: {} },
          ],
          sites: [],
        }
      : p === "/sources/sites"
        ? calls.filter((c) => c.path === p).length === 1
          ? pending
          : o.body
        : settings,
  );
  const page = mountSettingsPage(f);
  await page.ready;
  const id = field(f.root, "站点 ID"),
    form = id.closest("form");
  id.value = "first-site";
  field(form, "站点名称").value = "合成学校";
  field(form, "公开站点地址").value = "https://example.com/jobs";
  field(form, "归属证据链接").value = "https://example.com/about";
  submit(f.document, form);
  await f.settle();
  id.value = "second-site";
  release({
    siteId: "first-site",
    providerId: "school",
    name: "合成学校",
    status: "candidate",
  });
  await f.settle();
  submit(f.document, form);
  await f.settle();
  assert.deepEqual(
    f.calls
      .filter((c) => c.path === "/sources/sites")
      .map((c) => c.body.siteId),
    ["first-site", "second-site"],
  );
  page.destroy();
});
