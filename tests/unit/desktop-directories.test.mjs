import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempDir } from "../helpers/fixtures.mjs";
import { apiFixture } from "../helpers/api-fixture.mjs";
test("public HTTP has no private data path endpoint or session field", async (t) => {
  const f = await apiFixture(t);
  assert.equal(
    (await f.call("/api/v2/workspace/locations")).response.status,
    404,
  );
  const session = await f.call("/api/session");
  assert.equal(Object.hasOwn(session.data, "dataDir"), false);
});
test("directory IPC maps only fixed categories and rejects other windows, frames and renderer paths", async (t) => {
  const { registerDirectoryIpc } = await import(
      "../../electron/directories.mjs"
    ),
    { resolveDataLayout } = await import(
      "../../src/infrastructure/storage/layout.mjs"
    );
  const root = await createTempDir(t),
    handlers = new Map(),
    frame = { url: "http://127.0.0.1:1234/" },
    contents = { mainFrame: frame },
    event = { sender: contents, senderFrame: frame },
    opened = [],
    copied = [];
  registerDirectoryIpc({
    ipcMain: { handle: (k, v) => handlers.set(k, v) },
    getWindow: () => ({ webContents: contents }),
    getOrigin: () => frame.url,
    layout: resolveDataLayout(root),
    shell: {
      openPath: async (p) => {
        opened.push(p);
        return "";
      },
    },
    clipboard: { writeText: (p) => copied.push(p) },
  });
  const locations = await handlers.get("directories:list")(event);
  assert.equal(locations.history, path.join(root, "runs-v2"));
  await handlers.get("directories:open")(event, "history");
  assert.deepEqual(opened, [locations.history]);
  await handlers.get("directories:copy")(event, "data");
  assert.deepEqual(copied, [root]);
  for (const arg of ["../", "C:/private", "constructor", {}, null])
    await assert.rejects(handlers.get("directories:open")(event, arg));
  await assert.rejects(
    handlers.get("directories:list")({ ...event, sender: {} }),
  );
  await assert.rejects(
    handlers.get("directories:list")({ ...event, senderFrame: { ...frame } }),
  );
  frame.url = "http://127.0.0.1:1234/jobs";
  await assert.rejects(handlers.get("directories:list")(event));
});
test("shell errors never return success or private paths in error messages", async (t) => {
  const { registerDirectoryIpc } = await import(
      "../../electron/directories.mjs"
    ),
    { resolveDataLayout } = await import(
      "../../src/infrastructure/storage/layout.mjs"
    );
  const handlers = new Map(),
    frame = { url: "http://127.0.0.1:1234/" },
    contents = { mainFrame: frame };
  registerDirectoryIpc({
    ipcMain: { handle: (k, v) => handlers.set(k, v) },
    getWindow: () => ({ webContents: contents }),
    getOrigin: () => frame.url,
    layout: resolveDataLayout(await createTempDir(t)),
    shell: { openPath: async () => "C:/private permission denied" },
    clipboard: {
      writeText() {
        throw Error("C:/private");
      },
    },
  });
  await assert.rejects(
    handlers.get("directories:open")(
      { sender: contents, senderFrame: frame },
      "data",
    ),
    (e) => /打开|权限/.test(e.message) && !e.message.includes("C:/private"),
  );
});
