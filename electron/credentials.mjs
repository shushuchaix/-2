import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomicJson } from "../src/infrastructure/storage/atomic.mjs";
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
      if (
        typeof key !== "string" ||
        key.length < 16 ||
        key.length > 512 ||
        /[\r\n]/.test(key)
      )
        throw Error("Invalid credential length");
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
export function registerCredentialIpc({
  ipcMain,
  service,
  getWindow,
  getOrigin,
  onKey,
}) {
  const guarded =
    (fn) =>
    async (event, ...args) => {
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
  ipcMain.handle(
    "credentials:available",
    guarded(() => service.available()),
  );
  ipcMain.handle(
    "credentials:status",
    guarded((p) => service.status(p)),
  );
  ipcMain.handle(
    "credentials:save",
    guarded(async (p, key) => {
      const result = await service.save(p, key);
      onKey(key);
      return result;
    }),
  );
  ipcMain.handle(
    "credentials:delete",
    guarded(async (p) => {
      const result = await service.delete(p);
      onKey("");
      return result;
    }),
  );
}
