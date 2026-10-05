import { el, button } from "./dom.js";
import { feedback } from "./feedback.js";
import { duplicateCompare } from "./duplicate-compare.js";
import {
  formatSalary,
  formatDate,
  KIND_LABELS,
  QUALIFICATION_LABELS,
  safeExternalUrl,
} from "../format.js";
export function openJobDetail({ root, detail, api, onChanged }) {
  const d = root.ownerDocument,
    previous = d.activeElement,
    status = feedback(d),
    backdrop = el(d, "div", { className: "dialog-backdrop" }),
    dialog = el(d, "section", {
      className: "dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "detailTitle",
      tabindex: "-1",
    }),
    close = () => {
      backdrop.remove();
      previous?.focus?.();
    },
    key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const nodes = [
          ...dialog.querySelectorAll("button,a[href],input,select,textarea"),
        ].filter((n) => !n.disabled);
        if (!nodes.length) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && d.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && d.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
  dialog.addEventListener("keydown", key);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  const render = async (data = detail) => {
    const { job, evaluations = [], observations = [] } = data,
      r = job.canonical;
    dialog.replaceChildren(
      el(
        d,
        "div",
        { className: "row" },
        el(
          d,
          "span",
          { className: "badge" },
          KIND_LABELS[r.kind] || "招聘公告",
        ),
        button(d, "关闭", close, { "aria-label": "关闭岗位详情" }),
      ),
      el(d, "h2", { id: "detailTitle" }, r.title),
      el(
        d,
        "p",
        { className: "muted" },
        [
          r.company || "公司未提供",
          (r.cities || []).join(" / "),
          formatSalary(r.salary),
        ].join(" · "),
      ),
      status.node,
    );
    if (r.kind !== "job")
      dialog.append(
        el(
          d,
          "p",
          { className: "notice-banner" },
          "此记录是" +
            (KIND_LABELS[r.kind] || "招聘公告") +
            "，不能直接视为一个完整岗位。具体职责、资格与账号归属仍需核实。",
        ),
      );
    dialog.append(
      el(d, "p", {}, "首次发现：" + formatDate(job.firstSeen)),
      el(d, "p", {}, "发布日期：" + formatDate(r.publishedAt)),
      el(d, "p", {}, "最近观察：" + formatDate(job.lastSeen)),
      el(d, "p", {}, "截止日期：" + formatDate(r.deadlineAt)),
      el(
        d,
        "p",
        {},
        "来源：" +
          r.sourceId +
          " / " +
          (r.siteId || "") +
          " · " +
          (r.evidenceLevel || "公开来源") +
          " · " +
          (r.accessStatus || "public"),
      ),
      el(d, "small", {}, "岗位 ID：" + job.jobId),
    );
    for (const [label, url] of [
      ["查看原始来源", r.url],
      ["前往投递", r.applyUrl],
    ]) {
      const safe = safeExternalUrl(url);
      if (safe)
        dialog.append(
          el(
            d,
            "a",
            {
              href: safe,
              target: "_blank",
              rel: "noopener noreferrer",
              className: "button",
            },
            label,
          ),
        );
    }
    dialog.append(
      el(
        d,
        "section",
        { className: "detail-section" },
        el(d, "h3", {}, "招聘正文"),
        el(
          d,
          "div",
          { className: "prose" },
          r.description || "没有正文，资料不足。",
        ),
      ),
    );
    const sorted = [...evaluations].sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
    if (!sorted.length)
      dialog.append(
        el(d, "p", { className: "notice-banner" }, "待核实 · 尚未生成评价"),
      );
    for (const e of sorted)
      dialog.append(
        el(
          d,
          "section",
          { className: "detail-section" },
          el(
            d,
            "h3",
            {},
            "匹配分 " +
              e.score +
              " · " +
              QUALIFICATION_LABELS[e.qualification?.status || "unknown"],
          ),
          el(
            d,
            "p",
            { className: "muted" },
            "分数用于比较匹配程度，不代表录用概率。资料完整度 " +
              (e.completeness?.score ?? "未知"),
          ),
          el(
            d,
            "small",
            {},
            "画像 " +
              e.profileRevisionId +
              " · 目标 " +
              e.targetRevisionId +
              " · " +
              (e.model || e.ruleVersion || e.status),
          ),
          el(
            d,
            "div",
            { className: "prose" },
            (e.qualification?.checks || [])
              .map(
                (c) =>
                  c.type +
                  "：" +
                  QUALIFICATION_LABELS[c.status] +
                  " · " +
                  c.reason +
                  (c.evidence?.excerpt ? "\n依据：" + c.evidence.excerpt : ""),
              )
              .join("\n\n"),
          ),
          el(
            d,
            "div",
            { className: "prose" },
            Object.entries(e.components || {})
              .map(([k, v]) => k + " " + v.score + "/" + v.max)
              .join(" · "),
          ),
          el(
            d,
            "div",
            { className: "prose" },
            "差距：" + (e.gaps || []).join("；"),
          ),
        ),
      );
    dialog.append(
      el(
        d,
        "section",
        { className: "detail-section" },
        el(d, "h3", {}, "观察证据 · " + observations.length + " 次"),
        observations.map((o) =>
          el(
            d,
            "details",
            {},
            el(d, "summary", {}, formatDate(o.observedAt) + " · " + o.sourceId),
            el(
              d,
              "div",
              { className: "prose" },
              o.fields?.description || "无正文",
            ),
          ),
        ),
      ),
      duplicateCompare({
        document: d,
        job,
        relatedJobs: data.relatedJobs,
        api,
        status,
        onChanged: async () => {
          await render(await api.request("/jobs/" + job.jobId));
          await onChanged?.();
        },
      }),
    );
  };
  void render();
  backdrop.append(dialog);
  root.append(backdrop);
  dialog.querySelector("button")?.focus();
  return { close };
}
