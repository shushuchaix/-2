import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { submit } from "../helpers/dom.mjs";
import { modelSettings } from "../../public/js/components/model-settings.js";
import { runProgress } from "../../public/js/components/run-progress.js";
import { validateInput } from "../../public/js/validation-rules.js";

const officialModel = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
  configured: true,
};
function field(root, name) {
  const label = [...root.querySelectorAll("label")].find(
    (node) => node.querySelector("span")?.textContent === name,
  );
  assert.ok(label, "Field exists: " + name);
  return label.querySelector("input");
}
const moneyLabel = "每任务模型费用上限（元）";

test("official flash settings save an explicit ten yuan cap and a secondary request cap", async () => {
  const f = uiFixture(() => ({}));
  const page = modelSettings({
    ...f,
    settings: { model: officialModel, budgets: { maxModelRequests: 20 } },
  });
  f.root.append(page.node);
  assert.equal(field(f.root, moneyLabel).value, "10");
  assert.match(page.node.textContent, /费用预算.*20|20.*停止/);
  submit(f.document, page.node);
  await f.settle();
  assert.deepEqual(f.calls[0].body.budgets, {
    maxCostCny: 10,
    maxModelRequests: 1000,
  });
  page.destroy();
});

test("zero yuan settings disable model calls explicitly", async () => {
  const f = uiFixture(() => ({}));
  const page = modelSettings({
    ...f,
    settings: { model: officialModel, budgets: { maxCostCny: 10 } },
  });
  f.root.append(page.node);
  field(f.root, moneyLabel).value = "0";
  submit(f.document, page.node);
  await f.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.budgets.maxCostCny, 0);
  page.destroy();
});

test("custom compatible model retains request-only settings when the cost field is blank", async () => {
  const f = uiFixture(() => ({}));
  const page = modelSettings({
    ...f,
    settings: {
      model: { baseUrl: "http://localhost:11434/v1", model: "local-model" },
      budgets: { maxModelRequests: 12 },
    },
  });
  f.root.append(page.node);
  assert.equal(field(f.root, moneyLabel).value, "");
  submit(f.document, page.node);
  await f.settle();
  assert.deepEqual(f.calls[0].body.budgets, { maxModelRequests: 12 });
  page.destroy();
});

test("unsupported monetary model settings stop before a settings write", async () => {
  const f = uiFixture(() => ({}));
  const page = modelSettings({
    ...f,
    settings: { model: officialModel, budgets: { maxCostCny: 10 } },
  });
  f.root.append(page.node);
  field(f.root, "兼容 API endpoint").value = "https://compatible.example/v1";
  submit(f.document, page.node);
  await f.settle();
  assert.equal(f.calls.length, 0);
  assert.match(page.node.textContent, /官方|deepseek-flash|核实/);
  page.destroy();
});

test("money input rejects over-cap, negative, malformed and more than two decimals", () => {
  for (const value of [-1, 10.01, 1.001, NaN, Infinity, "1e0", "", undefined]) {
    const errors = validateInput("settings", {
      model: officialModel,
      budgets: { maxCostCny: value },
    });
    assert.ok(errors["budgets.maxCostCny"], "Rejects invalid money value");
  }
  for (const value of [0, 0.01, 1.25, 10, "0", "1.25", "10.00"]) {
    assert.deepEqual(
      validateInput("settings", {
        model: officialModel,
        budgets: { maxCostCny: value, maxModelRequests: 1000 },
      }),
      {},
    );
  }
});

test("clearing an existing money budget sends an explicit removal for compatible models", async () => {
  const f = uiFixture(() => ({})),
    page = modelSettings({
      ...f,
      settings: {
        model: officialModel,
        budgets: { maxCostCny: 10, maxModelRequests: 1000 },
      },
    });
  f.root.append(page.node);
  field(f.root, moneyLabel).value = "";
  field(f.root, "兼容 API endpoint").value = "http://localhost:11434/v1";
  field(f.root, "模型名称").value = "local-model";
  submit(f.document, page.node);
  await f.settle();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body.budgets, {
    maxCostCny: null,
    maxModelRequests: 20,
  });
  page.destroy();
});

test("two saves on one settings page clear the newly enabled money budget", async () => {
  const f = uiFixture(() => ({})),
    page = modelSettings({
      ...f,
      settings: { model: officialModel, budgets: {} },
    });
  f.root.append(page.node);
  submit(f.document, page.node);
  await f.settle();
  assert.equal(f.calls[0].body.budgets.maxCostCny, 10);
  field(f.root, moneyLabel).value = "";
  field(f.root, "兼容 API endpoint").value = "http://localhost:11434/v1";
  field(f.root, "模型名称").value = "local-model";
  submit(f.document, page.node);
  await f.settle();
  assert.equal(f.calls[1].body.budgets.maxCostCny, null);
  page.destroy();
});

test("money validation uses the effective model and keeps legacy native number checks", () => {
  assert.deepEqual(
    validateInput(
      "settings",
      {
        budgets: { maxCostCny: 10, maxModelRequests: 1000 },
      },
      { nativeTypes: true, model: officialModel },
    ),
    {},
  );
  assert.ok(
    validateInput(
      "settings",
      {
        budgets: { maxCostCny: "10" },
      },
      { nativeTypes: true, model: officialModel },
    )["budgets.maxCostCny"],
  );
  assert.ok(
    validateInput("settings", {
      budgets: { maxModelRequests: 21 },
    })["budgets.maxModelRequests"],
  );
  for (const model of [
    { baseUrl: "http://api.deepseek.com", model: "deepseek-flash" },
    { baseUrl: "https://api.deepseek.com/other", model: "deepseek-flash" },
    {
      baseUrl: "https://api.deepseek.com/v1?token=private",
      model: "deepseek-flash",
    },
    { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  ]) {
    assert.ok(
      validateInput("settings", {
        model,
        budgets: { maxCostCny: 10 },
      })["budgets.maxCostCny"],
    );
  }
});

test("run progress displays monetary upper bound and uncertain charges with the secondary cap", () => {
  const { document } = uiFixture(() => ({}));
  const node = runProgress({
    document,
    run: {
      status: "completed",
      stage: "finished",
      counts: {},
      usage: {
        model: {
          requests: 31,
          maxRequests: 1000,
          maxCostCny: 10,
          costUpperBoundCny: 0.25763,
          reservedCostCny: 0.032,
          uncertainCostCny: 0.08,
          uncertainRequests: 2,
          pricedRequests: 29,
          costMode: "cny_upper_bound",
        },
      },
      issues: [{ code: "model_budget_exhausted", affectedCount: 4 }],
    },
  });
  assert.match(node.textContent, /费用上界\s*¥0\.25763\s*\/\s*¥10/);
  assert.match(node.textContent, /预留.*¥0\.032/);
  assert.match(node.textContent, /不确定.*¥0\.08.*2\s*次/);
  assert.match(node.textContent, /辅助.*31\s*\/\s*1000/);
  assert.match(node.textContent, /费用.*上限.*¥10/);
  assert.doesNotMatch(node.textContent, /达到 1000 次上限|达到 20 次上限/);
});
