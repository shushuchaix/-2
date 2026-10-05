import test from "node:test";
import assert from "node:assert/strict";
import { createTestDocument } from "../helpers/dom.mjs";
import { bindValidation } from "../../public/js/components/form-validation.js";
import { el, field } from "../../public/js/components/dom.js";
import { createApiClient } from "../../public/js/api.js";

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
