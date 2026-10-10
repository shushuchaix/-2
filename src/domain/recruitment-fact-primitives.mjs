const norm = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
const key = (v) => JSON.stringify(stable(v));
const known = (v) =>
  v !== null &&
  v !== undefined &&
  v !== "" &&
  v !== "unknown" &&
  (!Array.isArray(v) || v.length > 0);
export const conditionIdentity = (c) => ({
  type: c.type,
  operator: c.operator,
  values:
    c.operator === "range"
      ? (c.values || []).map(norm)
      : (c.values || []).map(norm).sort(),
  required: c.required !== false,
  preferred: c.preferred === true,
  grade: c.grade || null,
  registrationRequired: c.registrationRequired === true,
  ...(c.minimumInclusive === undefined
    ? {}
    : { minimumInclusive: c.minimumInclusive }),
  ...(c.maximumInclusive === undefined
    ? {}
    : { maximumInclusive: c.maximumInclusive }),
  ...(c.certificateOptions
    ? {
        certificateOptions: c.certificateOptions
          .map((o) => ({
            name: norm(o.name),
            grade: o.grade || null,
            registrationRequired: o.registrationRequired === true,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }
    : {}),
});
const majors = (r) =>
  [
    ...new Set(
      [
        ...(Array.isArray(r.major) ? r.major : [r.major]).filter(Boolean),
        ...(r.conditions || [])
          .filter(
            (c) => c.type === "major" && c.required !== false && !c.preferred,
          )
          .flatMap((c) => c.values || []),
      ].map(norm),
    ),
  ].sort();
const certificates = (r) =>
  [
    ...(r.requiredCertificates || []).map((c) =>
      typeof c === "string"
        ? { name: norm(c), required: true, preferred: false }
        : {
            name: norm(c.name),
            grade: c.grade || null,
            required: c.required !== false,
            preferred: c.preferred === true,
            registrationRequired: c.registrationRequired === true,
          },
    ),
    ...(r.conditions || [])
      .filter((c) => c.type === "certificate")
      .map((c) => ({
        ...conditionIdentity(c),
        name: (c.values || []).map(norm).join("|"),
      })),
  ]
    .map(key)
    .sort();
export function recruitmentConflicts(a, b) {
  const conflicts = [];
  for (const type of ["age", "formal_experience", "physical"]) {
    const aa = (a.conditions || [])
      .filter((c) => c.type === type && c.required !== false && !c.preferred)
      .map((c) => key(conditionIdentity(c)))
      .sort();
    const bb = (b.conditions || [])
      .filter((c) => c.type === type && c.required !== false && !c.preferred)
      .map((c) => key(conditionIdentity(c)))
      .sort();
    if (aa.length && bb.length && key(aa) !== key(bb))
      conflicts.push({
        field: type,
        decision: "review",
        code: "conflicting_" + type,
      });
  }
  if (
    [...(a.conditions || []), ...(b.conditions || [])].some(
      (c) => c.migrationStatus === "needs_review",
    )
  )
    conflicts.push({
      field: "conditions",
      decision: "review",
      code: "unverified_conditions",
    });
  for (const field of ["workMode", "employmentMode", "contractType"])
    if (known(a[field]) && known(b[field]) && norm(a[field]) !== norm(b[field]))
      conflicts.push({
        field,
        decision: "distinct",
        code: "different_" + field,
      });
  const am = majors(a),
    bm = majors(b);
  if (am.length && bm.length && key(am) !== key(bm))
    conflicts.push({
      field: "major",
      decision: "review",
      code: "conflicting_major",
    });
  const ac = certificates(a),
    bc = certificates(b);
  if (ac.length && bc.length && key(ac) !== key(bc))
    conflicts.push({
      field: "certificate",
      decision: "review",
      code: "conflicting_certificate",
    });
  if (
    (a.certificateRequirementStatus === "none" && bc.length) ||
    (b.certificateRequirementStatus === "none" && ac.length)
  )
    conflicts.push({
      field: "certificate",
      decision: "review",
      code: "conflicting_certificate",
    });
  const ab = a.batch || a.recruitmentBatch,
    bb = b.batch || b.recruitmentBatch;
  if (!!ab !== !!bb)
    conflicts.push({
      field: "batch",
      decision: "review",
      code: "batch_unknown",
    });
  return conflicts;
}
const canonical = (url) => {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()])
      if (/^utm_/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.href;
  } catch {
    return null;
  }
};
export function sharedVerifiedJobLocator(a, b) {
  if (
    norm(a.title) !== norm(b.title) ||
    !norm(a.company) ||
    norm(a.company) !== norm(b.company) ||
    a.kind !== "job" ||
    b.kind !== "job"
  )
    return false;
  const urls = (r) =>
    [
      ...(["job_detail"].includes(r.urlKind) ? [canonical(r.url)] : []),
      ...(r.verifiedJobLocator?.verified === true &&
      r.verifiedJobLocator.kind === "job_detail" &&
      norm(r.verifiedJobLocator.title) === norm(r.title) &&
      norm(r.verifiedJobLocator.company) === norm(r.company)
        ? [canonical(r.verifiedJobLocator.url)]
        : []),
    ].filter(Boolean);
  return urls(a).some((url) => urls(b).includes(url));
}
