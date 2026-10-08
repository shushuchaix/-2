import { inputError } from "../../public/js/validation-rules.js";
function redirected(w, id) {
  const seen = new Set();
  while (w.jobRedirects?.[id]) {
    if (seen.has(id) || seen.size > Object.keys(w.jobRedirects).length)
      throw Error("Invalid cyclic job redirect");
    seen.add(id);
    id = w.jobRedirects[id].toJobId;
  }
  return w.jobs[id] ? id : null;
}
export function resolveJobId(w, id, { allowMissing = false } = {}) {
  const direct = redirected(w, id);
  if (direct) return direct;
  const ids = [
    ...new Set(
      (w.identityAliases[id] || [])
        .map((candidate) => redirected(w, candidate))
        .filter(Boolean),
    ),
  ];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1)
    throw Object.assign(
      inputError(
        { jobId: "该来源标识对应多个不同岗位，请选择具体岗位。" },
        "岗位身份存在歧义。",
        409,
      ),
      { code: "job_identity_ambiguous" },
    );
  if (allowMissing) return null;
  throw Object.assign(Error("Job not found"), { status: 404 });
}
export const resolveJobIds = (w, ids, options = {}) => [
  ...new Set(ids.map((id) => resolveJobId(w, id, options)).filter(Boolean)),
];
export const jobIdMatches = (w, storedId, requestedId) => {
  try {
    return (
      resolveJobId(w, storedId, { allowMissing: true }) ===
        resolveJobId(w, requestedId, { allowMissing: true }) &&
      !!resolveJobId(w, storedId, { allowMissing: true })
    );
  } catch {
    return false;
  }
};
export function resolveApplicationAssociation(w, application) {
  const candidates = application.legacyJobIds?.length
    ? application.legacyJobIds
    : [application.jobId];
  const ids = [];
  for (const id of candidates) {
    try {
      const resolved = resolveJobId(w, id, { allowMissing: true });
      if (resolved) ids.push(resolved);
    } catch (e) {
      if (e.code !== "job_identity_ambiguous") throw e;
      for (const candidate of w.identityAliases[id] || []) {
        const resolved = redirected(w, candidate);
        if (resolved) ids.push(resolved);
      }
    }
  }
  const jobIds = [...new Set(ids)];
  return {
    status:
      jobIds.length === 1 ? "single" : jobIds.length ? "ambiguous" : "missing",
    jobIds,
    originalApplicationId: application.jobId,
  };
}
