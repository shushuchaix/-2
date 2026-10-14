import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
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
  clock = { now: Date.now },
}) {
  const dir = path.join(dataDir, "collection-sessions"),
    filename = path.join(dir, "sessions.json"),
    intentFile = path.join(dir, "cleanup.json"),
    riskFile = path.join(dir, "risk-stops.json"),
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
  async function loadRisks() {
    try {
      const value = JSON.parse(await fsAdapter.readFile(riskFile, "utf8"));
      if (
        value.version !== 1 ||
        !value.entries ||
        Object.keys(value.entries).length > 500
      )
        throw Error("Risk store invalid");
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
  const sameBossVersion = (entry, owner) =>
    entry.platform === "boss" &&
    entry.packageId === owner.packageId &&
    entry.targetRevisionId === owner.targetRevisionId;
  const bossRisks = (data, owner) =>
    Object.values(data.entries).filter(
      (e) => sameBossVersion(e, owner) && e.risk,
    );
  const bossRiskStamp = (data, owner) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          bossRisks(data, owner)
            .map((e) => [
              e.sessionRef,
              e.risk.code,
              e.risk.checkedAt,
              e.risk.generation || "legacy",
            ])
            .sort((a, b) => a[0].localeCompare(b[0])),
        ),
      )
      .digest("hex");
  const encryptedEntry = (entry, material) => ({
    sessionRef: entry.sessionRef,
    packageId: entry.packageId,
    targetRevisionId: entry.targetRevisionId,
    platform: entry.platform,
    accountRef: entry.accountRef,
    state: entry.state,
    encrypted: safeStorage
      .encryptString(JSON.stringify(material))
      .toString("base64"),
  });
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
        const risks = await loadRisks();
        for (const [id, e] of Object.entries(risks.entries))
          if (matches(e, intent) && !intent.keepRisk) delete risks.entries[id];
        await writeAtomicJson(riskFile, risks, { fsAdapter });
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
    async create({
      scope,
      platform,
      accountRef,
      remember,
      sessionRef: preferredRef,
    }) {
      if (
        !["wechat", "weibo", "boss"].includes(platform) ||
        !scope?.packageId ||
        !scope?.targetRevisionId ||
        typeof accountRef !== "string" ||
        accountRef.length > 200 ||
        (remember !== undefined && typeof remember !== "boolean") ||
        (preferredRef !== undefined &&
          (typeof preferredRef !== "string" || preferredRef.length > 200))
      )
        throw fail();
      if (platform === "boss") {
        const persisted = (await load()).entries;
        const riskEntries = (await loadRisks()).entries;
        let preferred =
          memory.get(preferredRef) ||
          persisted[preferredRef] ||
          riskEntries[preferredRef];
        if (preferred) {
          if (
            !sameBossVersion(preferred, scope) ||
            (preferred.accountRef !== undefined &&
              preferred.accountRef !== accountRef)
          )
            throw fail();
          if (revoked.has(preferredRef)) preferred = null;
          else owned(preferred, scope);
        }
        const candidates = [...memory.values(), ...Object.values(persisted)];
        const selected =
          preferred ||
          candidates.find(
            (e) =>
              !revoked.has(e.sessionRef) &&
              e.status !== "cleanup_pending" &&
              sameBossVersion(e, scope) &&
              e.accountRef === accountRef,
          );
        if (selected) {
          const entry = await service.get({
            scope,
            sessionRef: selected.sessionRef,
          });
          memory.get(entry.sessionRef).accountRef = accountRef;
          if (
            remember !== undefined &&
            entry.remember !== (remember && available())
          ) {
            const material = available()
              ? await service.readMaterial({
                  scope,
                  sessionRef: entry.sessionRef,
                })
              : memory.get(entry.sessionRef).material || { cookies: [] };
            const desired = remember && available();
            await withWorkspaceLock(dir, async () => {
              owned(memory.get(entry.sessionRef), scope);
              if ((await intents()).entries.some((i) => matches(entry, i)))
                throw fail();
              const data = await load();
              if (desired)
                data.entries[entry.sessionRef] = encryptedEntry(
                  entry,
                  material,
                );
              else delete data.entries[entry.sessionRef];
              await writeAtomicJson(filename, data, { fsAdapter });
              memory.get(entry.sessionRef).remember = desired;
              memory.get(entry.sessionRef).material = material;
            });
          }
          return {
            ...(await service.get({ scope, sessionRef: entry.sessionRef })),
            reused: true,
          };
        }
        if (
          (await intents()).entries.some((i) => i.packageId === scope.packageId)
        )
          throw fail();
      }
      const sessionRef = "session-" + randomUUID(),
        entry = {
          sessionRef,
          packageId: scope.packageId,
          targetRevisionId: scope.targetRevisionId,
          platform,
          accountRef,
          partition: "collection-" + randomUUID(),
          remember: Boolean(remember && available()),
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
        const stored = owned(
          (await load()).entries[sessionRef] ||
            (await loadRisks()).entries[sessionRef],
          scope,
        );
        entry = {
          ...stored,
          partition: "collection-" + randomUUID(),
          remember: Boolean(stored.encrypted),
        };
        delete entry.encrypted;
        memory.set(sessionRef, entry);
      }
      const risks = await loadRisks();
      const risk =
        entry.platform === "boss"
          ? bossRisks(risks, entry).sort(
              (a, b) =>
                Date.parse(b.risk.checkedAt) - Date.parse(a.risk.checkedAt),
            )[0]?.risk
          : risks.entries[sessionRef]?.risk;
      entry.risk = risk || null;
      if (entry.platform === "boss")
        entry.riskStamp = bossRiskStamp(risks, entry);
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
        data.entries[sessionRef] = encryptedEntry(entry, entry.material);
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
    async getStatus({ scope, sessionRef }) {
      const entry = await service.get({ scope, sessionRef });
      return {
        state: entry.state,
        riskBlocked: Boolean(entry.risk),
        remembered: Boolean(entry.remember),
        ...(entry.risk
          ? { code: entry.risk.code, checkedAt: entry.risk.checkedAt }
          : {}),
      };
    },
    async setRisk({ scope, sessionRef, code, checkedAt }) {
      const entry = await service.get({ scope, sessionRef });
      if (
        entry.platform !== "boss" ||
        !["boss_account_risk", "boss_environment_risk"].includes(code) ||
        !Number.isFinite(Date.parse(checkedAt))
      )
        throw Object.assign(Error("风险状态无效。"), {
          code: "boss_risk_invalid",
        });
      await withWorkspaceLock(dir, async () => {
        owned(memory.get(sessionRef), scope);
        if ((await intents()).entries.some((i) => matches(entry, i)))
          throw fail();
        const risks = await loadRisks();
        risks.entries[sessionRef] = {
          sessionRef,
          packageId: entry.packageId,
          targetRevisionId: entry.targetRevisionId,
          platform: "boss",
          state: entry.state,
          risk: { code, checkedAt, generation: randomUUID() },
        };
        await writeAtomicJson(riskFile, risks, { fsAdapter });
        memory.get(sessionRef).risk = { code, checkedAt };
      });
      return service.getStatus({ scope, sessionRef });
    },
    async clearRisk({ scope, sessionRef, verification }) {
      const entry = await service.get({ scope, sessionRef }),
        time = Date.parse(verification?.checkedAt),
        now = clock.now();
      if (
        entry.platform !== "boss" ||
        verification?.status !== "success" ||
        verification?.sessionRef !== sessionRef ||
        verification?.expectedRiskStamp !== entry.riskStamp ||
        !Number.isFinite(time) ||
        time > now + 5000 ||
        now - time > 300000 ||
        (entry.risk && time < Date.parse(entry.risk.checkedAt))
      )
        throw Object.assign(Error("请明确解除风险并重新核验当前会话。"), {
          code: "boss_risk_recovery_required",
          retryable: false,
        });
      await withWorkspaceLock(dir, async () => {
        owned(memory.get(sessionRef), scope);
        if ((await intents()).entries.some((i) => matches(entry, i)))
          throw fail();
        const risks = await loadRisks();
        const current = bossRisks(risks, entry);
        if (
          verification.expectedRiskStamp !== bossRiskStamp(risks, entry) ||
          current.some((e) => time < Date.parse(e.risk.checkedAt))
        )
          throw Object.assign(Error("风险发生后需要新的核验。"), {
            code: "boss_risk_recovery_required",
          });
        for (const e of current) delete risks.entries[e.sessionRef];
        await writeAtomicJson(riskFile, risks, { fsAdapter });
        memory.get(sessionRef).risk = null;
      });
      return service.getStatus({ scope, sessionRef });
    },
    async cleanupPackage(packageId) {
      return cleanup({ packageId });
    },
    async clear({ scope, sessionRef }) {
      const entry = await service.get({ scope, sessionRef });
      const result = await cleanup({
        packageId: scope.packageId,
        sessionRef,
        ...(entry.platform === "boss" ? { keepRisk: true } : {}),
      });
      return {
        ...result,
        ...(entry.platform === "boss"
          ? { riskBlocked: bossRisks(await loadRisks(), entry).length > 0 }
          : {}),
      };
    },
    async resumePending() {
      const pending = (await intents()).entries;
      for (const intent of pending) await cleanup(intent);
      return { pending };
    },
  };
  return service;
}
