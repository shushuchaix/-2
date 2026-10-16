const attribute = (tag, name) => {
  for (const match of tag.matchAll(
    /([a-z][\w:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'=<>`]+))/gi,
  ))
    if (match[1].toLowerCase() === name)
      return match.slice(2).find((value) => value !== undefined);
  return undefined;
};
const charsetFrom = (value) =>
  String(value || "").match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];

/** Decode bounded public responses; never execute page declarations. */
export function decodeResponseText(content, contentType = "") {
  const bytes = Buffer.from(content);
  let charset;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    charset = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
  else charset = charsetFrom(contentType);
  if (
    !charset &&
    /^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(contentType)
  ) {
    const head = bytes
      .subarray(0, 1024)
      .toString("latin1")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
    for (const match of head.matchAll(/<meta\s[^>]*>/gi)) {
      const tag = match[0];
      charset = attribute(tag, "charset");
      if (
        !charset &&
        /^content-type$/i.test(attribute(tag, "http-equiv") || "")
      )
        charset = charsetFrom(attribute(tag, "content"));
      if (charset) {
        if (/^utf-16(?:le|be)?$/i.test(charset)) charset = "utf-8";
        break;
      }
    }
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
