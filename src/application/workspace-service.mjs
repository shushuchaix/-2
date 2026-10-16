import { randomUUID } from "node:crypto";
import { createPackageVersionService } from "./package-version-service.mjs";
import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import { normalizeWorkspaceExtensions } from "../domain/workspace-management.mjs";
import {
  normalizeVersionName,
  assertVersionNameAvailable,
} from "../domain/version-names.mjs";
import {
  countVersionReferences,
  versionAvailability,
} from "../domain/version-references.mjs";
const array = (v, name) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim()))
    throw Error("Invalid " + name);
  return [...new Set(v.map((x) => x.trim()))];
};
export function legacyCityMode(cities) {
  return cities == null ? "from_profile" : cities.length ? "selected" : "any";
}
export function createWorkspaceService({
  repository,
  clock = repository.clock,
  sourceIds,
  siteIds,
  modelConfig,
  trashService,
  operationGate = createWorkspaceOperationGate({ repository }),
}) {
  const ownedService = createPackageVersionService({
    repository,
    clock,
    sourceIds,
    siteIds,
    modelConfig,
    trashService,
  });
  const isOwned = async () => (await repository.read()).schemaVersion === 3;
  const now = () => new Date(clock.now()).toISOString();
  const revision = (w, key, id) =>
    Object.values(w[key])
      .flat()
      .find((r) => r.revisionId === id) || null;
  const ensure = (w) => Object.assign(w, normalizeWorkspaceExtensions(w));
  const view = (w, item, kind) =>
    item
      ? {
          ...item,
          ...w.versionMetadata[item.revisionId],
          references: countVersionReferences(w, {
            kind,
            revisionId: item.revisionId,
          }),
          availability:
            kind === "target"
              ? versionAvailability(w, item)
              : {
                  canCollect: !w.versionMetadata[item.revisionId]?.archivedAt,
                  canRescore: !w.versionMetadata[item.revisionId]?.archivedAt,
                  reasonCode: w.versionMetadata[item.revisionId]?.archivedAt
                    ? "profile_archived"
                    : null,
                },
        }
      : null;
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, stable(value[k])]),
          )
        : value;
  const requestHash = (input) =>
    contentHash(
      stable(
        Object.fromEntries(
          Object.entries(input).filter(
            ([k]) =>
              ![
                "submissionId",
                "revisionId",
                "revision",
                "createdAt",
                "archivedAt",
                "updatedAt",
                "availability",
                "nameKey",
                "kind",
                "references",
              ].includes(k),
          ),
        ),
      ),
    );
  function replay(w, input, kind, submissionInput = input) {
    if (!input.submissionId) return null;
    if (
      typeof input.submissionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(input.submissionId)
    )
      throw inputError({ submissionId: "提交标识无效，请重新提交。" });
    const prior = w.versionSubmissions[kind + ":" + input.submissionId];
    if (!prior) return null;
    if (prior.inputHash !== requestHash(submissionInput))
      throw Object.assign(
        inputError(
          { submissionId: "同一提交标识内容已变化，请重新提交。" },
          "提交内容冲突。",
          409,
        ),
        { code: "version_submission_conflict" },
      );
    const saved = revision(
      w,
      kind === "profile" ? "profiles" : "targets",
      prior.revisionId,
    );
    if (!saved)
      throw Object.assign(
        inputError(
          { submissionId: "该提交对应的版本已永久删除，请发起新的提交。" },
          "原版本已永久删除。",
          409,
        ),
        { code: "version_submission_retired" },
      );
    return view(w, saved, kind);
  }
  function register(w, input, item, kind, submissionInput = input) {
    const name =
      input.versionName ||
      (kind === "profile"
        ? `${item.createdAt.slice(0, 10)} · ${item.revisionId}`
        : null);
    const normalized = assertVersionNameAvailable(w, {
      kind,
      versionName: name,
    });
    w.versionMetadata[item.revisionId] = {
      kind,
      ...normalized,
      enabled: kind === "profile" || item.enabled !== false,
      archivedAt: null,
      updatedAt: now(),
    };
    if (input.submissionId)
      w.versionSubmissions[kind + ":" + input.submissionId] = {
        revisionId: item.revisionId,
        inputHash: requestHash(submissionInput),
      };
    return view(w, item, kind);
  }
  async function manage(
    action,
    {
      kind,
      parentId,
      revisionId,
      versionName,
      enabled,
      operationLease,
      packageId,
    },
  ) {
    if (await isOwned())
      return ownedService[
        {
          update: "updateVersion",
          archive: "archiveVersion",
          restore: "restoreVersion",
          delete: "permanentlyDeleteVersion",
        }[action]
      ]({
        kind,
        parentId,
        revisionId,
        versionName,
        enabled,
        operationLease,
        packageId,
      });
    if (!["profile", "target"].includes(kind))
      throw inputError({ kind: "版本种类无效。" });
    const key = kind === "profile" ? "profiles" : "targets";
    return (
      await repository.mutateWorkspace(
        (w) => {
          ensure(w);
          const item = revision(w, key, revisionId);
          if (!item)
            throw Object.assign(Error("版本不存在，请刷新列表。"), {
              status: 404,
            });
          if (item[kind + "Id"] !== parentId)
            throw Object.assign(
              inputError({ revisionId: "该版本不属于所选项目，请刷新列表。" }),
              { code: "version_parent_mismatch" },
            );
          const meta = w.versionMetadata[revisionId];
          if (action === "delete" || action === "archive") {
            const references = countVersionReferences(w, {
              kind,
              revisionId,
              excludeOperationId: operationLease?.operationId,
            });
            if (references.activeOperations)
              throw Object.assign(
                inputError(
                  {
                    revisionId:
                      "该版本仍有采集或评分操作，请等待结束或取消后重试。",
                  },
                  "版本仍有活动操作。",
                  409,
                ),
                { code: "workspace_operation_busy", references },
              );
            if (action === "delete") {
              if (!meta.archivedAt)
                throw inputError({
                  revisionId: "请先移入回收站，再永久删除。",
                });
              if (Object.values(references).some((n) => n > 0))
                throw Object.assign(
                  inputError(
                    {
                      revisionId:
                        "该版本仍被历史、目标或投递引用，不能永久删除。",
                    },
                    "版本仍有引用。",
                    409,
                  ),
                  { code: "version_referenced", references },
                );
              const kept = w[key][parentId].filter(
                (r) => r.revisionId !== revisionId,
              );
              if (kept.length) w[key][parentId] = kept;
              else delete w[key][parentId];
              delete w.versionMetadata[revisionId];
              delete w.targetMembers[revisionId];
              return { deleted: revisionId, permanent: true };
            }
            meta.archivedAt ||= now();
          } else if (action === "restore") meta.archivedAt = null;
          else {
            if (enabled !== undefined) {
              if (kind !== "target" || typeof enabled !== "boolean")
                throw inputError({ enabled: "目标启停状态需要布尔值。" });
              if (meta.archivedAt)
                throw Object.assign(
                  inputError({ revisionId: "请先恢复该版本。" }),
                  { code: "version_archived" },
                );
              meta.enabled = enabled;
            }
            if (versionName !== undefined) {
              const normalized = assertVersionNameAvailable(w, {
                kind,
                versionName,
                revisionId,
              });
              if (
                normalized.versionName === meta.versionName &&
                enabled === undefined
              )
                return { ...view(w, item, kind), unchanged: true };
              Object.assign(meta, normalized);
            }
          }
          meta.updatedAt = now();
          return view(w, item, kind);
        },
        { operationLease },
      )
    ).result;
  }
  return {
    async saveProfile(input) {
      if (await isOwned()) return ownedService.saveProfile(input);
      assertInput("profile", input, { partial: true });
      return (
        await repository.mutateWorkspace((w) => {
          ensure(w);
          const prior = replay(w, input, "profile");
          if (prior) return prior;
          const profileId = input.profileId || "p-" + randomUUID();
          const list = w.profiles[profileId] || [];
          const number = (w.versionCounters.profile[profileId] || 0) + 1;
          w.versionCounters.profile[profileId] = number;
          const text = String(input.text || "");
          const overrides = structuredClone(input.overrides || {});
          const profile = {
            ...structuredClone(input.profile || input),
            ...overrides,
          };
          for (const k of [
            "text",
            "profileId",
            "overrides",
            "parserVersion",
            "versionName",
            "submissionId",
            "revisionId",
            "revision",
            "archivedAt",
            "availability",
            "nameKey",
            "enabled",
            "updatedAt",
            "kind",
          ])
            delete profile[k];
          const item = {
            profileId,
            revision: number,
            revisionId: profileId + "@" + number,
            text,
            profile,
            overrides,
            contentHash: contentHash({ text, profile, overrides }),
            parserVersion: input.parserVersion || "confirmed-1",
            createdAt: now(),
          };
          w.profiles[profileId] = [...list, item];
          return register(w, input, item, "profile");
        })
      ).result;
    },
    async saveTarget(input, { submissionInput = input } = {}) {
      if (await isOwned())
        return ownedService.saveTarget(input, { submissionInput });
      normalizeVersionName(input.versionName);
      const model =
        typeof modelConfig === "function" ? modelConfig() : modelConfig;
      return (
        await repository.mutateWorkspace((w) => {
          ensure(w);
          const prior = replay(w, input, "target", submissionInput);
          if (prior) return prior;
          assertInput("target", input, {
            nativeTypes: true,
            model,
            sourceIds:
              typeof sourceIds === "function" ? sourceIds() : sourceIds,
            siteIds: typeof siteIds === "function" ? siteIds(w) : siteIds,
          });
          const profile = revision(w, "profiles", input.profileRevisionId);
          if (!profile)
            throw inputError({
              profileRevisionId: "画像版本已不存在，请重新选择。",
            });
          if (w.versionMetadata[profile.revisionId].archivedAt)
            throw Object.assign(
              inputError({
                profileRevisionId: "关联简历在回收站，请先恢复或选择其他简历。",
              }),
              { code: "version_archived" },
            );
          const targetId = input.targetId || "t-" + randomUUID();
          const list = w.targets[targetId] || [];
          const number = (w.versionCounters.target[targetId] || 0) + 1;
          w.versionCounters.target[targetId] = number;
          const cityMode = input.cityMode || legacyCityMode(input.cities);
          if (!["any", "from_profile", "selected"].includes(cityMode))
            throw Error("Invalid city mode");
          const cities = array(input.cities || [], "cities");
          if (cityMode === "selected" && !cities.length)
            throw Error("Selected cities required");
          const degreePolicy =
            input.degreePolicy ||
            (input.minDegree ? "minimum_requirement" : "eligibility");
          if (!["eligibility", "minimum_requirement"].includes(degreePolicy))
            throw Error("Invalid degree policy");
          const roles = array(input.roles || input.targetRoles || [], "roles");
          if (!roles.length) throw Error("Roles required");
          const jobTypes = array(
            input.jobTypes || ["campus", "internship"],
            "job types",
          );
          if (
            jobTypes.some(
              (t) => !["campus", "internship", "social", "unknown"].includes(t),
            )
          )
            throw Error("Invalid job type");
          const coverageMode = input.coverageMode || "standard";
          if (!["standard", "broad"].includes(coverageMode))
            throw Error("Invalid coverage mode");
          const budgets = structuredClone(input.budgets || {});
          const item = {
            targetId,
            revision: number,
            revisionId: targetId + "@" + number,
            profileRevisionId: profile.revisionId,
            enabled: input.enabled !== false,
            roles,
            cityMode,
            cities,
            graduationYear:
              input.graduationYear || profile.profile.graduationYear || null,
            jobTypes,
            degreePolicy,
            minDegree: input.minDegree || null,
            sourceIds: array(input.sourceIds || [], "sources"),
            siteIds: array(input.siteIds || [], "sites"),
            coverageMode,
            budgets,
            createdAt: now(),
          };
          w.targets[targetId] = [...list, item];
          return register(w, input, item, "target", submissionInput);
        })
      ).result;
    },
    async getProfileRevision(id) {
      if (await isOwned()) return ownedService.getProfileRevision(id);
      const w = normalizeWorkspaceExtensions(await repository.read());
      return view(w, revision(w, "profiles", id), "profile");
    },
    async getTargetRevision(id) {
      if (await isOwned()) return ownedService.getTargetRevision(id);
      const w = normalizeWorkspaceExtensions(await repository.read());
      return view(w, revision(w, "targets", id), "target");
    },
    async listProfiles() {
      if (await isOwned()) return ownedService.listProfiles();
      const w = normalizeWorkspaceExtensions(await repository.read());
      return Object.values(w.profiles)
        .flat()
        .map((item) => view(w, item, "profile"));
    },
    async listTargets() {
      if (await isOwned()) return ownedService.listTargets();
      const w = normalizeWorkspaceExtensions(await repository.read());
      return Object.values(w.targets)
        .flat()
        .map((item) => view(w, item, "target"));
    },
    updateVersion: (args) => manage("update", args),
    archiveVersion: (args) => manage("archive", args),
    restoreVersion: (args) => manage("restore", args),
    permanentlyDeleteVersion: (args) =>
      args.operationLease
        ? manage("delete", args)
        : operationGate.withOperation(
            "permanent-delete",
            {},
            (operationLease) => manage("delete", { ...args, operationLease }),
          ),
    async deleteProfileRevision(id) {
      if (await isOwned()) return ownedService.deleteProfileRevision(id);
      const item = revision(await repository.read(), "profiles", id);
      if (!item)
        throw Object.assign(Error("简历版本不存在。"), { status: 404 });
      return manage("archive", {
        kind: "profile",
        parentId: item.profileId,
        revisionId: id,
      });
    },
  };
}
