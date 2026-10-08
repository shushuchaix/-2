import { readAllJobs } from "../jobs-data.js";
import { el, message, field } from "../components/dom.js";
import { versionList } from "../components/version-list.js";
import {
  upsertVersion,
  versionAvailability,
  operationError,
} from "../version-management.js";
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
    editingProfileId,
    editingTarget,
    model,
    versionLists;
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
          profiles = upsertVersion(profiles, saved);
          store.dispatch({ type: "versionUpdated", version: saved });
          status.show("画像已保存：" + saved.versionName, false, {
            notify: true,
          });
          renderTargets();
          renderHistory();
        },
      }),
    );
  }
  function renderTargets(target) {
    editingTarget = target;
    targetRoot.replaceChildren(
      el(d, "h2", {}, "3. 检索目标"),
      targetForm({
        document: d,
        profiles,
        sourceIds,
        model,
        target,
        onSave: async (input) => {
          status.show("");
          const saved = await api.request(
            "/targets" +
              (input.targetId ? "/" + encodeURIComponent(input.targetId) : ""),
            { method: input.targetId ? "PUT" : "POST", body: input },
          );
          if (destroyed) return;
          targets = upsertVersion(targets, saved);
          store.dispatch({
            type: "target",
            id: saved.targetId,
            revisionId: saved.revisionId,
          });
          status.show("目标已保存：" + saved.versionName, false, {
            notify: true,
          });
          renderTargets(saved);
          renderHistory();
        },
      }),
    );
  }
  async function manage(kind, v, method, suffix = "", body) {
    const saved = await api.request(
      "/" +
        kind +
        "s/" +
        encodeURIComponent(v[kind + "Id"]) +
        "/revisions/" +
        encodeURIComponent(v.revisionId) +
        suffix,
      { method, ...(body ? { body } : {}) },
    );
    if (destroyed) return;
    if (suffix === "/permanent") {
      if (kind === "profile")
        profiles = profiles.filter((x) => x.revisionId !== v.revisionId);
      else targets = targets.filter((x) => x.revisionId !== v.revisionId);
    } else {
      if (kind === "profile") profiles = upsertVersion(profiles, saved);
      else targets = upsertVersion(targets, saved);
      store.dispatch({ type: "versionUpdated", version: saved });
    }
    renderHistory();
    if (kind === "profile") renderTargets(editingTarget);
    const label =
      suffix === "/restore"
        ? "已恢复"
        : suffix === "/permanent"
          ? "已永久删除"
          : method === "DELETE"
            ? "已移入回收站"
            : body?.versionName
              ? "名称已更新"
              : body?.enabled
                ? "已启用"
                : "已停用";
    status.show(
      label + "：" + (saved.versionName || v.versionName || v.revisionId),
      false,
      { notify: true },
    );
  }
  function renderHistory() {
    if (versionLists) {
      versionLists.profile.update(profiles);
      versionLists.target.update(targets);
      return;
    }
    history.replaceChildren(el(d, "h2", {}, "已保存的版本"));
    versionLists = {};
    for (const kind of ["profile", "target"]) {
      const component = versionList(d, {
        kind,
        versions: kind === "profile" ? profiles : targets,
        onSelect: (v) =>
          kind === "profile"
            ? showProfile({ ...v, warnings: [] }, v.profileId)
            : renderTargets(v),
        onRename: (v, name) =>
          manage(kind, v, "PATCH", "", { versionName: name }),
        onToggle:
          kind === "target"
            ? (v) =>
                manage(kind, v, "PATCH", "", { enabled: v.enabled === false })
            : undefined,
        onArchive: (v) => manage(kind, v, "DELETE"),
        onRestore: (v) => manage(kind, v, "POST", "/restore"),
        onPermanentDelete: (v) => manage(kind, v, "DELETE", "/permanent"),
        canRescore: (v) => versionAvailability(v, profiles).canRescore,
        onRescore:
          kind === "target"
            ? async (t) => {
                const data = await readAllJobs(api, {
                  targetRevisionId: t.revisionId,
                });
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
                status.show(
                  "已按 " +
                    t.versionName +
                    " 重新评分：" +
                    data.items.length +
                    " 条",
                  false,
                  { notify: true },
                );
              }
            : undefined,
      });
      versionLists[kind] = component;
      history.append(component.node);
    }
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
        status.show("预览已生成，请校正后确认保存。", false, { notify: true });
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
      const [p, t, catalog, settings] = await Promise.all([
        api.request("/profiles", { signal: controller.signal }),
        api.request("/targets", { signal: controller.signal }),
        api.request("/sources", { signal: controller.signal }),
        api.request("/settings", { signal: controller.signal }),
      ]);
      if (destroyed) return;
      model = (settings?.settings || settings)?.model;
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
