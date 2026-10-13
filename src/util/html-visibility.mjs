/** Explicit HTML visibility only; this does not execute CSS or JavaScript. */
export function isHiddenHtmlElement(node) {
  const style = (node.getAttribute("style") || "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  return (
    /^(?:HEAD|SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(node.tagName) ||
    node.hasAttribute("hidden") ||
    (node.getAttribute("aria-hidden") || "").trim().toLowerCase() === "true" ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test(
      style,
    ) ||
    (node.tagName === "INPUT" &&
      (node.getAttribute("type") || "").toLowerCase() === "hidden")
  );
}
export function isVisibleHtmlElement(element) {
  for (let node = element; node; node = node.parentElement)
    if (isHiddenHtmlElement(node)) return false;
  return true;
}
