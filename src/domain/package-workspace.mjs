import { randomUUID } from "node:crypto";
import { packageError } from "./packages.mjs";
import { PRIVATE_MAPS } from "./package-ownership.mjs";
const owned = (values, packageId) =>
  Object.fromEntries(
    Object.entries(values || {}).filter(
      ([, r]) => r.ownerPackageId === packageId,
    ),
  );
export function packageWorkspace(w, packageId) {
  const view = structuredClone(w);
  view._scope = { packageId };
  for (const key of PRIVATE_MAPS) view[key] = owned(w[key], packageId);
  for (const key of ["profiles", "targets"])
    view[key] = Object.fromEntries(
      Object.entries(w[key])
        .map(([id, list]) => [
          id,
          list.filter((r) => r.ownerPackageId === packageId),
        ])
        .filter(([, list]) => list.length),
    );
  const jobs = new Set(Object.keys(view.jobs));
  view.identityAliases = Object.fromEntries(
    Object.entries(w.identityAliases)
      .map(([alias, ids]) => [
        alias,
        ids.filter(
          (id) =>
            jobs.has(id) || w.jobRedirects?.[id]?.ownerPackageId === packageId,
        ),
      ])
      .filter(([, ids]) => ids.length),
  );
  view.jobRedirects = owned(w.jobRedirects, packageId);
  view.duplicateGroups = Object.fromEntries(
    Object.entries(w.duplicateGroups).filter(([, g]) =>
      g.jobIds.every((id) => jobs.has(id) || view.jobRedirects[id]),
    ),
  );
  view.targetMembers = Object.fromEntries(
    Object.entries(w.targetMembers || {}).filter(([id]) =>
      Object.values(view.targets)
        .flat()
        .some((t) => t.revisionId === id),
    ),
  );
  return view;
}
export function mergePackageWorkspace(w, view, packageId) {
  const beforeJobIds = new Set(
    Object.values(w.jobs)
      .filter((r) => r.ownerPackageId === packageId)
      .map((r) => r.jobId),
  );
  for (const key of PRIVATE_MAPS) {
    for (const [id, r] of Object.entries(w[key]))
      if (r.ownerPackageId === packageId && !view[key][id]) delete w[key][id];
    for (const [id, r] of Object.entries(view[key])) {
      if (w[key][id] && w[key][id].ownerPackageId !== packageId)
        throw packageError(
          "package_scope_mismatch",
          "记录身份与其他数据包冲突。",
        );
      r.ownerPackageId = packageId;
      r.recordId ||= randomUUID();
      w[key][id] = r;
      if (key === "runs")
        for (const event of r.events || []) {
          event.ownerPackageId = packageId;
          event.recordId ||= randomUUID();
        }
    }
  }
  for (const [alias, ids] of Object.entries(w.identityAliases)) {
    w.identityAliases[alias] = ids.filter(
      (id) =>
        !beforeJobIds.has(id) &&
        w.jobRedirects?.[id]?.ownerPackageId !== packageId,
    );
    if (!w.identityAliases[alias].length) delete w.identityAliases[alias];
  }
  for (const [alias, ids] of Object.entries(view.identityAliases))
    w.identityAliases[alias] = [
      ...new Set([...(w.identityAliases[alias] || []), ...ids]),
    ];
  for (const key of ["jobRedirects", "duplicateGroups"]) {
    w[key] ||= {};
    for (const [id, r] of Object.entries(w[key]))
      if (
        (r.ownerPackageId === packageId ||
          r.jobIds?.every((id) => beforeJobIds.has(id))) &&
        !view[key][id]
      )
        delete w[key][id];
    for (const [id, r] of Object.entries(view[key] || {}))
      w[key][id] = { ...r, ownerPackageId: packageId };
  }
  for (const [id, members] of Object.entries(view.targetMembers || {}))
    w.targetMembers[id] = members;
}
