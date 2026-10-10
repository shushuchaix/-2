import test from "node:test";
import assert from "node:assert/strict";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormFeedback } from "../../ui/src/components/FormFeedback";
import { TextField } from "../../ui/src/components/TextField";
test("field error summary focuses the invalid control", async (t) => {
  t.after(cleanup);
  render(
    <>
      <TextField
        name="versionName"
        label="版本名称"
        value="草稿"
        onChange={() => {}}
        error="名称重复"
      />
      <FormFeedback errors={{ versionName: "名称重复" }} />
    </>,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "名称重复" }));
  assert.equal(document.activeElement, screen.getByLabelText("版本名称"));
  assert.equal(
    screen.getByLabelText("版本名称").getAttribute("aria-invalid"),
    "true",
  );
});
