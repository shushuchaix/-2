import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function writeAtomicJson(
  filename,
  value,
  { fsAdapter = fs } = {},
) {
  const temp = filename + "." + randomUUID() + ".tmp";
  let handle,
    failure,
    phase = "mkdir";
  try {
    await fsAdapter.mkdir(path.dirname(filename), { recursive: true });
    phase = "open";
    handle = await fsAdapter.open(temp, "wx");
    phase = "write";
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    phase = "sync";
    await handle.sync();
    phase = "close";
    await handle.close();
    handle = null;
    phase = "rename";
    await fsAdapter.rename(temp, filename);
  } catch (error) {
    failure = error;
    error.storageOperation ||= "atomic." + phase;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsAdapter.unlink(temp).catch((e) => {
      if (e.code !== "ENOENT" && !failure) {
        e.storageOperation ||= "atomic.cleanup";
        throw e;
      }
    });
  }
}
