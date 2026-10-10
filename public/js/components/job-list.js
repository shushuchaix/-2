import { el, button } from "./dom.js";
import {
  formatSalary,
  STATUS_LABELS,
  QUALIFICATION_LABELS,
  KIND_LABELS,
  formatDate,
} from "../format.js";
export function renderJobList({ document: d, items, onOpen }) {
  if (!items.length)
    return el(
      d,
      "div",
      { className: "empty" },
      el(d, "h2", {}, "这里还没有岗位"),
      el(d, "p", {}, "调整筛选，或回到工作台更新招聘来源。"),
    );
  return el(
    d,
    "div",
    { className: "stack" },
    items.map((item) =>
      el(
        d,
        "article",
        { className: "card job-card" },
        el(
          d,
          "div",
          { className: "row" },
          el(
            d,
            "span",
            { className: "badge" },
            KIND_LABELS[item.kind] || "招聘公告",
          ),
          el(
            d,
            "span",
            { className: "badge" },
            QUALIFICATION_LABELS[
              item.evaluation?.qualification?.status || "unknown"
            ],
          ),
          el(
            d,
            "span",
            { className: "badge" },
            item.evaluation?.recommendation
              ? {
                  high: "优先推荐",
                  consider: "可以考虑",
                  low: "匹配较低",
                  insufficient: "信息不足",
                  not_recommended: "不推荐",
                }[item.evaluation.recommendation] || "尚未评价"
              : "尚未评价",
          ),
          item.duplicateStatus && item.duplicateStatus !== "normal"
            ? el(
                d,
                "span",
                { className: "badge" },
                item.duplicateStatus === "protected"
                  ? "人工记录待处理"
                  : "疑似重复",
              )
            : null,
          item.fact && item.fact.status !== "verified"
            ? el(d, "span", { className: "badge" }, "该版本事实依据缺失")
            : null,
          el(
            d,
            "small",
            {},
            STATUS_LABELS[item.application?.status] || "未处理",
          ),
        ),
        button(d, item.title, () => onOpen(item.jobId), {
          className: "job-title",
          "data-job-id": item.jobId,
        }),
        el(
          d,
          "p",
          { className: "job-meta" },
          [
            item.company || "公司未提供",
            (item.cities || []).join(" / ") || "城市未提供",
            formatSalary(item.salary),
          ].join(" · "),
        ),
        el(
          d,
          "div",
          { className: "row" },
          el(
            d,
            "strong",
            {},
            item.evaluation ? "匹配分 " + item.evaluation.score : "尚未评价",
          ),
          el(
            d,
            "small",
            {},
            "来源 " +
              item.sourceId +
              " · 首次发现 " +
              formatDate(item.job?.firstSeen),
          ),
          item.job?.deadlinePassed
            ? el(d, "span", { className: "badge" }, "明确截止日期已过")
            : null,
        ),
      ),
    ),
  );
}
