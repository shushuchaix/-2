import { validateInput } from "../validation-rules.js";
import { el } from "./dom.js";
let nextId = 0;
export function bindValidation(
  form,
  { kind, fields, values, options = () => ({}) },
) {
  const d = form.ownerDocument,
    touched = new Set(),
    entries = new Map();
  let current = {},
    submitted = false,
    generic = "";
  form.setAttribute("novalidate", "");
  const summary = el(d, "div", {
    className: "validation-summary",
    role: "alert",
    tabindex: "-1",
    hidden: "",
  });
  form.prepend(summary);
  const inspect = () => {
    const found = validateInput(
      kind,
      values(),
      typeof options === "function" ? options() : options,
    );
    for (const [key, { node }] of entries)
      if (node.validity?.badInput)
        found[key] = "填写内容格式不正确，请完成有效的数字或日期。";
    return found;
  };
  const focus = (node) =>
    (node.matches?.("input,select,textarea,button")
      ? node
      : node.querySelector("input,select,textarea,button")
    )?.focus();
  for (const [key, node] of Object.entries(fields)) {
    if (!node) continue;
    const error = el(d, "p", {
      className: "field-error",
      id: "field-error-" + ++nextId,
      hidden: "",
    });
    const wrapper = node.closest(".field") || node.parentElement || form;
    const hint = wrapper.querySelector("small");
    if (hint && !hint.id) hint.id = "field-hint-" + nextId;
    const described = [
      node.getAttribute("aria-describedby"),
      hint?.id,
      error.id,
    ]
      .filter(Boolean)
      .join(" ");
    node.setAttribute("aria-describedby", described);
    if (wrapper === form) node.after(error);
    else wrapper.append(error);
    const label =
      wrapper.querySelector("legend,span")?.textContent ||
      node.getAttribute("aria-label") ||
      (wrapper.tagName === "LABEL" ? wrapper.textContent.trim() : null) ||
      "填写项";
    entries.set(key, { node, error, label });
    const recheck = () => {
      const found = inspect();
      for (const candidate of entries.keys())
        if (submitted || touched.has(candidate)) {
          if (found[candidate]) current[candidate] = found[candidate];
          else delete current[candidate];
        }
      generic = "";
      render();
    };
    node.addEventListener(
      "blur",
      () => {
        touched.add(key);
        recheck();
      },
      true,
    );
    for (const event of ["input", "change"])
      node.addEventListener(event, () => {
        if (submitted || touched.has(key)) recheck();
      });
  }
  function render() {
    const invalidNodes = new Set();
    for (const [key, { node, error }] of entries) {
      const message = current[key] || "";
      error.textContent = message;
      error.hidden = !message;
      if (message) invalidNodes.add(node);
    }
    for (const { node } of entries.values()) {
      if (invalidNodes.has(node)) node.setAttribute("aria-invalid", "true");
      else node.removeAttribute("aria-invalid");
    }
    summary.replaceChildren();
    if (generic) summary.append(el(d, "p", {}, generic));
    const all = Object.entries(current);
    if (all.length) {
      summary.append(el(d, "p", {}, "请检查以下填写项："));
      const list = el(d, "ul");
      for (const [key, msg] of all) {
        const entry = entries.get(key);
        list.append(
          el(
            d,
            "li",
            {},
            entry
              ? el(
                  d,
                  "button",
                  { type: "button", onClick: () => focus(entry.node) },
                  entry.label + "：" + msg,
                )
              : msg,
          ),
        );
      }
      summary.append(list);
    }
    summary.hidden = !generic && !all.length;
  }
  function show(error) {
    current =
      error?.fieldErrors && typeof error.fieldErrors === "object"
        ? { ...error.fieldErrors }
        : {};
    generic = Object.keys(current).length
      ? ""
      : error?.message || "操作失败，请稍后重试。";
    submitted = true;
    render();
    const first = Object.keys(current)
      .map((k) => entries.get(k))
      .find(Boolean);
    if (first) focus(first.node);
    else summary.focus();
  }
  return {
    check() {
      submitted = true;
      generic = "";
      current = inspect();
      render();
      const first = Object.keys(current)
        .map((k) => entries.get(k))
        .find(Boolean);
      if (first) focus(first.node);
      return !Object.keys(current).length;
    },
    show,
    clear() {
      current = {};
      generic = "";
      submitted = false;
      touched.clear();
      render();
    },
  };
}
