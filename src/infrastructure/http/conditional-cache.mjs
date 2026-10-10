import { createHash } from "node:crypto";
import { assertScope, packageError } from "../../domain/packages.mjs";
import { assertOperationWriteAllowed } from "../../application/workspace-operations.mjs";
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
      };
      const id = keyFor(resourceKey);
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
      const previous = await cache.get({ scope, resourceKey }),
        matching = previous?.parserVersion === parserVersion;
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
      });
      return {
        status: 200,
        evidence,
        bodyHash,
        reused,
        needsBody: false,
        checkedAt,
      };
    },
  };
  return cache;
}
