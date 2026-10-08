// Mutable management data lives beside immutable revisions and evidence.
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const versionNameKey = (value) =>
  String(value).normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
const maps = [
  "versionMetadata",
  "versionSubmissions",
  "targetMembers",
  "jobRedirects",
  "dedupOperations",
  "operationLeases",
];
export function normalizeWorkspaceExtensions(workspace) {
  const w = structuredClone(workspace);
  for (const key of maps) if (w[key] === undefined) w[key] = {};
  w.versionCounters ??= { profile: {}, target: {} };
  w.managementVersion = 1;
  w.membershipVersion ??= 0;
  for (const [kind, collection] of [
    ["profile", "profiles"],
    ["target", "targets"],
  ]) {
    const used = new Set(
      Object.values(w.versionMetadata)
        .filter((m) => m.kind === kind)
        .map((m) => m.nameKey),
    );
    for (const [parentId, list] of Object.entries(w[collection]).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      w.versionCounters[kind][parentId] = Math.max(
        w.versionCounters[kind][parentId] || 0,
        ...list.map((r) => r.revision || 0),
      );
      for (const r of list) {
        if (w.versionMetadata[r.revisionId]) continue;
        const prefix =
          kind === "target"
            ? r.roles?.join("、") || "检索目标"
            : r.createdAt?.slice(0, 10) || "历史简历";
        const base = `${[...prefix].slice(0, 30).join("")} · v${r.revision} · ${r.revisionId.slice(-12)}`;
        let name = base,
          suffix = 2;
        while (used.has(versionNameKey(name))) name = `${base} · ${suffix++}`;
        used.add(versionNameKey(name));
        w.versionMetadata[r.revisionId] = {
          kind,
          versionName: name,
          nameKey: versionNameKey(name),
          enabled: kind === "profile" || r.enabled !== false,
          archivedAt: null,
          updatedAt: r.createdAt || "1970-01-01T00:00:00.000Z",
        };
      }
    }
  }
  return w;
}
export function needsWorkspaceUpgrade(w) {
  if (w.membershipVersion !== 1) return true;
  if (
    w.managementVersion !== 1 ||
    maps.some((k) => w[k] === undefined) ||
    !w.versionCounters
  )
    return true;
  return ["profiles", "targets"].some((key) =>
    Object.values(w[key])
      .flat()
      .some((r) => !w.versionMetadata[r.revisionId]),
  );
}
export function assertWorkspaceExtensions(w) {
  for (const key of maps)
    if (w[key] !== undefined && !plain(w[key])) throw Error("Invalid " + key);
  if (w.managementVersion !== undefined && w.managementVersion !== 1)
    throw Error("Invalid managementVersion");
  if (
    w.membershipVersion !== undefined &&
    ![0, 1].includes(w.membershipVersion)
  )
    throw Error("Invalid membershipVersion");
  const revisions = new Map();
  for (const [kind, key] of [
    ["profile", "profiles"],
    ["target", "targets"],
  ])
    for (const r of Object.values(w[key]).flat())
      revisions.set(r.revisionId, { kind, revision: r });
  const names = new Set();
  for (const [id, m] of Object.entries(w.versionMetadata || {})) {
    if (
      !plain(m) ||
      revisions.get(id)?.kind !== m.kind ||
      typeof m.versionName !== "string" ||
      [...m.versionName].length < 1 ||
      [...m.versionName].length > 60 ||
      m.nameKey !== versionNameKey(m.versionName) ||
      typeof m.enabled !== "boolean" ||
      !(m.archivedAt === null || typeof m.archivedAt === "string") ||
      typeof m.updatedAt !== "string"
    )
      throw Error("Invalid versionMetadata");
    const key = m.kind + ":" + m.nameKey;
    if (names.has(key)) throw Error("Duplicate version name");
    names.add(key);
  }
  if (w.versionCounters !== undefined) {
    if (!plain(w.versionCounters)) throw Error("Invalid versionCounters");
    for (const kind of ["profile", "target"]) {
      if (
        !plain(w.versionCounters[kind]) ||
        Object.values(w.versionCounters[kind]).some(
          (n) => !Number.isSafeInteger(n) || n < 0,
        )
      )
        throw Error("Invalid versionCounters");
    }
  }
  for (const value of Object.values(w.versionSubmissions || {}))
    if (
      !plain(value) ||
      typeof value.revisionId !== "string" ||
      typeof value.inputHash !== "string"
    )
      throw Error("Invalid versionSubmissions");
  for (const [id, redirect] of Object.entries(w.jobRedirects || {})) {
    if (
      !plain(redirect) ||
      w.jobs[id] ||
      typeof redirect.toJobId !== "string" ||
      typeof redirect.operationId !== "string"
    )
      throw Error("Invalid job redirect");
    let current = id;
    const seen = new Set();
    while (w.jobRedirects[current]) {
      if (seen.has(current) || seen.size > Object.keys(w.jobRedirects).length)
        throw Error("Cyclic job redirect");
      seen.add(current);
      current = w.jobRedirects[current].toJobId;
    }
    if (!w.jobs[current]) throw Error("Dangling job redirect");
  }
  for (const [targetId, members] of Object.entries(w.targetMembers || {})) {
    if (revisions.get(targetId)?.kind !== "target" || !plain(members))
      throw Error("Invalid targetMembers reference");
    for (const [id, m] of Object.entries(members)) {
      if (!w.jobs[id] || !plain(m) || !Array.isArray(m.factRefs))
        throw Error("Invalid targetMembers");
      for (const ref of m.factRefs)
        if (!plain(ref) || !w.observations[ref.observationId])
          throw Error("Invalid member observation");
      if (
        m.currentObservationId !== undefined &&
        m.currentObservationId !== null &&
        !m.factRefs.some((ref) => ref.observationId === m.currentObservationId)
      )
        throw Error("Invalid member current observation");
      if (
        m.factContentHash !== undefined &&
        m.factContentHash !== null &&
        (typeof m.factContentHash !== "string" ||
          !/^job-fact-v1:[a-f0-9]{64}$/.test(m.factContentHash))
      )
        throw Error("Invalid member fact hash");
    }
  }
  for (const value of Object.values(w.dedupOperations || {}))
    if (
      !plain(value) ||
      typeof value.planHash !== "string" ||
      !plain(value.counts) ||
      typeof value.backupId !== "string"
    )
      throw Error("Invalid dedupOperations");
  for (const value of Object.values(w.operationLeases || {}))
    if (
      !plain(value) ||
      typeof value.kind !== "string" ||
      !Number.isSafeInteger(value.ownerPid) ||
      typeof value.token !== "string"
    )
      throw Error("Invalid operationLeases");
}
