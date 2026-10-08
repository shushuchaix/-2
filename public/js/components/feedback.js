import { el } from "./dom.js";
export function feedback(document) {
  const node = el(document, "div", {
    "aria-live": "polite",
    className: "feedback",
  });
  return {
    node,
    show(text, error = false, { notify = false } = {}) {
      node.textContent = text;
      node.className = error ? "feedback error" : "feedback";
      node.setAttribute("role", error ? "alert" : "status");
      if (notify && text)
        document.dispatchEvent(
          new document.defaultView.CustomEvent("rjr-notification", {
            detail: { text, error },
          }),
        );
    },
  };
}
