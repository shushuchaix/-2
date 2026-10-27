// A literal occurring somewhere in a notice is not proof it belongs to a job.
const fieldHeading =
  /^(?:学历(?:要求)?|专业(?:要求)?|经验(?:要求)?|工作地点|工作城市|工作地|报名(?:截止|时间)?|投递(?:方式|时间)?|发布日期|账号所在地|账号|联系人|招聘条件|任职要求|资格条件|岗位职责|待遇|人数|薪资|福利|职责|要求|备注|截至|截止(?:时间|日期)?)$/;
const escape = (value) =>
  Array.from(value)
    .map((c) => ("\\^$.*+?()[]{}|".includes(c) ? "\\" + c : c))
    .join("");
export function sharedArticleHeader(text) {
  const headings = /(?:^|[。；\n])\s*([^，。；\n:：]{2,45})[:：]/g;
  let match;
  while ((match = headings.exec(text)))
    if (!fieldHeading.test(match[1].trim())) return text.slice(0, match.index);
  return "";
}
export function scopedArticleExcerpt(text, position, rows = []) {
  const title = position.title?.trim(),
    excerpt = position.requirementsExcerpt?.trim();
  if (!title || !excerpt) return null;
  if (rows.length) {
    const matches = rows.filter(
      (r) =>
        !r.ambiguous && r.text?.includes(title) && r.text.includes(excerpt),
    );
    return matches.length === 1
      ? { text: matches[0].text, row: matches[0], start: null }
      : null;
  }
  const anchor = new RegExp(
    "^(?:\\s*(?:[（(]?\\d+[)）.、]\\s*)?)(?:(?:岗位|职位)(?:名称)?\\s*[:：]\\s*)?" +
      escape(title) +
      "(?=[:：\\s]|要求|任职|$)",
    "m",
  );
  let offset = 0;
  while (offset < text.length) {
    const match = anchor.exec(text.slice(offset));
    if (!match) break;
    const start = offset + match.index;
    const tail = text.slice(start),
      headings = /(?:^|[。；\n])\s*([^，。；\n:：]{2,45})[:：]/g;
    let end = text.length,
      h;
    while ((h = headings.exec(tail))) {
      const label = h[1].trim();
      if (h.index > 0 && !fieldHeading.test(label)) {
        end = start + h.index + (/[。；]/.test(h[0][0]) ? 1 : 0);
        break;
      }
    }
    const scoped = text.slice(start, end);
    if (scoped.includes(excerpt))
      return {
        text: scoped,
        row: null,
        start: start + scoped.indexOf(excerpt),
      };
    offset = Math.max(start + match[0].length, end);
  }
  return null;
}
export function scopedLiteral(text, value, field) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || !text.includes(clean)) return "";
  if (
    field === "city" &&
    !new RegExp(
      "(?:工作(?:地点|城市)|工作地|驻地)\\s*[:：为在]?\\s*" + escape(clean),
    ).test(text)
  )
    return "";
  if (
    field === "deadline" &&
    !new RegExp(
      "(?:截止(?:时间|日期)?|截至|有效期(?:至|到))\\s*[:：为]?\\s*" +
        escape(clean),
    ).test(text)
  )
    return "";
  return clean;
}
