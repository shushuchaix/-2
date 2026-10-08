import { el, field } from "./dom.js";
import { feedback } from "./feedback.js";
import { bindValidation } from "./form-validation.js";
export function jobImport({
  document: d,
  api,
  getTargetRevisionId = () => null,
  onImported,
}) {
  const form = el(d, "form", { className: "card" }),
    status = feedback(d),
    url = el(d, "input", { type: "url", placeholder: "https://…" }),
    title = el(d, "input", { placeholder: "公告标题" }),
    account = el(d, "input", { placeholder: "公号 / 发布账号（可选）" }),
    text = el(d, "textarea", {
      rows: 5,
      placeholder: "微信公号、微博、抖音请粘贴可分享的招聘正文。",
    }),
    note = el(d, "textarea", { placeholder: "我的备注" });
  form.append(
    el(d, "h2", {}, "导入招聘线索"),
    el(
      d,
      "p",
      { className: "muted" },
      "导入到当前所选目标版本；全部版本或未归属视图中的导入保存为未归属记录。",
    ),
    el(
      d,
      "p",
      { className: "muted" },
      "保留来源链接与账号。社交平台链接需要正文或授权接口；导入后按公告展示。",
    ),
    field(
      d,
      "来源链接",
      url,
      "可空；与正文至少填写一项。填写时使用公开 http(s) 链接，不含用户名或密码。",
    ),
    field(d, "标题", title, "可空，自动使用正文首行；最多 200 字符。"),
    field(d, "发布账号", account, "可空；公号或发布账号名称，最多 200 字符。"),
    field(
      d,
      "招聘正文",
      text,
      "普通网页有来源链接时可空；微信、微博、抖音需粘贴正文，最多 60,000 字符。",
    ),
    field(d, "备注", note, "可空；仅用于我的记录，最多 20,000 字符。"),
    el(d, "button", { type: "submit" }, "导入"),
    status.node,
  );
  const values = () => ({
    url: url.value.trim() || undefined,
    title: title.value.trim(),
    text: text.value,
    account: account.value.trim(),
    note: note.value,
    ...(getTargetRevisionId() &&
    !["all", "unassigned"].includes(getTargetRevisionId())
      ? { targetRevisionId: getTargetRevisionId() }
      : {}),
  });
  const validation = bindValidation(form, {
    kind: "import",
    fields: { url, title, account, text, note },
    values,
  });
  let busy = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || !validation.check()) return;
    const save = form.querySelector("button");
    busy = true;
    save.disabled = true;
    status.show("");
    try {
      const result = await api.request("/imports", {
        method: "POST",
        body: values(),
      });
      status.show(
        (result.jobIds.length ? "已导入。" : "未导入。") +
          (result.issues || []).map((x) => x.message).join("；"),
        false,
        { notify: true },
      );
      if (result.jobIds.length) await onImported?.();
    } catch (e) {
      validation.show(e);
    } finally {
      busy = false;
      save.disabled = false;
    }
  });
  return form;
}
