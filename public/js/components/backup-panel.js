import { el, button, field, downloadBlob } from "./dom.js";
import { feedback } from "./feedback.js";
import { bindValidation } from "./form-validation.js";
export function backupPanel({ document: d, api }) {
  const status = feedback(d),
    root = el(d, "section", { className: "card stack" }),
    format = el(
      d,
      "select",
      { "aria-label": "导出格式" },
      ["json", "csv", "md"].map((v) =>
        el(d, "option", { value: v }, v.toUpperCase()),
      ),
    ),
    file = el(d, "input", {
      type: "file",
      accept: ".json",
      "aria-label": "选择工作区备份",
    });
  const exportForm = el(d, "form", { className: "stack" }),
    restoreForm = el(d, "form", { className: "stack" });
  let busy = false;
  const setBusy = (value) => {
    busy = value;
    for (const control of root.querySelectorAll("button"))
      control.disabled = value;
  };
  root.append(
    el(d, "h2", {}, "备份与导出"),
    exportForm,
    button(d, "下载工作区备份", async () => {
      if (busy) return;
      setBusy(true);
      status.show("");
      try {
        const archive = await api.request("/workspace/backup", {
          method: "POST",
          body: {},
        });
        downloadBlob(
          d,
          new Blob([JSON.stringify(archive, null, 2)], {
            type: "application/json",
          }),
          "job-radar-backup.json",
        );
        status.show("备份已在服务器生成，已开始下载；凭据不包含在内。", false, {
          notify: true,
        });
      } catch (e) {
        exportValidation.show(e);
      } finally {
        setBusy(false);
      }
    }),
    restoreForm,
    status.node,
  );
  exportForm.append(
    el(
      d,
      "p",
      { className: "muted" },
      "备份保留岗位、简历、目标和人工记录。恢复会先备份当前工作区，并验证内容完整性。",
    ),
    el(
      d,
      "div",
      { className: "row" },
      format,
      button(d, "导出岗位与投递记录", async () => {
        if (busy || !exportValidation.check()) return;
        setBusy(true);
        status.show("");
        try {
          downloadBlob(
            d,
            await api.download("/exports?format=" + format.value),
            "job-radar." + format.value,
          );
          status.show("导出已生成，已开始下载", false, { notify: true });
        } catch (e) {
          exportValidation.show(e);
        } finally {
          setBusy(false);
        }
      }),
    ),
    el(
      d,
      "small",
      { className: "muted" },
      "请选择 JSON、CSV 或 Markdown 格式。",
    ),
  );
  restoreForm.append(
    field(
      d,
      "恢复备份文件",
      file,
      "请选择从本软件下载的非空 .json 工作区备份，最多 38 MiB；岗位导出文件不能用作工作区备份。",
    ),
    button(d, "校验并恢复", async () => {
      if (busy || !restoreValidation.check()) return;
      setBusy(true);
      status.show("");
      try {
        let archive;
        const text = await file.files[0].text();
        try {
          archive = JSON.parse(text);
        } catch {
          restoreValidation.show({
            fieldErrors: {
              file: "备份内容不是有效 JSON，请重新选择工作区备份文件。",
            },
          });
          return;
        }
        await api.request("/workspace/restore", {
          method: "POST",
          body: { archive },
        });
        status.show("备份验证通过，工作区已恢复。请重新打开页面。", false, {
          notify: true,
        });
      } catch (e) {
        restoreValidation.show(e);
      } finally {
        setBusy(false);
      }
    }),
  );
  const exportValidation = bindValidation(exportForm, {
      kind: "export",
      fields: { format },
      values: () => ({ format: format.value }),
    }),
    restoreValidation = bindValidation(restoreForm, {
      kind: "backup",
      fields: { file },
      values: () => ({ file: file.files?.[0] }),
    });
  exportForm.addEventListener("submit", (e) => {
    e.preventDefault();
    exportForm.querySelector("button").click();
  });
  restoreForm.addEventListener("submit", (e) => {
    e.preventDefault();
    restoreForm.querySelector("button").click();
  });
  return root;
}
