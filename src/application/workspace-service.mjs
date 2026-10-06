import { randomUUID } from "node:crypto";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import { contentHash } from "../infrastructure/storage/repository.mjs";
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
}) {
  const now = () => new Date(clock.now()).toISOString();
  const revision = (w, key, id) =>
    Object.values(w[key])
      .flat()
      .find((r) => r.revisionId === id) || null;
  return {
    async saveProfile(input) {
      assertInput("profile", input, { partial: true });
      return (
        await repository.mutateWorkspace((w) => {
          const profileId = input.profileId || "p-" + randomUUID();
          const list = w.profiles[profileId] || [];
          const number = list.length
            ? Math.max(...list.map((r) => r.revision)) + 1
            : 1;
          const text = String(input.text || "");
          const overrides = structuredClone(input.overrides || {});
          const profile = {
            ...structuredClone(input.profile || input),
            ...overrides,
          };
          for (const k of ["text", "profileId", "overrides", "parserVersion"])
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
          return item;
        })
      ).result;
    },
    async saveTarget(input) {
      assertInput("target", input, { nativeTypes: true });
      return (
        await repository.mutateWorkspace((w) => {
          assertInput("target", input, {
            nativeTypes: true,
            sourceIds:
              typeof sourceIds === "function" ? sourceIds() : sourceIds,
            siteIds: typeof siteIds === "function" ? siteIds(w) : siteIds,
          });
          const profile = revision(w, "profiles", input.profileRevisionId);
          if (!profile)
            throw inputError({
              profileRevisionId: "画像版本已不存在，请重新选择。",
            });
          const targetId = input.targetId || "t-" + randomUUID();
          const list = w.targets[targetId] || [];
          const number = list.length
            ? Math.max(...list.map((r) => r.revision)) + 1
            : 1;
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
          return item;
        })
      ).result;
    },
    async getProfileRevision(id) {
      return revision(await repository.read(), "profiles", id);
    },
    async getTargetRevision(id) {
      return revision(await repository.read(), "targets", id);
    },
    async listProfiles() {
      return Object.values((await repository.read()).profiles).flat();
    },
    async listTargets() {
      return Object.values((await repository.read()).targets).flat();
    },
    async deleteProfileRevision(id) {
      return (
        await repository.mutateWorkspace((w) => {
          if (
            Object.values(w.targets)
              .flat()
              .some((t) => t.profileRevisionId === id) ||
            Object.values(w.runs).some(
              (r) => r.targetSnapshot?.profileRevisionId === id,
            ) ||
            Object.values(w.applications).some((a) => a.resumeRevisionId === id)
          ) {
            const message =
              "该简历版本已被求职目标、历史更新任务或投递记录引用，不能删除。请保留该版本；如需修改简历，请创建新版本。";
            throw Object.assign(
              inputError({ profileRevisionId: message }, message, 409),
              { code: "profile_revision_referenced" },
            );
          }
          for (const [key, list] of Object.entries(w.profiles)) {
            const kept = list.filter((r) => r.revisionId !== id);
            if (kept.length) w.profiles[key] = kept;
            else delete w.profiles[key];
          }
          return { deleted: id };
        })
      ).result;
    },
  };
}
