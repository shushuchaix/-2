const normalized = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,。;；:：()[\]（）【】]/g, "");
const sourceOf = (r) => r.sourceId || r.source || "unknown";
const scopeOf = (r) => r.identityScope || r.siteId || sourceOf(r);
const citiesOf = (r) =>
  (r.cities || [r.city])
    .filter(Boolean)
    .map((x) => normalized(x).replace(/市$/, ""))
    .filter((x) => !["全国", "不限", "远程"].includes(x));
const knownType = (r) =>
  r.jobType && r.jobType !== "unknown" ? r.jobType : null;
const levelOf = (r) =>
  r.level ||
  String(r.title || "").match(/(?:^|[^A-Za-z])([IVX]{1,4})$/)?.[1] ||
  String(r.title || "").match(
    /(?:^|[^A-Za-z])([PMLT][0-9]{1,2})(?:$|[^0-9A-Za-z])/,
  )?.[1] ||
  String(r.title || "").match(/高级|资深|初级|中级|实习/)?.[0] ||
  null;
export function canonicalizeSourceUrl(value, policy = {}) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("Invalid job url");
  for (const key of [...u.searchParams.keys()])
    if (/^utm_/i.test(key) || (policy.trackingParams || []).includes(key))
      u.searchParams.delete(key);
  u.searchParams.sort();
  if (policy.preserveHash === false) u.hash = "";
  return u.href;
}
export function resolveJobIdentity(record) {
  const id = record.sourceRecordId;
  if (id !== null && id !== undefined && String(id) !== "") {
    const key =
      "id:" + JSON.stringify([sourceOf(record), scopeOf(record), String(id)]);
    return {
      key,
      strength: "strong",
      aliases: record.url
        ? [key, "url:" + canonicalizeSourceUrl(record.url, record.urlPolicy)]
        : [key],
    };
  }
  if (record.url) {
    const key = "url:" + canonicalizeSourceUrl(record.url, record.urlPolicy);
    return { key, strength: "url", aliases: [key] };
  }
  const key =
    "fields:" +
    JSON.stringify([
      sourceOf(record),
      scopeOf(record),
      normalized(record.company),
      normalized(record.title),
      citiesOf(record).sort(),
      knownType(record),
      record.graduationYear || null,
      levelOf(record),
    ]);
  return { key, strength: "weak", aliases: [key] };
}
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) =>
    new Set([...s].slice(1).map((_, i) => s.slice(i, i + 2)));
  const x = grams(a),
    y = grams(b);
  let intersection = 0;
  for (const g of x) if (y.has(g)) intersection++;
  return intersection / (x.size + y.size - intersection);
}
export function relateJobs(a, b) {
  const x = resolveJobIdentity(a),
    y = resolveJobIdentity(b);
  if (x.strength === "strong" && y.strength === "strong" && x.key === y.key)
    return { relation: "same", reasons: ["authority_id"] };
  const conflicts = [];
  if (
    x.strength === "strong" &&
    y.strength === "strong" &&
    sourceOf(a) === sourceOf(b) &&
    scopeOf(a) === scopeOf(b)
  )
    conflicts.push("different_recruitment_ids");
  const ca = citiesOf(a),
    cb = citiesOf(b);
  if (ca.length && cb.length && !ca.some((c) => cb.includes(c)))
    conflicts.push("different_cities");
  if (
    a.graduationYear &&
    b.graduationYear &&
    String(a.graduationYear) !== String(b.graduationYear)
  )
    conflicts.push("different_cohorts");
  if (knownType(a) && knownType(b) && knownType(a) !== knownType(b))
    conflicts.push("different_job_types");
  if (levelOf(a) && levelOf(b) && levelOf(a) !== levelOf(b))
    conflicts.push("different_levels");
  if (a.kind && b.kind && a.kind !== b.kind) conflicts.push("different_kinds");
  if (conflicts.length) return { relation: "distinct", reasons: conflicts };
  if (
    (x.key === y.key && x.strength !== "weak") ||
    x.aliases.some(
      (alias) => alias.startsWith("url:") && y.aliases.includes(alias),
    )
  )
    return { relation: "same", reasons: ["canonical_url"] };
  if (
    normalized(a.company) &&
    normalized(a.company) === normalized(b.company) &&
    similarity(normalized(a.title), normalized(b.title)) >= 0.82
  )
    return { relation: "possible", reasons: ["similar_company_title"] };
  return { relation: "distinct", reasons: ["insufficient_identity_evidence"] };
}
