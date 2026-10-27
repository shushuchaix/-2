import test from "node:test";
import assert from "node:assert/strict";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormFeedback } from "../../ui/src/components/FormFeedback";
import { TextField } from "../../ui/src/components/TextField";
import { OperationFeedback } from "../../ui/src/components/OperationFeedback";
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

test("filtered draft errors do not restore stale API field messages in the summary", (t) => {
  t.after(cleanup);
  const error = Object.assign(new Error("提交名称已存在。"), {
    fieldErrors: { versionName: "旧名称重复" },
  });
  render(
    <FormFeedback error={error} errors={{}} includeServerErrors={false} />,
  );
  assert.equal(
    screen.queryAllByRole("button", { name: "旧名称重复" }).length,
    0,
  );
});

test("existing callers still receive API field links when local validation has no errors", (t) => {
  t.after(cleanup);
  const error = Object.assign(new Error("名称已存在。"), {
    fieldErrors: { versionName: "请选择新名称。" },
  });
  render(<FormFeedback error={error} errors={{}} />);
  assert.equal(
    screen.queryAllByRole("button", { name: "请选择新名称。" }).length,
    1,
  );
});

test("clearing a corrected field error keeps focus in the form while remaining errors stay linked", async (t) => {
  t.after(cleanup);
  const fields = (
    <TextField
      name="versionName"
      label="版本名称"
      value="新草稿"
      onChange={() => {}}
    />
  );
  const view = render(
    <>
      {fields}
      <FormFeedback errors={{ versionName: "名称重复", roles: "方向必填" }} />
    </>,
  );
  await userEvent.setup().click(screen.getByLabelText("版本名称"));
  view.rerender(
    <>
      {fields}
      <FormFeedback errors={{ roles: "方向必填" }} />
    </>,
  );
  assert.ok(document.activeElement === screen.getByLabelText("版本名称"));
  assert.ok(screen.getByRole("button", { name: "方向必填" }));
});

test("operation feedback names the pending action and waits for completion before showing success", (t) => {
  t.after(cleanup);
  const view = render(
    <OperationFeedback busy busyLabel="正在保存简历…" result="上次保存成功" />,
  );
  assert.equal(screen.queryAllByText("上次保存成功").length, 0);
  assert.ok(screen.getByText("正在保存简历…").closest('[role="status"]'));
  view.rerender(<OperationFeedback result="简历已保存" />);
  assert.match(screen.getByRole("status").textContent!, /简历已保存/);
});
