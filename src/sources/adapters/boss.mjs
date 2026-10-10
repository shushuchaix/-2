import { createPagedProvider } from "./shared.mjs";
import { buildBossOperation, parseBossResponse } from "../boss/protocol.mjs";
import { mapBossJob } from "../boss/records.mjs";
import { bossCityCode } from "../boss/cities.mjs";

const fail = (code, retryable = false) =>
  Object.assign(Error("Boss 读取未完成：" + code), { code, retryable });
const authCodes = new Set([
  "boss_account_risk",
  "boss_environment_risk",
  "boss_risk_blocked",
  "boss_auth_expired",
  "boss_login_required",
]);
export function createBossProvider() {
  const readRefs = new Map();
  const identity = (ctx, id) =>
    JSON.stringify([
      ctx.scope?.packageId,
      ctx.scope?.targetRevisionId,
      ctx.sessionRefs?.boss,
      ctx.ref?.activityId,
      ctx.token?.epoch,
      ctx.token?.sliceRunId,
      id,
    ]);
  async function read(ctx, operation) {
    ctx.signal?.throwIfAborted();
    if (!ctx.sessionRefs?.boss) throw fail("boss_login_required");
    if (!ctx.readService?.readBoss || !ctx.ref || !ctx.token || !ctx.scope)
      throw fail("collection_probe_unavailable");
    const response = await ctx.readService.readBoss({
      ...ctx,
      ref: { ...ctx.ref, scope: ctx.scope },
      sessionRef: ctx.sessionRefs.boss,
      operation,
    });
    ctx.signal?.throwIfAborted();
    const parsed = parseBossResponse({
      ...response,
      kind: operation.kind,
      checkedAt:
        response.checkedAt ||
        new Date(ctx.clock?.now?.() || Date.now()).toISOString(),
    });
    if (parsed.status !== "success")
      throw fail(parsed.code, parsed.status === "rate_limited");
    return parsed;
  }
  async function listPage(site, query, page, ctx) {
    const result = await read(
      ctx,
      buildBossOperation({
        kind: "boss.search",
        query: query.keyword,
        city: bossCityCode(query.city),
        page,
      }),
    );
    const records = [],
      issues = [];
    for (const raw of result.records) {
      try {
        const mapped = mapBossJob(raw, { site, checkedAt: result.checkedAt });
        if (mapped.readRef)
          readRefs.set(
            identity(ctx, mapped.record.sourceRecordId),
            mapped.readRef,
          );
        records.push({ ...mapped.record, discoveryPage: page });
      } catch (error) {
        issues.push({
          code: error.code || "boss_record_invalid",
          retryable: false,
        });
      }
    }
    // Only in-flight references are retained. A later page or restarted activity can reread its original page.
    while (readRefs.size > 1000) readRefs.delete(readRefs.keys().next().value);
    return {
      records,
      issues,
      hasMore: result.hasMore,
      raw: result.records.length,
    };
  }
  const provider = createPagedProvider({
    id: "boss",
    name: "Boss直聘",
    capabilities: {
      category: "job_board",
      browserSession: true,
      body: true,
      apply: false,
    },
    listPage,
    detail: async (record, ctx) => {
      const key = identity(ctx, record.sourceRecordId);
      let reference = readRefs.get(key);
      if (!reference) {
        const query = ctx.query || ctx.queries?.[0];
        if (
          !query ||
          !Number.isSafeInteger(record.discoveryPage) ||
          record.discoveryPage < 1 ||
          record.discoveryPage > 20
        )
          throw fail("read_ref_missing");
        await listPage(
          ctx.sites?.[0] || { siteId: record.siteId },
          query,
          record.discoveryPage,
          ctx,
        );
        reference = readRefs.get(key);
        if (!reference) throw fail("read_ref_missing");
      }
      try {
        const result = await read(
          ctx,
          buildBossOperation({ kind: "boss.detail", ...reference }),
        );
        const id = result.detail.encryptJobId;
        if (id !== record.sourceRecordId)
          throw fail("boss_detail_identity_mismatch");
        return {
          ...record,
          description: result.detail.postDescription.trim(),
          detailStatus: "complete",
          bodyStatus: "complete",
          retrievedAt: result.checkedAt,
          sourceEvidence: [
            {
              kind: "authorized_platform_body",
              sourceId: "boss",
              url: record.url,
              checkedAt: result.checkedAt,
            },
          ],
        };
      } finally {
        readRefs.delete(key);
      }
    },
  });
  // The generic legacy collector turns failures into issues. A trusted probe must still surface auth/risk.
  const collect = provider.collect;
  provider.collect = async (ctx) => {
    const result = await collect(ctx);
    const blocked = result.issues.find((i) => authCodes.has(i.code));
    if (blocked) throw fail(blocked.code);
    return result;
  };
  return provider;
}
export default createBossProvider();
