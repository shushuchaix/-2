import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "./fixtures.mjs";
import { createFakeClock } from "./clock.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import {
  openPackageControl,
  createEmptyControl,
} from "../../src/infrastructure/storage/package-control.mjs";
import { createEmptyWorkspace } from "../../src/domain/contracts.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createTrashService } from "../../src/application/trash-service.mjs";
export function failOnce(fsAdapter, phase) {
  let armed = phase;
  const match = {
    control_commit: "state.json",
    workspace_commit: "workspace.v2.json",
    previous_commit: "workspace.v2.previous.json",
    snapshot_write: "runs-v2",
    backup_replace: "backups",
  };
  return {
    ...fsAdapter,
    arm(when) {
      armed = when;
    },
    async rename(from, to) {
      if (armed && String(to).includes(match[armed] || "never")) {
        armed = null;
        throw Error("synthetic storage failure");
      }
      return fsAdapter.rename(from, to);
    },
    async unlink(file) {
      if (armed === "file_cleanup" && !String(file).endsWith(".tmp")) {
        armed = null;
        throw Error("synthetic storage failure");
      }
      return fsAdapter.unlink(file);
    },
  };
}
export async function packageFixture(t, options = {}) {
  const dataDir = options.dataDir || (await createTempDir(t)),
    clock = options.clock || createFakeClock("2026-10-09T00:00:00.000Z");
  const adapter = failOnce(fs, null);
  const f = {
    clock,
    dataDir,
    fsAdapter: adapter,
    armFailure: (phase) => adapter.arm(phase),
  };
  async function open() {
    f.repository = await openWorkspaceRepository({
      dataDir,
      clock,
      fsAdapter: adapter,
    });
    f.control = openPackageControl({ dataDir, fsAdapter: adapter });
    f.trash = createTrashService({
      repository: f.repository,
      cancelPackageAndWait: options.cancelPackageAndWait,
    });
    f.workspaceService = createWorkspaceService({
      repository: f.repository,
      modelConfig: options.modelConfig,
      trashService: f.trash,
    });
  }
  await open();
  if ((await f.repository.read()).schemaVersion !== 3)
    await f.repository.withMaintenanceTransaction(
      async (tx) => {
        await tx.commitControl(tx.control || createEmptyControl());
        await tx.commitWorkspace(createEmptyWorkspace({ schemaVersion: 3 }));
      },
      { bootstrap: true },
    );
  f.reopen = async () => {
    await open();
    return f;
  };
  f.twoTargets = async () => {
    const sourceProfile = await f.workspaceService.saveProfile({
      text: "合成测试简历：本科消防工程专业，拥有机场消防、安全检查与工程项目经验。",
      profile: { major: "消防工程", cities: ["北京"], education: "本科" },
      versionName: "合成简历",
      submissionId: "synthetic-profile",
    });
    const make = async (id, role) => {
      const v = await f.workspaceService.saveTarget({
        versionName: id,
        submissionId: "synthetic-" + id,
        profileRevisionId: sourceProfile.revisionId,
        roles: [role],
        cityMode: "any",
        cities: [],
        jobTypes: ["campus", "social"],
        sourceIds: ["synthetic"],
        siteIds: [],
        budgets: {},
      });
      return { ...v, targetRevisionId: v.revisionId };
    };
    const a = await make("fire", "消防"),
      b = await make("airport", "机场");
    return { sourceProfile, a, b };
  };
  if (options.failPhase) f.armFailure(options.failPhase);
  return f;
}
