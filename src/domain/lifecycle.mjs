export function deriveLifecycle({
  previous = {},
  observations = [],
  coverage = [],
  detailEvidence = [],
  now = new Date(),
} = {}) {
  const date = new Date(now).getTime();
  const deadline = Date.parse(previous.canonical?.deadlineAt || "");
  const deadlinePassed = Number.isFinite(deadline) && deadline < date;
  const closed = detailEvidence.filter(
    (e) => e.closed === true && e.reason && e.url,
  );
  if (closed.length)
    return { state: "closed", evidence: closed, deadlinePassed };
  if (observations.length)
    return {
      state: "observed",
      evidence: observations.map((o) => ({
        url: o.url || o.fields?.url,
        at: o.observedAt,
      })),
      deadlinePassed,
    };
  const missing = detailEvidence.filter(
    (e) => e.status === 404 || e.status === 410 || e.inaccessible,
  );
  if (missing.length)
    return { state: "inaccessible", evidence: missing, deadlinePassed };
  const absent = coverage.filter(
    (c) =>
      c.status === "complete" &&
      !c.truncated &&
      c.previouslyObserved &&
      c.scopeKey &&
      (previous.absenceCounts?.[c.scopeKey] || 0) >= 1,
  );
  if (absent.length)
    return {
      state: "notRecentlySeen",
      evidence: absent.map((c) => ({ scopeKey: c.scopeKey, at: c.finishedAt })),
      deadlinePassed,
    };
  return {
    state: previous.lifecycle || "unknown",
    evidence: previous.lifecycleEvidence || [],
    deadlinePassed,
  };
}
