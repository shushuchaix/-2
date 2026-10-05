import { readAllJobs } from "../jobs-data.js";
import { el, button, latest, message, field } from "../components/dom.js";
import { feedback } from "../components/feedback.js";
import { profileForm } from "../components/profile-form.js";
import { targetForm } from "../components/target-form.js";
import { bindValidation } from "../components/form-validation.js";
export function mountProfilesPage({ root, api, store }) {
  const d = root.ownerDocument,
    controller = new AbortController();
  let destroyed = false,
    profiles = [],
    targets = [],
    sourceIds = [],
    previewBusy = false,
    editingProfileId;
  const status = feedback(d),
    confirmed = el(d, "section", { className: "card stack" }),
    targetRoot = el(d, "section", { className: "card" }),
    history = el(d, "section", { className: "card" }),
    text = el(d, "textarea", {
      id: "resumeText",
      rows: 7,
      placeholder: "粘贴简历正文，或上传 TXT / DOCX / PDF。",
    }),
    file = el(d, "input", {
      id: "resumeFile",
      type: "file",
      accept: ".txt,.md,.docx,.pdf",
    }),
    previewForm = el(
      d,
      "form",
      { id: "previewForm" },
      el(d, "h2", {}, "1. 导入与预览"),
      field(
        d,
        "简历文件",
        file,
        "可空；支持非空 TXT、MD、DOCX、PDF，最多 20 MB。与正文至少填写一项；两者都有时优先读取文件。图片 PDF 暂不支持 OCR，请改为粘贴正文。",
      ),
      field(
        d,
        "粘贴简历正文",
        text,
        "未选择文件时必填 30–60,000 字符；选择文件后此处正文不参与本次提取。",
      ),
      el(d, "button", { type: "submit" }, "提取并预览"),
    );
  root.replaceChildren(
    el(
      d,
      "div",
      { className: "page-head" },
      el(
        d,
        "div",
        {},
        el(d, "p", { className: "section-label" }, "PROFILE & TARGET"),
        el(d, "h1", {}, "简历与目标"),
        el(d, "p", {}, "先确认事实，再决定在哪里找什么岗位。"),
      ),
    ),
    status.node,
    el(
      d,
      "div",
      { className: "grid" },
      el(
        d,
        "div",
        { className: "stack" },
        el(d, "section", { className: "card" }, previewForm),
        confirmed,
      ),
      el(d, "div", { className: "stack" }, targetRoot, history),
    ),
  );
  const previewValidation = bindValidation(previewForm, {
    kind: "preview",
    fields: { file, resumeText: text },
    values: () => ({ file: file.files?.[0], resumeText: text.value }),
  });
  function showProfile(preview, id) {
    editingProfileId = id;
    confirmed.replaceChildren(
      el(d, "h2", {}, "2. 人工确认画像"),
      el(
        d,
        "p",
        { className: "muted" },
        "预览是推断结果。保存前请校正；保存后保留独立版本。",
      ),
      el(
        d,
        "p",
        { className: "notice-banner" },
        (preview.warnings || ["请核对提取内容，特别是表格与 PDF 排版。"]).join(
          "\n",
        ),
      ),
      profileForm({
        document: d,
        preview,
        onSave: async (input) => {
          status.show("");
          const saved = await api.request(
            id
              ? "/profiles/" + encodeURIComponent(id) + "/revisions"
              : "/profiles",
            { method: "POST", body: input },
          );
          if (destroyed) return;
          profiles.push(saved);
          status.show("画像已保存：" + saved.revisionId);
          renderTargets();
          renderHistory();
        },
      }),
    );
  }
  function renderTargets(target) {
    targetRoot.replaceChildren(
      el(d, "h2", {}, "3. 检索目标"),
      targetForm({
        document: d,
        profiles,
        sourceIds,
        target,
        onSave: async (input) => {
          status.show("");
          const saved = await api.request(
            "/targets" +
              (input.targetId ? "/" + encodeURIComponent(input.targetId) : ""),
            { method: input.targetId ? "PUT" : "POST", body: input },
          );
          if (destroyed) return;
          targets.push(saved);
          store.dispatch({
            type: "target",
            id: saved.targetId,
            revisionId: saved.revisionId,
          });
          status.show("目标已保存：" + saved.revisionId);
          renderTargets(saved);
          renderHistory();
        },
      }),
    );
  }
  function renderHistory() {
    history.replaceChildren(el(d, "h2", {}, "已保存的版本"));
    if (!profiles.length)
      history.append(el(d, "p", { className: "muted" }, "还没有确认画像。"));
    for (const p of profiles)
      history.append(
        el(
          d,
          "div",
          { className: "row" },
          button(d, (p.profile.name || "画像") + " · " + p.revisionId, () =>
            showProfile({ ...p, warnings: [] }, p.profileId),
          ),
          button(d, "删除版本", async () => {
            try {
              await api.request(
                "/profiles/" +
                  encodeURIComponent(p.profileId) +
                  "/revisions/" +
                  encodeURIComponent(p.revisionId),
                { method: "DELETE" },
              );
              profiles = profiles.filter((x) => x.revisionId !== p.revisionId);
              renderHistory();
              renderTargets();
              status.show("版本已删除");
            } catch (e) {
              status.show(
                "不能删除：该版本可能被目标或投递记录引用。" + e.message,
                true,
              );
            }
          }),
        ),
      );
    for (const t of latest(targets, "targetId"))
      history.append(
        el(
          d,
          "div",
          { className: "row" },
          button(
            d,
            t.roles.join(" / ") +
              " · " +
              t.revisionId +
              (t.enabled === false ? " · 已停用" : ""),
            () => renderTargets(t),
          ),
          button(d, t.enabled === false ? "启用" : "停用", async () => {
            try {
              const saved = await api.request("/targets/" + t.targetId, {
                method: "PATCH",
                body: { enabled: t.enabled === false },
              });
              targets.push(saved);
              renderHistory();
              status.show("目标新版本已保存，历史保留");
            } catch (e) {
              status.show(e.message, true);
            }
          }),
          button(d, "对保存岗位重新评分", async () => {
            try {
              const data = await readAllJobs(api);
              for (let i = 0; i < data.items.length; i += 5000)
                await api.request("/jobs/evaluations", {
                  method: "POST",
                  body: {
                    jobIds: data.items.slice(i, i + 5000).map((x) => x.jobId),
                    profileRevisionId: t.profileRevisionId,
                    targetRevisionId: t.revisionId,
                    mode: "rules",
                  },
                });
              status.show("已按 " + t.revisionId + " 重新评分；未重新采集。");
            } catch (e) {
              status.show("重新评分失败：" + e.message, true);
            }
          }),
        ),
      );
  }
  previewForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (previewBusy || !previewValidation.check()) return;
    const submit = previewForm.querySelector("button");
    previewBusy = true;
    submit.disabled = true;
    status.show("");
    try {
      let body = { resumeText: text.value };
      if (file.files?.[0]) {
        const selected = file.files[0];
        const bytes = new Uint8Array(await selected.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        body = { filename: selected.name, base64: btoa(binary) };
      }
      const result = await api.request("/profiles/import-preview", {
        method: "POST",
        body,
        signal: controller.signal,
      });
      if (!destroyed) {
        showProfile(result);
        status.show("预览已生成，请校正后确认保存。");
      }
    } catch (e) {
      if (!destroyed) previewValidation.show(e);
    } finally {
      previewBusy = false;
      submit.disabled = false;
    }
  });
  const ready = (async () => {
    try {
      const [p, t, catalog] = await Promise.all([
        api.request("/profiles", { signal: controller.signal }),
        api.request("/targets", { signal: controller.signal }),
        api.request("/sources", { signal: controller.signal }),
      ]);
      if (destroyed) return;
      profiles = p.profiles;
      targets = t.targets;
      sourceIds = (catalog?.sources || []).map((s) => s.sourceId);
      renderTargets();
      renderHistory();
      message(confirmed, "确认后的画像会显示在这里。");
    } catch (e) {
      if (!destroyed) status.show(e.message, true);
    }
  })();
  return {
    ready,
    destroy() {
      destroyed = true;
      controller.abort();
      root.replaceChildren();
    },
  };
}
