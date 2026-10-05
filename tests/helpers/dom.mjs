import { parseHTML } from "linkedom";
export function createTestDocument(html = '<main id="root"></main>') {
  const document = parseHTML(
    "<!doctype html><html><body>" + html + "</body></html>",
  ).document;
  const proto = Object.getPrototypeOf(document.createElement("select"));
  if (!Object.getOwnPropertyDescriptor(proto, "value")?.set)
    Object.defineProperty(proto, "value", {
      configurable: true,
      get() {
        return (
          this.querySelector("option[selected]")?.value ||
          this.querySelector("option")?.value ||
          ""
        );
      },
      set(value) {
        for (const option of this.options) {
          if (option.value === String(value))
            option.setAttribute("selected", "");
          else option.removeAttribute("selected");
        }
      },
    });
  return document;
}
export async function settle() {
  await new Promise((r) => setTimeout(r, 10));
}
export function submit(document, form) {
  form.dispatchEvent(
    new document.defaultView.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
}
