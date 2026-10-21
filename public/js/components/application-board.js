import { el, button } from "./dom.js";
import { STATUS_LABELS, formatDate } from "../format.js";
export function applicationBoard({ document: d, items, mode, onEdit }) {
  const card = (item) =>
    el(
      d,
      "article",
      { className: "card application-card" },
      el(d, "strong", {}, item.title),
      el(
        d,
        "span",
        { className: "badge" },
        STATUS_LABELS[item.application.status],
      ),
      el(d, "small", {}, item.company || "公司未提供"),
      el(d, "small", {}, "跟进：" + formatDate(item.application.followUpAt)),
      el(d, "div", { className: "prose" }, item.application.note || "暂无备注"),
      button(d, "编辑投递记录", () => onEdit(item.jobId), {
        "data-edit-application": item.jobId,
      }),
    );
  if (!items.length)
    return el(
      d,
      "div",
      { className: "empty" },
      "暂无投递记录。先从岗位库选择机会。",
    );
  if (mode === "list")
    return el(d, "div", { className: "stack" }, items.map(card));
  const groups = [
    ["待处理", ["new", "seen", "interested"]],
    ["进展中", ["applied", "interviewing"]],
    ["已结束", ["offer", "rejected", "ignored"]],
  ];
  return el(
    d,
    "div",
    { className: "board" },
    groups.map(([name, statuses]) =>
      el(
        d,
        "section",
        { className: "stack" },
        el(d, "h2", {}, name),
        items.filter((i) => statuses.includes(i.application.status)).map(card),
      ),
    ),
  );
}
