import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "../helpers/fixtures.mjs";
import {
  createCredentialService,
  registerCredentialIpc,
} from "../../electron/credentials.mjs";
test("desktop encrypted credentials never return plaintext to renderer", async (t) => {
  const dataDir = await createTempDir(t),
    safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (key) => Buffer.from("encrypted:" + key).reverse(),
      decryptString: (bytes) =>
        Buffer.from(bytes).reverse().toString().slice(10),
    },
    service = createCredentialService({ dataDir, safeStorage });
  let changes = "";
  const handlers = new Map(),
    frame = { url: "http://127.0.0.1:3000/" },
    contents = { mainFrame: frame };
  registerCredentialIpc({
    ipcMain: { handle: (k, v) => handlers.set(k, v) },
    service,
    getWindow: () => ({ webContents: contents }),
    getOrigin: () => frame.url,
    onKey: (key) => (changes = key),
  });
  const event = { sender: contents, senderFrame: frame };
  const result = await handlers.get("credentials:save")(
    event,
    "deepseek",
    "sk-synthetic-desktop-key",
  );
  assert.deepEqual(result, { configured: true });
  assert.equal(changes, "sk-synthetic-desktop-key");
  const disk = await fs.readFile(
    path.join(dataDir, "credentials.v2.json"),
    "utf8",
  );
  assert.ok(!disk.includes("sk-synthetic"));
  const status = await handlers.get("credentials:status")(event, "deepseek");
  assert.deepEqual(status, { configured: true, encryptionAvailable: true });
  await assert.rejects(
    handlers.get("credentials:save")(
      { ...event, senderFrame: { url: "https://evil.example/" } },
      "deepseek",
      "sk-synthetic-desktop-key",
    ),
    /sender/,
  );
  await assert.rejects(service.save("other", "abc"), /provider/);
  await handlers.get("credentials:delete")(event, "deepseek");
  assert.equal(changes, "");
});
test("unavailable OS encryption cannot fall back to plaintext", async (t) => {
  const service = createCredentialService({
    dataDir: await createTempDir(t),
    safeStorage: { isEncryptionAvailable: () => false },
  });
  await assert.rejects(
    service.save("deepseek", "sk-synthetic-desktop-key"),
    /encryption/,
  );
});
