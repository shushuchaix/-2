import { el } from "./dom.js";
const names = {
  "/workbench": "工作台",
  "/jobs": "岗位库",
  "/applications": "投递进度",
  "/profiles": "简历与目标",
  "/settings": "数据源与设置",
};
export function mountShell({ root, store, router }) {
  const d = root.ownerDocument,
    nav = el(
      d,
      "nav",
      { "aria-label": "主导航" },
      Object.entries(names).map(([path, name]) =>
        el(d, "a", { href: "#" + path }, name),
      ),
    );
  const content = el(d, "main", { id: "page", tabindex: "-1" });
  root.replaceChildren(
    el(
      d,
      "a",
      {
        href: "#page",
        className: "skip-link",
        onClick: (e) => {
          e.preventDefault();
          content.focus();
        },
      },
      "跳到内容",
    ),
    el(
      d,
      "aside",
      { className: "sidebar" },
      el(
        d,
        "div",
        { className: "brand" },
        el(d, "span", { className: "brand-mark" }, "R"),
        el(
          d,
          "div",
          {},
          el(d, "strong", {}, "求职工作台"),
          el(d, "small", {}, "JOB RADAR · 本地工作区"),
        ),
      ),
      nav,
      el(
        d,
        "p",
        { className: "sidebar-note" },
        "把机会、证据与投递记录放在一起。",
      ),
    ),
    el(
      d,
      "div",
      { className: "workspace" },
      el(
        d,
        "header",
        { className: "topbar" },
        el(d, "span", {}, "个人工作区"),
        el(d, "span", { className: "badge" }, "数据保存在服务端"),
        el(
          d,
          "button",
          {
            id: "logoutBtn",
            type: "button",
            onClick: async () => {
              await fetch("/api/logout", { method: "POST" });
              globalThis.location.href = "/login";
            },
          },
          "退出登录",
        ),
      ),
      content,
      el(d, "div", { "aria-live": "polite", className: "shell-feedback" }),
    ),
  );
  const unsubscribe = store.subscribe((state) => {
    for (const a of nav.querySelectorAll("a")) {
      if (a.getAttribute("href") === "#" + state.route)
        a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  });
  return {
    content,
    destroy() {
      unsubscribe();
      root.replaceChildren();
    },
  };
}
