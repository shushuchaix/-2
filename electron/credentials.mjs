import fs from "node:fs/promises";
import { assertInput } from "../public/js/validation-rules.js";
import path from "node:path";
import { writeAtomicJson } from "../src/infrastructure/storage/atomic.mjs";
import { recordDiagnostic } from "../src/infrastructure/diagnostics/log.mjs";
export function createCredentialService({ dataDir, safeStorage }) {
  const filename = path.join(dataDir, "credentials.v2.json"),
    validate = (provider) => {
      if (provider !== "deepseek") throw Error("Invalid credential provider");
    };
  const available = () =>
    safeStorage.isEncryptionAvailable() &&
    safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(filename, "utf8"));
      if (data.version !== 1 || !data.values || typeof data.values !== "object")
        throw Error("Invalid encrypted credential file");
      return data;
    } catch (e) {
      if (e.code === "ENOENT") return { version: 1, values: {} };
      throw e;
    }
  }
  let queue = Promise.resolve();
  const mutate = (action) => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  return {
    available,
    async save(provider, key) {
      validate(provider);
      assertInput("key", { userApiKey: key }, { required: true });
      if (!available()) throw Error("OS encryption unavailable");
      return mutate(async () => {
        const data = await read();
        data.values[provider] = safeStorage
          .encryptString(key)
          .toString("base64");
        await writeAtomicJson(filename, data);
        return { configured: true };
      });
    },
    async delete(provider) {
      validate(provider);
      return mutate(async () => {
        const data = await read();
        delete data.values[provider];
        await writeAtomicJson(filename, data);
        return { configured: false };
      });
    },
    async status(provider) {
      validate(provider);
      return {
        configured: !!(await read()).values[provider],
        encryptionAvailable: available(),
      };
    },
    async readForModel(provider) {
      validate(provider);
      const encrypted = (await read()).values[provider];
      if (!encrypted) return "";
      if (!available()) throw Error("OS encryption unavailable");
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    },
  };
}
export function guardDesktopSender({ getWindow, getOrigin }, fn) {
  return async (event, ...args) => {
    const win = getWindow();
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      throw Error("Invalid credential sender");
    let url;
    try {
      url = new URL(event.senderFrame.url);
    } catch {
      throw Error("Invalid credential sender");
    }
    if (url.origin !== new URL(getOrigin()).origin || url.pathname !== "/")
      throw Error("Invalid credential sender");
    return fn(...args);
  };
}

export function registerCredentialIpc({
  ipcMain,
  service,
  diagnostics,
  getWindow,
  getOrigin,
  onKey,
}) {
  const guarded = (code, fn) =>
    guardDesktopSender({ getWindow, getOrigin }, async (...args) => {
      const started = Date.now();
      try {
        const result = await fn(...args);
        await recordDiagnostic(diagnostics, {
          operation: "desktop.credentials",
          phase:
            code === "credential_save" || code === "credential_delete"
              ? "mutation"
              : "read",
          outcome: "success",
          code,
          durationMs: Date.now() - started,
        });
        return result;
      } catch (error) {
        const diagnostic = await recordDiagnostic(
          diagnostics,
          {
            operation: "desktop.credentials",
            phase:
              code === "credential_save" || code === "credential_delete"
                ? "mutation"
                : "read",
            outcome: "failed",
            code,
            durationMs: Date.now() - started,
          },
          error,
        );
        throw Object.assign(
          Error(
            "桌面密钥操作失败，请检查系统加密和目录权限后重试。" +
              (diagnostic?.diagnosticId
                ? "（错误编号：" + diagnostic.diagnosticId + "）"
                : ""),
          ),
          {
            code: "credential_operation_failed",
            ...(diagnostic?.diagnosticId
              ? { diagnosticId: diagnostic.diagnosticId }
              : {}),
          },
        );
      }
    });
  ipcMain.handle(
    "credentials:available",
    guarded("credential_available", () => service.available()),
  );
  ipcMain.handle(
    "credentials:status",
    guarded("credential_status", (p) => service.status(p)),
  );
  ipcMain.handle(
    "credentials:save",
    guarded("credential_save", async (p, key) => {
      const result = await service.save(p, key);
      onKey(key);
      return result;
    }),
  );
  ipcMain.handle(
    "credentials:delete",
    guarded("credential_delete", async (p) => {
      const result = await service.delete(p);
      onKey("");
      return result;
    }),
  );
}
