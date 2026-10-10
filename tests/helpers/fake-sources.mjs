import { job } from "./fixtures.mjs";
export function fakeProvider({
  id = "synthetic",
  records = [job()],
  fail = false,
  hold = null,
  duplicate = false,
  truncated = false,
} = {}) {
  return {
    id,
    name: id,
    capabilities: { category: "job_board", jobTypes: ["campus"], detail: true },
    configSchema: { enabled: "boolean" },
    async collect(ctx) {
      if (fail) throw Error("Synthetic source unavailable");
      await ctx.onBatch?.(records);
      if (duplicate) await ctx.onBatch?.(records);
      if (hold) await hold(ctx);
      return {
        records,
        issues: [],
        coverage: [
          {
            sourceId: id,
            siteId: ctx.sites[0].siteId,
            status: "complete",
            truncated,
            queries: ["Java开发"],
            cities: ["北京"],
            pages: 1,
          },
        ],
        stats: {
          raw: records.length,
          parsed: records.length,
          accepted: records.length,
        },
      };
    },
    async fetchDetail(record) {
      return record;
    },
    async probe() {
      return { status: "ready" };
    },
  };
}
