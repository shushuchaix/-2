const secret =
  /api.?key|password|authorization|cookie|secret|access.?token|refresh.?token/i;
export function redactBusiness(value) {
  if (Array.isArray(value)) return value.map(redactBusiness);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !secret.test(k))
        .map(([k, v]) => [k, redactBusiness(v)]),
    );
  return value;
}
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
