import { createHash } from "node:crypto";
import { assertScope, packageError } from "../../domain/packages.mjs";
import { assertOperationWriteAllowed } from "../../application/workspace-operations.mjs";
import { rowKey } from "../storage/sqlite-records.mjs";
import {
  collectionRoot,
  collectionToken,
  collectionLease,
  leaseSelector,
  rowSelector,
} from "../../application/collection-row-access.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const keyFor = (value) => {
  if (typeof value !== "string" || !value.length || value.length > 16384)
    throw packageError("collection_cache_invalid", "缓存资源标识无效。", 400);
  return hash(value);
};
const headerValue = (value, max = 1024) => {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value))
    throw packageError("collection_cache_invalid", "条件响应字段无效。", 400);
  return value;
};
export function createConditionalCache({
  repository,
  clock = repository.clock,
  maxEntries = 1000,
}) {
  function writeGuard(w, scope, operationLease, ref, token) {
    assertOperationWriteAllowed(w, { operationLease });
    const lease = w.operationLeases?.[operationLease?.operationId];
    if (
      !lease ||
      lease.token !== operationLease.token ||
      lease.scope?.packageId !== scope.packageId ||
      lease.scope?.targetRevisionId !== scope.targetRevisionId
    )
      throw packageError("invalid_operation_lease", "采集缓存操作授权已失效。");
    if (ref) {
      const root = w.runs[ref.activityId],
        p = root?.collectionProgress;
      if (
        root?.ownerPackageId !== scope.packageId ||
        root?.targetSnapshot.revisionId !== scope.targetRevisionId ||
        !token ||
        p?.epoch !== token.epoch ||
        p.activeSliceRunId !== token.sliceRunId ||
        p.status !== "collecting"
      )
        throw packageError(
          "collection_stale_epoch",
          "活动已停止，不能更新采集缓存。",
        );
    }
  }
  const cache = {
    async get({ scope, resourceKey }) {
      if (
        repository.getMeta &&
        (await repository.getMeta("schemaVersion")) === 3
      )
        return repository.getRow(
          {
            collection: "conditionalCache",
            id: rowKey(scope.packageId, "collectionCache", keyFor(resourceKey)),
            ownerPackageId: scope.packageId,
          },
          { scope },
        );
      const w = await repository.read(),
        p = assertScope(w, scope, clock.now());
      return structuredClone(p.collectionCache?.[keyFor(resourceKey)] || null);
    },
    async put({
      scope,
      resourceKey,
      etag = null,
      lastModified = null,
      bodyHash,
      parsedEvidence,
      checkedAt = new Date(clock.now()).toISOString(),
      parserVersion = "v1",
      evidenceCheckedAt = checkedAt,
      operationLease,
      ref,
      token,
    }) {
      if (
        typeof bodyHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(bodyHash) ||
        !Number.isFinite(Date.parse(checkedAt)) ||
        typeof parserVersion !== "string" ||
        parserVersion.length > 160
      )
        throw packageError(
          "collection_cache_invalid",
          "缓存正文身份或时间无效。",
          400,
        );
      const encoded = JSON.stringify(parsedEvidence);
      if (!encoded || Buffer.byteLength(encoded) > 1024 * 1024)
        throw packageError(
          "collection_cache_invalid",
          "缓存解析结果超限。",
          400,
        );
      const entry = {
        etag: headerValue(etag),
        lastModified: headerValue(lastModified, 256),
        bodyHash,
        parsedEvidence: JSON.parse(encoded),
        checkedAt,
        parserVersion,
        evidenceCheckedAt,
      };
      const id = keyFor(resourceKey);
      if (
        repository.getMeta &&
        (await repository.getMeta("schemaVersion")) === 3
      ) {
        const rowId = rowKey(scope.packageId, "collectionCache", id);
        await repository.transaction(
          {
            select: [
              rowSelector("conditionalCache", scope, [rowId]),
              {
                collection: "conditionalCache",
                ownerPackageId: scope.packageId,
                where: { parentId: scope.packageId, path: "collectionCache" },
                orderBy: "checkedAt",
                direction: "asc",
                limit: 1,
                total: true,
              },
              leaseSelector(operationLease),
              ...(ref ? [rowSelector("runs", scope, [ref.activityId])] : []),
            ],
          },
          (tx) => {
            collectionLease(tx.view, scope, operationLease);
            if (ref)
              collectionToken(
                collectionRoot(tx.view, ref).collectionProgress,
                token,
              );
            const current = tx.getRow({
                collection: "conditionalCache",
                id: rowId,
              }),
              page = tx.view.pageInfo[1];
            if (!current && page.total >= maxEntries) {
              const oldest = Object.keys(
                tx.view.rows.conditionalCache || {},
              ).find((key) => key !== rowId);
              if (oldest)
                tx.deleteRow({ collection: "conditionalCache", id: oldest });
            }
            tx.putRow({
              collection: "conditionalCache",
              id: rowId,
              ownerPackageId: scope.packageId,
              parent: {
                collection: "packages",
                id: scope.packageId,
                path: "collectionCache",
              },
              targetRevisionId: scope.targetRevisionId,
              value: entry,
            });
          },
          { scope, operationLease },
        );
        return structuredClone(entry);
      }
      await repository.mutateWorkspace(
        (w) => {
          const p = assertScope(w, scope, clock.now());
          writeGuard(w, scope, operationLease, ref, token);
          p.collectionCache ||= {};
          if (
            !p.collectionCache[id] &&
            Object.keys(p.collectionCache).length >= maxEntries
          ) {
            const oldest = Object.keys(p.collectionCache).sort(
              (a, b) =>
                Date.parse(p.collectionCache[a].checkedAt) -
                Date.parse(p.collectionCache[b].checkedAt),
            )[0];
            delete p.collectionCache[oldest];
          }
          p.collectionCache[id] = entry;
        },
        { operationLease },
      );
      return structuredClone(entry);
    },
    async read(input) {
      const {
        scope,
        resourceKey,
        parserVersion = "v1",
        request,
        url,
        parse,
      } = input;
      const method = String(
        input.requestOptions?.method || "GET",
      ).toUpperCase();
      const identity = new URL(url);
      if (
        method !== "GET" ||
        input.requestOptions?.body !== undefined ||
        identity.username ||
        identity.password ||
        Object.keys(input.requestOptions?.headers || {}).some((name) =>
          /^(authorization|cookie)$/i.test(name),
        )
      )
        throw packageError(
          "collection_cache_invalid",
          "条件缓存只允许无请求体的安全GET。",
          400,
        );
      const previous = await cache.get({ scope, resourceKey }),
        matching =
          previous?.parserVersion === parserVersion &&
          (typeof input.canReuseEvidence !== "function" ||
            (await input.canReuseEvidence(previous.parsedEvidence)) !== false);
      const headers = {};
      if (matching && previous.etag) headers["If-None-Match"] = previous.etag;
      if (matching && previous.lastModified)
        headers["If-Modified-Since"] = previous.lastModified;
      const response = await request(url, {
        ...input.requestOptions,
        headers: { ...input.requestOptions?.headers, ...headers },
      });
      const checkedAt = new Date(clock.now()).toISOString();
      if (response.status === 304) {
        if (!matching || previous.parsedEvidence == null)
          return { status: 304, needsBody: true, reused: false, checkedAt };
        await cache.put({ ...input, ...previous, checkedAt });
        return {
          status: 304,
          evidence: structuredClone(previous.parsedEvidence),
          bodyHash: previous.bodyHash,
          reused: true,
          needsBody: false,
          checkedAt,
          evidenceCheckedAt: previous.evidenceCheckedAt || previous.checkedAt,
        };
      }
      if (response.status !== 200)
        return {
          status: response.status,
          needsBody: true,
          reused: false,
          checkedAt,
        };
      const bodyHash = hash(
        response.bytes instanceof Uint8Array
          ? response.bytes
          : response.text || "",
      );
      const reused =
        matching &&
        previous.bodyHash === bodyHash &&
        previous.parsedEvidence != null;
      const evidence = reused
        ? structuredClone(previous.parsedEvidence)
        : await parse(response);
      if (evidence == null)
        return {
          status: 200,
          needsBody: true,
          reused: false,
          bodyHash,
          checkedAt,
        };
      await cache.put({
        ...input,
        bodyHash,
        parsedEvidence: evidence,
        checkedAt,
        etag: response.headers?.etag,
        lastModified: response.headers?.["last-modified"],
        parserVersion,
        evidenceCheckedAt: reused
          ? previous.evidenceCheckedAt || previous.checkedAt
          : checkedAt,
      });
      return {
        status: 200,
        evidence,
        bodyHash,
        reused,
        needsBody: false,
        checkedAt,
        evidenceCheckedAt: reused
          ? previous.evidenceCheckedAt || previous.checkedAt
          : checkedAt,
      };
    },
  };
  return cache;
}
