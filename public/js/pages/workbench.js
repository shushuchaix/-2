import { versionLabel, versionAvailability } from "../version-management.js";
import { readAllJobs } from "../jobs-data.js";
import { el, button, field } from "../components/dom.js";
import { feedback } from "../components/feedback.js";
import { runProgress, runOutcomeText } from "../components/run-progress.js";
import { diagnosticsPanel } from "../components/diagnostics-panel.js";
import { renderJobList } from "../components/job-list.js";
import { openJobDetail } from "../components/job-detail.js";
import { temporaryCredentials } from "../credentials.js";
import { localDate } from "../format.js";
import { bindValidation } from "../components/form-validation.js";
const terminal = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);
export function mountWorkbenchPage({ root, api, store }) {
  const d = root.ownerDocument,
    status = feedback(d),
    select = el(d, "select", {
      id: "workbenchTarget",
      "aria-label": "当前检索目标",
    }),
    mode = el(
      d,
      "select",
      { "aria-label": "评价模式" },
      el(d, "option", { value: "rules" }, "离线规则"),
      el(d, "option", { value: "ai" }, "模型辅助"),
    ),
    stats = el(d, "div", { className: "stats" }),
    progress = el(d, "section", { className: "card" }),
    jobs = el(d, "section", { className: "stack" }),
    history = el(d, "section", { className: "card" }),
    diagnostics = diagnosticsPanel({ document: d, api }),
    toolbar = el(d, "form", { className: "card toolbar" });
  const temporaryKey = el(d, "input", {
    type: "password",
    autocomplete: "off",
    placeholder: "本次更新的临时 Key（可选）",
    "aria-label": "本次更新临时模型密钥",
  });
  let targets = [],
    profiles = [],
    destroyed = false,
    starting = false,
    streamController,
    runId,
    dialog,
    loading = 0,
    historyLoading = 0;
  const start = button(
      d,
      "更新招聘来源",
      async () => {
        if (starting || start.disabled || !validation.check()) return;
        const targetRevisionId = select.value;
        const body = runValues();
        starting = true;
        start.disabled = true;
        status.show("");
        try {
          const run = await api.request("/runs", {
            method: "POST",
            body,
          });
          temporaryKey.value = "";
          if (destroyed || select.value !== targetRevisionId) return;
          runId = run.runId;
          store.dispatch({ type: "run-start", runId });
          void connect(runId);
        } catch (e) {
          if (destroyed || select.value !== targetRevisionId) return;
          validation.show(e);
          updateStart();
        } finally {
          starting = false;
          updateStart();
        }
      },
      { className: "primary", id: "startRun" },
    ),
    cancel = button(
      d,
      "取消任务",
      async () => {
        try {
          await api.request("/runs/" + runId + "/cancel", {
            method: "POST",
            body: {},
          });
          status.show("已请求取消，已采集数据保留。", false, { notify: true });
        } catch (e) {
          status.show(e.message, true);
        }
      },
      { id: "cancelRun", disabled: true },
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
        el(d, "p", { className: "section-label" }, "YOUR NEXT OPPORTUNITY"),
        el(d, "h1", {}, "把下一步准备好"),
        el(d, "p", {}, "有依据的机会，持续更新的求职进度。"),
      ),
    ),
    status.node,
    toolbar,
    stats,
    el(
      d,
      "div",
      { className: "grid" },
      el(d, "div", { className: "stack" }, progress, diagnostics.node, history),
      jobs,
    ),
  );
  toolbar.append(
    field(d, "当前检索目标", select, "必选；使用已保存且启用的检索目标。"),
    field(
      d,
      "评价模式",
      mode,
      "规则模式无需 Key；模型辅助使用已配置密钥或本次临时 Key。",
    ),
    field(
      d,
      "本次更新临时模型密钥",
      temporaryKey,
      "可空，使用已配置密钥；最多 512 字符，不含空白或换行，支持兼容服务商 Key。规则模式不发送密钥。",
    ),
    start,
    cancel,
  );
  const runValues = () => ({
    targetRevisionId: select.value,
    mode: mode.value,
    ...(mode.value === "rules"
      ? {}
      : temporaryKey.value
        ? { userApiKey: temporaryKey.value }
        : temporaryCredentials.get()),
  });
  const validation = bindValidation(toolbar, {
    kind: "run",
    fields: { targetRevisionId: select, mode, userApiKey: temporaryKey },
    values: runValues,
    options: () => ({ targetRevisionIds: targets.map((t) => t.revisionId) }),
  });
  const updateMode = () => {
    temporaryKey.disabled = mode.value === "rules";
    validation.clear();
  };
  mode.addEventListener("change", updateMode);
  updateMode();
  toolbar.addEventListener("submit", (e) => {
    e.preventDefault();
    start.click();
  });
  function updateStart() {
    const selected = targets.find((t) => t.revisionId === select.value);
    start.disabled =
      starting ||
      (store.getState().run && !terminal.has(store.getState().run.status)) ||
      !versionAvailability(selected, profiles).canCollect;
  }
  async function loadJobs() {
    const request = ++loading;
    try {
      const target = targets.find((t) => t.revisionId === select.value),
        data = await readAllJobs(api, {
          targetId: target?.targetId,
          targetRevisionId: target?.revisionId,
        });
      if (destroyed || request !== loading) return;
      const today = localDate(new Date().toISOString()),
        until = localDate(new Date(Date.now() + 7 * 86400000).toISOString()),
        active = ["new", "seen", "interested", "applied", "interviewing"],
        counts = [
          [
            "未处理",
            data.items.filter((i) => i.application.status === "new").length,
          ],
          [
            "需要跟进",
            data.items.filter(
              (i) =>
                active.includes(i.application.status) &&
                i.application.followUpAt &&
                localDate(i.application.followUpAt) <= today,
            ).length,
          ],
          [
            "七天内截止",
            data.items.filter(
              (i) =>
                i.deadlineAt &&
                localDate(i.deadlineAt) >= today &&
                localDate(i.deadlineAt) <= until,
            ).length,
          ],
          ["目标岗位记录", data.total],
        ];
      stats.replaceChildren(
        ...counts.map(([name, n]) =>
          el(
            d,
            "div",
            { className: "card stat" },
            el(d, "span", {}, name),
            el(d, "strong", { className: "number" }, n),
          ),
        ),
      );
      jobs.replaceChildren(
        el(d, "h2", {}, "值得继续了解"),
        renderJobList({
          document: d,
          items: data.items
            .filter((i) => i.application.status === "new")
            .slice(0, 5),
          onOpen: async (id) => {
            try {
              const detail = await api.request(
                "/jobs/" +
                  encodeURIComponent(id) +
                  (select.value
                    ? "?targetRevisionId=" + encodeURIComponent(select.value)
                    : ""),
              );
              if (!destroyed)
                dialog = openJobDetail({
                  root,
                  detail,
                  api,
                  onChanged: loadJobs,
                });
            } catch (e) {
              status.show(e.message, true);
            }
          },
        }),
        el(d, "a", { href: "#/jobs", className: "button" }, "查看完整岗位库"),
      );
    } catch (e) {
      if (!destroyed) status.show(e.message, true);
    }
  }
  async function connect(id) {
    diagnostics.setRunId(id);
    streamController?.abort();
    const controller = new AbortController(),
      targetRevisionId = select.value;
    streamController = controller;
    const current = () =>
      !destroyed &&
      !controller.signal.aborted &&
      streamController === controller &&
      select.value === targetRevisionId;
    cancel.disabled = false;
    start.disabled = true;
    status.show("任务在服务端运行，关闭页面后会继续。");
    try {
      await api.streamRun(id, {
        afterSeq: store.getState().run?.lastSeq || 0,
        signal: controller.signal,
        onEvent: (e) => {
          if (current()) store.dispatch({ type: "run-event", event: e });
        },
      });
      if (!current()) return;
      const run = await api.request("/runs/" + id);
      if (!current()) return;
      progress.replaceChildren(runProgress({ document: d, run }));
      if (terminal.has(run.status)) {
        status.show(
          runOutcomeText(run),
          ["failed", "interrupted"].includes(run.status),
          { notify: true },
        );
        void diagnostics.refresh();
      }
      cancel.disabled = true;
      updateStart();
      await loadJobs();
      await loadHistory();
    } catch (e) {
      if (current() && e.name !== "AbortError") {
        status.show(
          "连接中断：" + e.message + "。点击重新连接读取任务状态。",
          true,
        );
        progress.append(button(d, "重新连接", () => void connect(id)));
      }
    }
  }
  const unsubscribe = store.subscribe((state) => {
    targets = targets.map((t) => state.versions?.[t.revisionId] || t);
    profiles = profiles.map((p) => state.versions?.[p.revisionId] || p);
    updateStart();
    if (destroyed || !state.run) return;
    progress.replaceChildren(runProgress({ document: d, run: state.run }));
    cancel.disabled = terminal.has(state.run.status);
    if (terminal.has(state.run.status)) {
      status.show(
        runOutcomeText(state.run),
        ["failed", "interrupted"].includes(state.run.status),
        { notify: true },
      );
      updateStart();
    }
  });
  async function loadHistory() {
    const request = ++historyLoading,
      targetRevisionId = select.value;
    const result = await api.request(
      "/runs?targetId=" +
        (targets.find((t) => t.revisionId === select.value)?.targetId || ""),
    );
    if (
      destroyed ||
      request !== historyLoading ||
      select.value !== targetRevisionId
    )
      return [];
    const selectedRuns = (result.runs || []).filter(
      (r) =>
        (r.targetSnapshot?.revisionId || r.targetRevisionId) ===
        targetRevisionId,
    );
    history.replaceChildren(
      el(d, "h2", {}, "最近更新"),
      ...selectedRuns.slice(0, 5).map((r) =>
        button(d, r.createdAt + " · " + r.status, () => {
          runId = r.runId;
          store.dispatch({ type: "run-start", runId });
          void connect(runId);
        }),
      ),
    );
    return selectedRuns;
  }
  select.addEventListener("change", async () => {
    streamController?.abort();
    runId = null;
    diagnostics.setRunId(null);
    cancel.disabled = true;
    updateStart();
    status.show("");
    progress.replaceChildren(runProgress({ document: d, run: null }));
    const t = targets.find((t) => t.revisionId === select.value);
    store.dispatch({
      type: "target",
      id: t.targetId,
      revisionId: t.revisionId,
    });
    updateStart();
    const revisionId = select.value;
    try {
      await loadJobs();
      const runs = await loadHistory();
      if (destroyed || select.value !== revisionId) return;
      const active = runs.find((r) => !terminal.has(r.status));
      if (active) {
        runId = active.runId;
        store.dispatch({ type: "run-start", runId });
        void connect(runId);
      }
    } catch (e) {
      if (!destroyed && select.value === revisionId)
        status.show(e.message, true);
    }
  });
  const ready = (async () => {
    try {
      const [targetData, profileData] = await Promise.all([
        api.request("/targets"),
        api.request("/profiles"),
      ]);
      targets = (targetData.targets || []).filter((t) => !t.archivedAt);
      profiles = profileData.profiles || [];
      if (destroyed) return;
      if (!targets.length) {
        start.disabled = true;
        select.disabled = true;
        progress.replaceChildren(
          el(
            d,
            "div",
            { className: "empty" },
            el(d, "h2", {}, "先确认简历并创建求职目标"),
            el(
              d,
              "a",
              { href: "#/profiles", className: "button primary" },
              "前往简历与目标",
            ),
          ),
        );
        return;
      }
      select.replaceChildren(
        ...targets.map((t) =>
          el(d, "option", { value: t.revisionId }, versionLabel(t)),
        ),
      );
      select.value =
        targets.find((t) => t.revisionId === store.getState().targetRevisionId)
          ?.revisionId ||
        targets.find((t) => t.targetId === store.getState().selectedTargetId)
          ?.revisionId ||
        targets[0].revisionId;
      const t = targets.find((t) => t.revisionId === select.value);
      store.dispatch({
        type: "target",
        id: t.targetId,
        revisionId: t.revisionId,
      });
      progress.replaceChildren(runProgress({ document: d, run: null }));
      updateStart();
      await loadJobs();
      const runs = await loadHistory(),
        active = runs.find((r) => !terminal.has(r.status));
      if (active) {
        runId = active.runId;
        store.dispatch({ type: "run-start", runId });
        void connect(runId);
      }
    } catch (e) {
      if (!destroyed) status.show(e.message, true);
    }
  })();
  return {
    ready,
    destroy() {
      destroyed = true;
      temporaryKey.value = "";
      streamController?.abort();
      unsubscribe();
      diagnostics.destroy();
      dialog?.close();
      root.replaceChildren();
    },
  };
}
