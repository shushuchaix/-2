import fs from "node:fs/promises";
import { guardDesktopSender } from "./credentials.mjs";
import { recordDiagnostic } from "../src/infrastructure/diagnostics/log.mjs";
export function registerDirectoryIpc({
  ipcMain,
  shell,
  clipboard,
  getWindow,
  getOrigin,
  layout,
  diagnostics,
}) {
  const locations = Object.freeze({
    data: layout.root,
    history: layout.runs,
    backups: layout.backups,
    cache: layout.cache,
    logs: layout.logs,
  });
  const mapped = (kind) => {
    if (typeof kind !== "string" || !Object.hasOwn(locations, kind))
      throw Error("请选择有效的数据目录类别。");
    return locations[kind];
  };
  const guarded = (phase, fn) =>
    guardDesktopSender({ getWindow, getOrigin }, async (...args) => {
      try {
        const result = await fn(...args);
        await recordDiagnostic(diagnostics, {
          operation: "desktop.directories",
          phase,
          outcome: "success",
          code: "directory_" + phase,
        });
        return result;
      } catch {
        const diagnostic = await recordDiagnostic(diagnostics, {
          operation: "desktop.directories",
          phase,
          outcome: "failed",
          code: "directory_operation_failed",
        });
        throw Object.assign(
          Error(
            "目录操作失败，请检查目录权限或重新打开软件。" +
              (diagnostic?.diagnosticId
                ? "（错误编号：" + diagnostic.diagnosticId + "）"
                : ""),
          ),
          {
            code: "directory_operation_failed",
            ...(diagnostic?.diagnosticId
              ? { diagnosticId: diagnostic.diagnosticId }
              : {}),
          },
        );
      }
    });
  ipcMain.handle(
    "directories:list",
    guarded("read", async () => ({ ...locations })),
  );
  ipcMain.handle(
    "directories:open",
    guarded("open", async (kind) => {
      const dir = mapped(kind);
      await fs.mkdir(dir, { recursive: true });
      const error = await shell.openPath(dir);
      if (error) throw Error("Directory open failed");
      return { opened: true, kind };
    }),
  );
  ipcMain.handle(
    "directories:copy",
    guarded("copy", async (kind) => {
      clipboard.writeText(mapped(kind));
      return { copied: true, kind };
    }),
  );
}
