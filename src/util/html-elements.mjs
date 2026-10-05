import { htmlToText, decodeEntities } from "./html.mjs";
export function attribute(tag, name) {
  const m = tag.match(
    new RegExp(
      "(?:^|\\s)" +
        name +
        '\\s*=\\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\\s>]+))',
      "i",
    ),
  );
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null;
}
export function elementHtml(html, selector) {
  if (!selector || !/^(?:[.#][\w-]+|[a-z][\w-]*)$/i.test(selector)) return null;
  const source = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const openings = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  for (const match of source.matchAll(openings)) {
    const tag = match[1];
    const fits =
      selector[0] === "#"
        ? attribute(match[2], "id") === selector.slice(1)
        : selector[0] === "."
          ? (attribute(match[2], "class") || "")
              .split(/\s+/)
              .includes(selector.slice(1))
          : tag.toLowerCase() === selector.toLowerCase();
    if (!fits) continue;
    const start = match.index + match[0].length;
    const tokens = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
    tokens.lastIndex = start;
    let depth = 1,
      next;
    while ((next = tokens.exec(source))) {
      depth += next[1] ? -1 : 1;
      if (depth === 0) return source.slice(start, next.index);
    }
    return null;
  }
  return null;
}
export function elementText(html, selector) {
  const body = elementHtml(html, selector);
  return body === null ? null : htmlToText(body).trim();
}
export function htmlLinks(html, base) {
  const result = [];
  for (const m of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const raw = attribute(m[1], "href");
    if (!raw) continue;
    try {
      const url = new URL(raw, base);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue;
      result.push({
        url: url.href,
        title: attribute(m[1], "title") || htmlToText(m[2]).trim(),
      });
    } catch {}
  }
  return result;
}
export function explicitDate(text) {
  const m = String(text || "").match(
    /\b(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})(?:日)?/,
  );
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] &&
    d.getUTCMonth() === +m[2] - 1 &&
    d.getUTCDate() === +m[3]
    ? d.toISOString()
    : null;
}
