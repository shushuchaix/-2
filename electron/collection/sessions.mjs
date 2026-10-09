import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withWorkspaceLock } from "../../src/infrastructure/storage/lock.mjs";
import { writeAtomicJson } from "../../src/infrastructure/storage/atomic.mjs";
const fail = () =>
  Object.assign(Error("采集会话不属于当前目标版本。"), {
    code: "collection_session_scope",
  });
export function createCollectionSessions({
  dataDir,
  safeStorage,
  fsAdapter = fs,
}) {
  const dir = path.join(dataDir, "collection-sessions"),
    filename = path.join(dir, "sessions.json"),
    intentFile = path.join(dir, "cleanup.json"),
    memory = new Map(),
    revoked = new Set();
  const available = () =>
    Boolean(
      safeStorage?.isEncryptionAvailable() &&
        safeStorage.getSelectedStorageBackend?.() !== "basic_text",
    );
  async function load() {
    try {
      const value = JSON.parse(await fsAdapter.readFile(filename, "utf8"));
      if (
        value.version !== 1 ||
        !value.entries ||
        Object.keys(value.entries).length > 500
      )
        throw Error("Session store invalid");
      return value;
    } catch (e) {
      if (e.code === "ENOENT") return { version: 1, entries: {} };
      throw e;
    }
  }
  function owned(item, scope) {
    if (
      !item ||
      revoked.has(item.sessionRef) ||
      item.packageId !== scope?.packageId ||
      item.targetRevisionId !== scope?.targetRevisionId ||
      item.status === "cleanup_pending"
    )
      throw fail();
    return item;
  }
  async function intents() {
    try {
      const value = JSON.parse(await fsAdapter.readFile(intentFile, "utf8"));
      if (
        value.version !== 1 ||
        !Array.isArray(value.entries) ||
        value.entries.length > 1000
      )
        throw Error("Session cleanup invalid");
      return value;
    } catch (e) {
      if (e.code === "ENOENT") return { version: 1, entries: [] };
      throw e;
    }
  }
  const matches = (entry, intent) =>
    entry.packageId === intent.packageId &&
    (!intent.sessionRef || entry.sessionRef === intent.sessionRef);
  async function cleanup(intent) {
    for (const [id, e] of memory)
      if (matches(e, intent)) {
        revoked.add(id);
        memory.delete(id);
      }
    try {
      await withWorkspaceLock(dir, async () => {
        const pending = await intents();
        if (
          !pending.entries.some(
            (e) =>
              e.packageId === intent.packageId &&
              e.sessionRef === intent.sessionRef,
          )
        )
          pending.entries.push(intent);
        await writeAtomicJson(intentFile, pending, { fsAdapter });
        const data = await load();
        for (const [id, e] of Object.entries(data.entries))
          if (matches(e, intent)) delete data.entries[id];
        await writeAtomicJson(filename, data, { fsAdapter });
        pending.entries = pending.entries.filter(
          (e) =>
            !(
              e.packageId === intent.packageId &&
              e.sessionRef === intent.sessionRef
            ),
        );
        await writeAtomicJson(intentFile, pending, { fsAdapter });
      });
      return { status: "clean" };
    } catch {
      return { status: "cleanup_pending" };
    }
  }
  const service = {
    available,
    async create({ scope, platform, accountRef, remember = false }) {
      if (
        !["wechat", "weibo"].includes(platform) ||
        !scope?.packageId ||
        !scope?.targetRevisionId ||
        typeof accountRef !== "string" ||
        accountRef.length > 200 ||
        typeof remember !== "boolean"
      )
        throw fail();
      const sessionRef = "session-" + randomUUID(),
        entry = {
          sessionRef,
          packageId: scope.packageId,
          targetRevisionId: scope.targetRevisionId,
          platform,
          accountRef,
          partition: "collection-" + randomUUID(),
          remember: remember && available(),
          state: "unverified",
        };
      memory.set(sessionRef, entry);
      return { ...entry };
    },
    async get({ scope, sessionRef }) {
      if (
        (await intents()).entries.some(
          (i) =>
            i.packageId === scope?.packageId &&
            (!i.sessionRef || i.sessionRef === sessionRef),
        )
      )
        throw fail();
      let entry = memory.get(sessionRef);
      if (!entry) {
        const stored = owned((await load()).entries[sessionRef], scope);
        entry = {
          ...stored,
          partition: "collection-" + randomUUID(),
          remember: true,
        };
        memory.set(sessionRef, entry);
      }
      return { ...owned(entry, scope) };
    },
    async saveMaterial({ scope, sessionRef, cookies = [] }) {
      const entry = owned(memory.get(sessionRef), scope);
      if (
        !Array.isArray(cookies) ||
        cookies.length > 200 ||
        Buffer.byteLength(JSON.stringify(cookies)) > 262144
      )
        throw Error("Session material limit");
      entry.material = { cookies: structuredClone(cookies) };
      if (!entry.remember || !available()) return { persisted: false };
      await withWorkspaceLock(dir, async () => {
        owned(memory.get(sessionRef), scope);
        if ((await intents()).entries.some((i) => matches(entry, i)))
          throw fail();
        const data = await load();
        data.entries[sessionRef] = {
          sessionRef,
          packageId: entry.packageId,
          targetRevisionId: entry.targetRevisionId,
          platform: entry.platform,
          accountRef: entry.accountRef,
          state: entry.state,
          encrypted: safeStorage
            .encryptString(JSON.stringify(entry.material))
            .toString("base64"),
        };
        await writeAtomicJson(filename, data, { fsAdapter });
      });
      return { persisted: true };
    },
    async readMaterial({ scope, sessionRef }) {
      const entry = await service.get({ scope, sessionRef });
      if (memory.get(sessionRef).material)
        return structuredClone(memory.get(sessionRef).material);
      const stored = (await load()).entries[sessionRef];
      if (!stored?.encrypted) return { cookies: [] };
      if (!available())
        throw Object.assign(Error("OS encryption unavailable"), {
          code: "collection_encryption_unavailable",
        });
      const value = JSON.parse(
        safeStorage.decryptString(Buffer.from(stored.encrypted, "base64")),
      );
      if (!Array.isArray(value.cookies) || value.cookies.length > 200)
        throw Error("Session material invalid");
      return value;
    },
    async setState({ scope, sessionRef, state }) {
      if (!["unverified", "verified", "expired"].includes(state))
        throw Error("Invalid session state");
      const entry = owned(memory.get(sessionRef), scope);
      entry.state = state;
    },
    async cleanupPackage(packageId) {
      return cleanup({ packageId });
    },
    async clear({ scope, sessionRef }) {
      await service.get({ scope, sessionRef });
      return cleanup({ packageId: scope.packageId, sessionRef });
    },
    async resumePending() {
      const pending = (await intents()).entries;
      for (const intent of pending) await cleanup(intent);
      return { pending };
    },
  };
  return service;
}
