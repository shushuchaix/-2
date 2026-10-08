import { randomUUID } from "node:crypto";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { normalizeWorkspaceExtensions } from "../domain/workspace-management.mjs";
import { assertVersionNameAvailable } from "../domain/version-names.mjs";
import { requirePackage, packageError } from "../domain/packages.mjs";
import { countPackageRecords } from "../domain/package-ownership.mjs";
import { versionAvailability } from "../domain/version-references.mjs";

const flat = (w, key) => Object.values(w[key]).flat();
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
const requestHash = (input) =>
  contentHash(
    stable(
      Object.fromEntries(
        Object.entries(input).filter(([k]) => !["submissionId"].includes(k)),
      ),
    ),
  );
export function createPackageVersionService({
  repository,
  clock = repository.clock,
  sourceIds,
  siteIds,
  modelConfig,
  trashService,
}) {
  const at = () => new Date(clock.now()).toISOString();
  const find = (w, key, id) =>
    flat(w, key).find((r) => r.revisionId === id) || null;
  const view = (w, r) =>
    r
      ? {
          ...structuredClone(r),
          ...w.versionMetadata[r.revisionId],
          packageId: r.ownerPackageId,
          state: w.packages[r.ownerPackageId].state,
          counts: countPackageRecords(w, r.ownerPackageId),
          availability: r.targetId
            ? versionAvailability(w, r)
            : { canCollect: true, canRescore: true, reasonCode: null },
        }
      : null;
  function replay(w, input, kind, submissionInput) {
    if (!input.submissionId) return null;
    if (
      typeof input.submissionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(input.submissionId)
    )
      throw inputError({ submissionId: "提交标识无效，请重新提交。" });
    const prior = w.versionSubmissions[kind + ":" + input.submissionId];
    if (!prior) return null;
    if (prior.inputHash !== requestHash(submissionInput))
      throw packageError(
        "version_submission_conflict",
        "同一提交标识的内容已变化，请重新提交。",
      );
    const r = find(
      w,
      kind === "profile" ? "profiles" : "targets",
      prior.revisionId,
    );
    if (!r)
      throw packageError(
        "version_submission_retired",
        "原版本已永久清理，请发起新的提交。",
      );
    requirePackage(w, r.ownerPackageId, { now: clock.now() });
    return view(w, r);
  }
  async function reserve(tx, w, input, kind, submissionInput) {
    const c = structuredClone(tx.control),
      hash = requestHash(submissionInput);
    const token = contentHash([kind, input.submissionId || randomUUID()]);
    const reservations = (c.migrationJournal.versionReservations ||= {});
    let reservation = reservations[token];
    if (reservation) {
      if (reservation.inputHash !== hash)
        throw packageError(
          "version_submission_conflict",
          "同一提交标识的内容已变化，请重新提交。",
        );
      if (c.deletionLedger[reservation.packageId])
        throw packageError(
          "version_submission_retired",
          "原版本已永久清理，请发起新的提交。",
        );
      return structuredClone(reservation);
    }
    const parentId =
      input[kind + "Id"] || (kind === "profile" ? "p-" : "t-") + randomUUID();
    const counterKey = kind + ":" + parentId,
      number =
        Math.max(
          c.versionHighWater[counterKey] || 0,
          w.versionCounters[kind][parentId] || 0,
        ) + 1;
    reservation = {
      inputHash: hash,
      parentId,
      number,
      revisionId: parentId + "@" + number,
      packageId: randomUUID(),
      recordId: randomUUID(),
      profileSnapshotId: kind === "target" ? randomUUID() : null,
      createdAt: at(),
    };
    reservations[token] = reservation;
    c.versionHighWater[counterKey] = number;
    c.identityIndex.package["version:" + token] = reservation.packageId;
    c.identityIndex.record["version:" + token] = reservation.recordId;
    if (reservation.profileSnapshotId)
      c.identityIndex.record["profile-copy:" + token] =
        reservation.profileSnapshotId;
    await tx.commitControl(c);
    return structuredClone(reservation);
  }
  function register(w, input, r, kind, normalized, submissionInput) {
    const owner = r.ownerPackageId;
    w.packages[owner] = {
      packageId: owner,
      kind,
      versionId: r.revisionId,
      ...normalized,
      enabled: kind === "profile" || r.enabled !== false,
      state: "active",
      archiveId: null,
      archivedAt: null,
      purgeAt: null,
    };
    w.versionMetadata[r.revisionId] = {
      kind,
      ...normalized,
      enabled: kind === "profile" || r.enabled !== false,
      archivedAt: null,
      updatedAt: r.createdAt,
    };
    w.versionCounters[kind][r[kind + "Id"]] = r.revision;
    if (input.submissionId)
      w.versionSubmissions[kind + ":" + input.submissionId] = {
        revisionId: r.revisionId,
        inputHash: requestHash(submissionInput),
      };
    if (kind === "target") w.targetMembers[r.revisionId] = {};
  }
  async function save(input, kind, { submissionInput = input } = {}) {
    return repository.withMaintenanceTransaction(async (tx) => {
      const w = normalizeWorkspaceExtensions(tx.workspace),
        prior = replay(w, input, kind, submissionInput);
      if (prior) return prior;
      const name =
        input.versionName ||
        (kind === "profile"
          ? "简历 " + at().slice(0, 10) + " " + randomUUID().slice(0, 8)
          : null);
      const normalized = assertVersionNameAvailable(w, {
        kind,
        versionName: name,
      });
      let source;
      if (kind === "profile") assertInput("profile", input, { partial: true });
      else {
        assertInput("target", input, {
          nativeTypes: true,
          model:
            typeof modelConfig === "function" ? modelConfig() : modelConfig,
          sourceIds: typeof sourceIds === "function" ? sourceIds() : sourceIds,
          siteIds: typeof siteIds === "function" ? siteIds(w) : siteIds,
        });
        source = find(w, "profiles", input.profileRevisionId);
        if (!source)
          throw inputError({
            profileRevisionId: "画像版本已不存在，请重新选择。",
          });
        requirePackage(w, source.ownerPackageId, { now: clock.now() });
      }
      const reservation = await reserve(tx, w, input, kind, submissionInput);
      const { parentId, number, revisionId, packageId, recordId, createdAt } =
        reservation;
      let r = {
        recordId,
        ownerPackageId: packageId,
        packageId,
        [kind + "Id"]: parentId,
        revision: number,
        revisionId,
        createdAt,
      };
      if (kind === "profile") {
        const text = String(input.text || ""),
          overrides = structuredClone(input.overrides || {}),
          profile = { ...structuredClone(input.profile || {}), ...overrides };
        Object.assign(r, {
          text,
          profile,
          overrides,
          contentHash: contentHash({ text, profile, overrides }),
          parserVersion: input.parserVersion || "confirmed-1",
          importMetadata: structuredClone(
            input.importMetadata || input.import || null,
          ),
        });
      } else {
        const copy = structuredClone(source);
        Object.assign(copy, {
          profileId: "copy-" + packageId,
          revisionId: "copy-" + packageId + "@1",
          revision: 1,
          recordId: reservation.profileSnapshotId,
          ownerPackageId: packageId,
          packageId,
          provenance: {
            profileRevisionId: source.revisionId,
            sourcePackageId: source.ownerPackageId,
          },
        });
        for (const key of [
          "counts",
          "references",
          "availability",
          "state",
          "versionName",
          "nameKey",
          "enabled",
          "archivedAt",
          "updatedAt",
        ])
          delete copy[key];
        Object.assign(r, {
          profileRevisionId: source.revisionId,
          profileSnapshot: copy,
          incomplete: false,
          enabled: input.enabled !== false,
          roles: [...new Set(input.roles || input.targetRoles)],
          cityMode:
            input.cityMode ||
            (input.cities == null
              ? "from_profile"
              : input.cities.length
                ? "selected"
                : "any"),
          cities: [...new Set(input.cities || [])],
          graduationYear:
            input.graduationYear || copy.profile.graduationYear || null,
          jobTypes: [...new Set(input.jobTypes || ["campus", "internship"])],
          degreePolicy:
            input.degreePolicy ||
            (input.minDegree ? "minimum_requirement" : "eligibility"),
          minDegree: input.minDegree || null,
          sourceIds: [...new Set(input.sourceIds || [])],
          siteIds: [...new Set(input.siteIds || [])],
          coverageMode: input.coverageMode || "standard",
          budgets: structuredClone(input.budgets || {}),
        });
      }
      const key = kind === "profile" ? "profiles" : "targets";
      (w[key][parentId] ||= []).push(r);
      register(w, input, r, kind, normalized, submissionInput);
      await tx.commitWorkspace(w);
      return view(tx.workspace, r);
    });
  }
  async function get(key, id) {
    const w = await repository.read(),
      r = find(w, key, id);
    if (r) requirePackage(w, r.ownerPackageId, { now: clock.now() });
    return view(w, r);
  }
  async function list(key) {
    const w = await repository.read();
    return flat(w, key)
      .filter((r) => w.packages[r.ownerPackageId]?.state === "active")
      .map((r) => view(w, r));
  }
  function locate(w, args) {
    const r = args.revisionId
      ? flat(w, "profiles")
          .concat(flat(w, "targets"))
          .find((r) => r.revisionId === args.revisionId)
      : flat(w, "profiles")
          .concat(flat(w, "targets"))
          .find((r) => r.ownerPackageId === args.packageId);
    if (!r)
      throw packageError("package_not_found", "版本不存在，请刷新列表。", 404);
    if (
      (args.packageId && args.packageId !== r.ownerPackageId) ||
      (args.kind && args.kind !== (r.targetId ? "target" : "profile")) ||
      (args.parentId &&
        args.parentId !== r.targetId &&
        args.parentId !== r.profileId)
    )
      throw packageError("package_scope_mismatch", "所选版本与数据包不一致。");
    return r;
  }
  const lifecycle = (action) => async (args) => {
    if (!trashService)
      throw packageError(
        "package_lifecycle_required",
        "请通过回收站服务操作版本。",
      );
    const w = await repository.read(),
      r = locate(w, args);
    return trashService[action]({ ...args, packageId: r.ownerPackageId });
  };
  return {
    saveProfile: (input) => save(input, "profile"),
    saveTarget: (input, options) => save(input, "target", options),
    getProfileRevision: (id) => get("profiles", id),
    getTargetRevision: (id) => get("targets", id),
    listProfiles: () => list("profiles"),
    listTargets: () => list("targets"),
    async updateVersion(args) {
      return (
        await repository.mutateWorkspace(
          (w) => {
            Object.assign(w, normalizeWorkspaceExtensions(w));
            const r = locate(w, args),
              p = requirePackage(w, r.ownerPackageId, { now: clock.now() }),
              meta = w.versionMetadata[r.revisionId];
            if (args.versionName !== undefined) {
              const name = assertVersionNameAvailable(w, {
                kind: p.kind,
                versionName: args.versionName,
                revisionId: r.revisionId,
              });
              Object.assign(meta, name);
              Object.assign(p, name);
            }
            if (args.enabled !== undefined) {
              if (p.kind !== "target" || typeof args.enabled !== "boolean")
                throw inputError({ enabled: "目标启停状态需要布尔值。" });
              meta.enabled = args.enabled;
              p.enabled = args.enabled;
            }
            meta.updatedAt = at();
            return view(w, r);
          },
          { operationLease: args.operationLease },
        )
      ).result;
    },
    archiveVersion: lifecycle("archive"),
    restoreVersion: lifecycle("restore"),
    permanentlyDeleteVersion: lifecycle("purgeOne"),
    async deleteProfileRevision(id) {
      const w = await repository.read(),
        r = locate(w, { revisionId: id, kind: "profile" });
      return lifecycle("archive")({ packageId: r.ownerPackageId });
    },
  };
}
